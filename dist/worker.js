// Cloud Mail —— 构建产物，请勿直接修改。
// 源码：src/ ，构建：npm run build
// 生成时间：2026-11-24T05:56:20.918Z
/**
 * D1 访问层。
 *
 * 自动建表：ensureSchema() 在每次请求进入业务逻辑前调用一次（ isolates 内仅执行一次），
 * 使用 CREATE TABLE IF NOT EXISTS，因此空数据库开箱即用，重复部署也不会报错。
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    TEXT    NOT NULL,
    last_login_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    token_hash TEXT    NOT NULL UNIQUE,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL,
    user_agent TEXT,
    ip         TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS emails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT,
    user_id     INTEGER,
    sender      TEXT    NOT NULL DEFAULT '',
    sender_name TEXT    NOT NULL DEFAULT '',
    real_sender TEXT    NOT NULL DEFAULT '',
    receiver    TEXT    NOT NULL DEFAULT '',
    subject     TEXT    NOT NULL DEFAULT '(无主题)',
    body        TEXT    NOT NULL DEFAULT '',
    body_type   TEXT    NOT NULL DEFAULT 'text',
    preview     TEXT    NOT NULL DEFAULT '',
    attachments TEXT    NOT NULL DEFAULT '[]',
    is_read     INTEGER NOT NULL DEFAULT 0,
    is_starred  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    received_at TEXT    NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_message ON emails(message_id) WHERE message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sends (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER,
    sender   TEXT    NOT NULL,
    receiver TEXT    NOT NULL,
    subject  TEXT    NOT NULL DEFAULT '',
    body     TEXT    NOT NULL DEFAULT '',
    status   TEXT    NOT NULL DEFAULT 'sent',
    error    TEXT,
    sent_at  TEXT    NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sends_user ON sends(user_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    ip         TEXT    NOT NULL,
    ok         INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_email ON login_attempts(email, created_at)`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    name         TEXT    NOT NULL DEFAULT '',
    key_hash     TEXT    NOT NULL UNIQUE,
    prefix       TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
];

/** 每个 D1 实例只建一次表；按绑定对象缓存，多库共存（含测试）也不会互相干扰。 */
const schemaPromises = new WeakMap();

function ensureSchema(env) {
  if (!env || !env.DB) {
    return Promise.reject(new Error('缺少 D1 数据库绑定 DB，请在 wrangler.toml 或控制台绑定'));
  }
  const key = env.DB;
  let promise = schemaPromises.get(key);
  if (!promise) {
    promise = runSchema(env).catch((error) => {
      schemaPromises.delete(key); // 失败后允许下次请求重试
      throw error;
    });
    schemaPromises.set(key, promise);
  }
  return promise;
}

async function runSchema(env) {
  // 先建表，再补齐旧库缺少的列，最后建索引：
  // 旧库的 emails 表可能没有 message_id，直接建唯一索引会失败。
  const tables = SCHEMA.filter((statement) => statement.trimStart().startsWith('CREATE TABLE'));
  const rest = SCHEMA.filter((statement) => !statement.trimStart().startsWith('CREATE TABLE'));

  for (const statement of tables) {
    await env.DB.prepare(statement).run();
  }
  await backfillColumns(env);
  for (const statement of rest) {
    try {
      await env.DB.prepare(statement).run();
    } catch {
      // 旧库存在重复 message_id 等历史数据时索引可能建不起来，不影响主流程
    }
  }
}

/**
 * 旧版本（或早期手工建的表）缺少新增列时自动补齐。
 * CREATE TABLE IF NOT EXISTS 只保证表存在，不会补列，这里用 PRAGMA 逐个对比再 ALTER。
 */
async function backfillColumns(env) {
  let migrated = false;
  for (const [table, columns] of Object.entries(EXTRA_COLUMNS)) {
    let existing;
    try {
      const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      existing = new Set((result?.results || []).map((row) => row.name));
    } catch {
      continue; // 表不存在或权限不足时跳过，主流程仍可继续
    }
    if (!existing.size) continue;
    for (const [column, definition] of Object.entries(columns)) {
      if (existing.has(column)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
        migrated = true;
      } catch {
        // 并发补列或 D1 限制时忽略，后续查询已有默认值兜底
      }
    }
  }
  if (migrated) await adoptLegacyRows(env);
}

/**
 * 老库升级后，历史邮件/发件记录还没有归属账号（user_id 为空）。
 * 按「邮箱 @ 前的部分」匹配一次，让旧数据直接出现在对应账号里。
 */
/** 取「@ 前部分」并转小写的 SQL 表达式，用于按邮箱前缀匹配账号。 */
const localOf = (column) => `lower(substr(${column}, 1, instr(${column}, '@') - 1))`;

async function adoptLegacyRows(env) {
  const statements = [
    `UPDATE emails SET user_id = (
       SELECT u.id FROM users u WHERE ${localOf('u.email')} = ${localOf('emails.receiver')}
     ) WHERE user_id IS NULL AND EXISTS (
       SELECT 1 FROM users u WHERE ${localOf('u.email')} = ${localOf('emails.receiver')}
     )`,
    `UPDATE sends SET user_id = (
       SELECT u.id FROM users u WHERE ${localOf('u.email')} = ${localOf('sends.sender')}
     ) WHERE user_id IS NULL AND EXISTS (
       SELECT 1 FROM users u WHERE ${localOf('u.email')} = ${localOf('sends.sender')}
     )`,
  ];
  for (const statement of statements) {
    try {
      await env.DB.prepare(statement).run();
    } catch {
      // 老数据格式异常时忽略，不影响新邮件收发
    }
  }
}

/**
 * 新建账号后，把先前因为「找不到属主」而落在库里的邮件归给它。
 * 这样旧库升级、或先收到信后建账号，都不会丢邮件。
 */
async function adoptOrphanMail(env, userId, email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  if (!userId || !local) return;
  const statements = [
    ['UPDATE emails SET user_id = ? WHERE user_id IS NULL AND lower(substr(receiver, 1, instr(receiver, \'@\') - 1)) = ?', userId, local],
    ['UPDATE sends SET user_id = ? WHERE user_id IS NULL AND lower(substr(sender, 1, instr(sender, \'@\') - 1)) = ?', userId, local],
  ];
  for (const [sql, ...params] of statements) {
    try {
      await env.DB.prepare(sql).bind(...params).run();
    } catch {
      // 忽略：不影响账号创建本身
    }
  }
}

/** 相对初版新增的列：老库升级时按需补齐（默认值保证旧数据可读）。 */
const EXTRA_COLUMNS = {
  emails: {
    message_id: 'TEXT',
    sender_name: "TEXT NOT NULL DEFAULT ''",
    body_type: "TEXT NOT NULL DEFAULT 'text'",
    preview: "TEXT NOT NULL DEFAULT ''",
    attachments: "TEXT NOT NULL DEFAULT '[]'",
    is_read: 'INTEGER NOT NULL DEFAULT 0',
    is_starred: 'INTEGER NOT NULL DEFAULT 0',
    deleted_at: 'TEXT',
    size: 'INTEGER NOT NULL DEFAULT 0',
    user_id: 'INTEGER',
  },
  sends: {
    user_id: 'INTEGER',
    status: "TEXT NOT NULL DEFAULT 'sent'",
    error: 'TEXT',
  },
  users: {
    name: "TEXT NOT NULL DEFAULT ''",
    role: "TEXT NOT NULL DEFAULT 'user'",
    status: "TEXT NOT NULL DEFAULT 'active'",
    last_login_at: 'TEXT',
  },
};

function cleanParams(params) {
  return params.map((value) => (value === undefined ? null : value));
}

async function dbAll(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...cleanParams(params)).all();
  return result?.results || [];
}

async function dbFirst(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...cleanParams(params)).first();
  return row || null;
}

async function dbRun(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...cleanParams(params)).run();
  const meta = result?.meta || {};
  return { changes: Number(meta.changes || 0), lastRowId: Number(meta.last_row_id || 0) };
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
  };
}

async function findUserByEmail(env, email) {
  return dbFirst(env, 'SELECT * FROM users WHERE email = ?', email);
}

/** 第一个可用管理员：无主邮件的兜底归属账号。 */
async function firstAdminUser(env) {
  return dbFirst(
    env,
    `SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`,
  );
}

/**
 * 还没有管理员时（初始化向导没走完、账号被临时停用等）的退路：
 * 取最早的一个可用账号，宁可先让某个普通账号收着，也不让邮件进黑洞。
 */
async function orphanFallbackUser(env) {
  return dbFirst(
    env,
    `SELECT id, email FROM users WHERE status = 'active' ORDER BY id LIMIT 1`,
  );
}

/** 无主邮件（没有归属账号）的封数。 */
async function countOrphanMail(env) {
  const row = await dbFirst(env, 'SELECT COUNT(*) AS total FROM emails WHERE user_id IS NULL');
  return Number(row?.total || 0);
}

/**
 * 把所有无主邮件（user_id 为空）一次性归到指定账号。
 * 收信时找不到账号、旧库升级留下的孤儿数据都靠这个兜底，避免邮件进「黑洞」。
 * 返回实际迁移的封数（没有孤儿数据时为 0，且不写库）。
 */
async function adoptAllOrphanMail(env, userId) {
  const target = Number(userId || 0);
  if (!target) return 0;
  try {
    const row = await dbFirst(env, 'SELECT COUNT(*) AS total FROM emails WHERE user_id IS NULL');
    const total = Number(row?.total || 0);
    if (!total) return 0;
    const result = await dbRun(env, 'UPDATE emails SET user_id = ? WHERE user_id IS NULL', target);
    return result.changes || total;
  } catch {
    return 0;
  }
}

async function countUsers(env) {
  const row = await dbFirst(env, 'SELECT COUNT(*) AS total FROM users');
  return Number(row?.total || 0);
}

/**
 * 通用工具函数：不依赖 Cloudflare 专有 API，可在 Node 中直接测试。
 */

function nowIso() {
  return new Date().toISOString();
}

/** 安全转字符串并截断长度（按字符计）。 */
function str(value, max = 0) {
  if (value === null || value === undefined) return '';
  let out = typeof value === 'string' ? value : String(value);
  if (max > 0 && out.length > max) out = out.slice(0, max);
  return out;
}

/** 按 UTF-8 字节数截断，避免超过 D1 单行 1MB 限制。 */
function trimToBytes(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const cut = bytes.slice(0, Math.max(0, maxBytes));
  return new TextDecoder('utf-8', { fatal: false }).decode(cut) + '\n\n…（内容过长已截断）';
}

function normalizeEmail(value) {
  return str(value, 254).trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]{2,}$/.test(String(value || ''));
}

function localPart(email) {
  const text = String(email || '');
  const at = text.indexOf('@');
  return at > 0 ? text.slice(0, at) : text;
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return str(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function bytesToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}

function randomHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** 常量时间字符串比较，用于校验密码哈希与 token。 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 从 "Name <a@b.com>" 中拆出显示名与地址。 */
function splitAddress(value) {
  const raw = str(value, 500).trim();
  const match = raw.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (match) {
    return { name: cleanDisplayName(match[1]), address: cleanDisplayName(match[2]).toLowerCase() };
  }
  return { name: '', address: cleanDisplayName(raw).toLowerCase() };
}

/**
 * 显示名清洗：去掉包裹用的引号（含全角）、反转义 \" 这类写法。
 * 必须先去空白再剥引号 —— `"星夜_Lhy" <a@b.com>` 里 .*? 会把空格一起吞进来，
 * 先剥引号就会漏掉结尾那个，界面上就出现「星夜_Lhy"」这种残引号。
 */
function cleanDisplayName(value) {
  let out = str(value, 500).replace(/\\(["'\\])/g, '$1').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function initialsOf(name, email) {
  const source = str(name).trim() || localPart(email) || '?';
  const cleaned = source.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) return '?';
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return Array.from(cleaned).slice(0, 2).join('').toUpperCase();
}

/** 列表预览：压缩空白、去掉过长的引用链。 */
function previewOf(text, max = 150) {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clientIp(request) {
  const raw = str(request?.headers?.get('cf-connecting-ip') || request?.headers?.get('x-forwarded-for') || 'local', 64);
  return raw.split(',')[0].trim() || 'local';
}

function dayString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * 账号与会话：PBKDF2 密码哈希 + D1 会话表（令牌仅存哈希）。
 *
 * 注意 Workers 运行时的 WebCrypto 对 PBKDF2 有硬上限：
 *   超过 100000 轮会抛 NotSupportedError:
 *   "Pbkdf2 failed: iteration counts above 100000 are not supported (requested 120000)."
 * 所以默认轮数取上限值，且允许用 PBKDF2_ITERATIONS 往下调（越高越慢，别超过 10 万）。
 */



const PBKDF2_MAX_ITERATIONS = 100000;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_BITS = 256;
const MIN_ITERATIONS = 10000;

/** 实际使用的迭代次数：可配置，但一定落在运行时可接受的区间里。 */
function pbkdf2Iterations(env) {
  const configured = Number(env?.PBKDF2_ITERATIONS);
  if (!Number.isFinite(configured) || configured < MIN_ITERATIONS) return PBKDF2_ITERATIONS;
  return Math.min(Math.floor(configured), PBKDF2_MAX_ITERATIONS);
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      iterations,
    },
    key,
    PBKDF2_KEY_BITS,
  );
}

/** 返回 `pbkdf2$迭代次数$盐$哈希`，单列存储，便于日后升级算法。 */
async function hashPassword(password, env) {
  const iterations = pbkdf2Iterations(env);
  const salt = randomHex(16);
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt}$${bytesToHex(bits)}`;
}

/** 取出哈希里记录的迭代次数，用于判断是否需要顺手升级。 */
function passwordIterations(stored) {
  const parts = String(stored || '').split('$');
  const iterations = Number(parts[1]);
  return parts[0] === 'pbkdf2' && Number.isFinite(iterations) ? iterations : 0;
}

/**
 * 校验密码。
 * 返回 'ok' | 'mismatch'，或者 { unsupported: 轮数 } —— 后者表示这条哈希的
 * 迭代次数高于当前运行时的上限（例如旧版本用 12 万轮写入的），需要重置密码。
 */
async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return 'mismatch';
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return 'mismatch';
  try {
    const bits = await deriveBits(password, parts[2], iterations);
    return safeEqual(bytesToHex(bits), parts[3]) ? 'ok' : 'mismatch';
  } catch {
    // 运行时拒绝该迭代次数（Node 测试环境允许，Workers 不允许）→ 明确告知需重置
    return iterations > PBKDF2_MAX_ITERATIONS ? { unsupported: iterations } : 'mismatch';
  }
}

async function verifyPassword(password, stored) {
  return (await checkPassword(password, stored)) === 'ok';
}

function sessionTtlMs(env) {
  const days = Number(env?.SESSION_TTL_DAYS);
  const safeDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7;
  return safeDays * 24 * 60 * 60 * 1000;
}

async function createSession(env, user, request) {
  const token = randomHex(32);
  const ttl = sessionTtlMs(env);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  await dbRun(
    env,
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
    user.id,
    await sha256Hex(token),
    createdAt,
    expiresAt,
    str(request.headers.get('user-agent'), 255),
    clientIp(request),
  );
  // 顺手清理过期会话，避免表无限增长
  await dbRun(env, 'DELETE FROM sessions WHERE expires_at < ?', createdAt);
  return { token, expiresAt };
}

async function authenticate(env, token) {
  if (!token || token.length > 200) return null;
  const tokenHash = await sha256Hex(token);
  const row = await dbFirst(
    env,
    `SELECT s.id AS session_id, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await dbRun(env, 'DELETE FROM sessions WHERE id = ?', row.session_id);
    return null;
  }
  if (row.status !== 'active') return null;
  return { sessionId: Number(row.session_id), user: publicUser(row) };
}

async function destroySession(env, token) {
  if (!token) return;
  await dbRun(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
}

async function destroyUserSessions(env, userId, exceptTokenHash = '') {
  if (exceptTokenHash) {
    await dbRun(env, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, exceptTokenHash);
    return;
  }
  await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', userId);
}

async function markLogin(env, userId) {
  await dbRun(env, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
}

/** 登录失败次数过多时返回 true（同一邮箱 + IP，15 分钟内 8 次）。 */
async function isLoginThrottled(env, email, ip) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = await dbFirst(
    env,
    'SELECT COUNT(*) AS total FROM login_attempts WHERE email = ? AND ip = ? AND ok = 0 AND created_at > ?',
    email,
    ip,
    since,
  );
  return Number(row?.total || 0) >= 8;
}

async function recordLoginAttempt(env, email, ip, success) {
  await dbRun(
    env,
    'INSERT INTO login_attempts (email, ip, ok, created_at) VALUES (?, ?, ?, ?)',
    email,
    ip,
    success ? 1 : 0,
    nowIso(),
  );
  if (Math.random() < 0.1) {
    await dbRun(env, 'DELETE FROM login_attempts WHERE created_at < ?', new Date(Date.now() - 7 * 86400000).toISOString());
  }
}

/**
 * 邮件接口用的 API 密钥。
 *
 * 令牌形如 `cm_<48 位十六进制>`，库里只存 SHA-256，创建时返回一次明文。
 * 用途：让脚本 / 第三方系统通过 HTTP 直接收发邮件，而不必模拟网页登录。
 */



const API_KEY_PREFIX = 'cm_';
const MAX_KEYS_PER_USER = 20;

function maskKey(key) {
  const body = key.slice(API_KEY_PREFIX.length);
  return `${API_KEY_PREFIX}${body.slice(0, 6)}…${body.slice(-4)}`;
}

async function listApiKeys(env, userId) {
  // 旧版本用 revoked_at 标记「已撤销」；现在撤销即删除，这里顺手清掉历史残留
  await dbRun(env, 'DELETE FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL', userId);
  const result = await env.DB.prepare(
    'SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY id DESC',
  )
    .bind(userId)
    .all();
  return (result?.results || []).map((row) => ({
    id: Number(row.id),
    name: row.name,
    masked: row.prefix || '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
  }));
}

async function createApiKey(env, userId, name) {
  const total = await dbFirst(env, 'SELECT COUNT(*) AS total FROM api_keys WHERE user_id = ?', userId);
  if (Number(total?.total || 0) >= MAX_KEYS_PER_USER) {
    const error = new Error(`每个账号最多保留 ${MAX_KEYS_PER_USER} 个有效密钥`);
    error.status = 400;
    error.code = 'too_many_keys';
    throw error;
  }
  const key = API_KEY_PREFIX + randomHex(24);
  const result = await dbRun(
    env,
    'INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
    userId,
    str(name, 60).trim() || '默认密钥',
    await sha256Hex(key),
    maskKey(key),
    nowIso(),
  );
  return { id: Number(result.lastRowId || 0), key, masked: maskKey(key) };
}

/**
 * 撤销 = 彻底删除：密钥记录直接从库里移除，不留「已撤销」的痕迹。
 * 调用方拿到的明文一旦丢失就只能重新生成，所以撤销是不可撤销的操作。
 */
async function revokeApiKey(env, userId, keyId) {
  const result = await dbRun(env, 'DELETE FROM api_keys WHERE id = ? AND user_id = ?', keyId, userId);
  return result.changes > 0;
}

/** 校验密钥；成功返回 { user }，并顺手记录最近使用时间。 */
async function authenticateApiKey(env, key) {
  if (!key || !key.startsWith(API_KEY_PREFIX) || key.length > 120) return null;
  const row = await dbFirst(
    env,
    `SELECT k.id AS key_id, k.revoked_at, k.last_used_at, u.*
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ?`,
    await sha256Hex(key),
  );
  if (!row || row.revoked_at) return null;
  if (row.status !== 'active') return null;

  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!lastUsed || Date.now() - lastUsed > 5 * 60 * 1000) {
    await dbRun(env, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.key_id);
  }
  return { user: publicUser(row), apiKeyId: Number(row.key_id) };
}

/**
 * HTTP 层：统一的响应格式、错误处理、鉴权辅助。
 */




class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin',
};

function securityHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function json(data, init = {}) {
  const headers = securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(init.headers || {}),
  });
  return new Response(JSON.stringify(data), { ...init, headers });
}

function ok(data = {}) {
  return json({ ok: true, ...data });
}

function fail(status, code, message, extra) {
  return json({ ok: false, error: { code, message } }, { status, ...(extra ? { extra } : {}) });
}

async function readJson(request, { limit = 256 * 1024 } = {}) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length && length > limit) {
    throw new HttpError(413, 'payload_too_large', '请求内容过大');
  }
  const text = await request.text();
  if (!text) return {};
  if (text.length > limit) throw new HttpError(413, 'payload_too_large', '请求内容过大');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_json', '请求格式错误');
  }
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const alt = request.headers.get('x-auth-token');
  return alt ? alt.trim() : '';
}

async function requireUser(request, env) {
  // 1) HTTP 接口密钥：X-API-Key，或直接放在 Authorization: Bearer cm_xxx
  const headerKey = (request.headers.get('x-api-key') || '').trim();
  const token = bearerToken(request);
  const apiKey = headerKey || (token.startsWith(API_KEY_PREFIX) ? token : '');
  if (apiKey) {
    const session = await authenticateApiKey(env, apiKey);
    if (!session) throw new HttpError(401, 'invalid_api_key', 'API 密钥无效或已撤销');
    return { ...session, via: 'api_key' };
  }

  // 2) 网页登录会话
  if (!token) throw new HttpError(401, 'unauthorized', '请先登录');
  const session = await authenticate(env, token);
  if (!session) throw new HttpError(401, 'session_expired', '登录状态已失效，请重新登录');
  return { ...session, via: 'session' };
}

async function requireAdmin(request, env) {
  const session = await requireUser(request, env);
  if (session.user.role !== 'admin') throw new HttpError(403, 'forbidden', '需要管理员权限');
  return session;
}

function methodNotAllowed(allow) {
  return json(
    { ok: false, error: { code: 'method_not_allowed', message: '不支持的请求方法' } },
    { status: 405, headers: { allow } },
  );
}

/**
 * 邮箱域名的自动识别。
 *
 * 为什么需要它：Worker 部署完只知道「请求从哪来」，并不知道自己绑定的收发域名。
 * 因此按以下顺序推断，越靠前越可信：
 *   1. 环境变量 MAIL_DOMAIN —— 显式配置，永远优先；
 *   2. 数据库里 settings.mail_domain —— 从第一封收到的邮件（或首次初始化）里学到，之后一直复用；
 *   3. 访问域名 —— 例如 mail.example.com / email.example.com 去掉前缀；*.workers.dev 不推断。
 *
 * 拿到域名之后，界面里所有「邮箱地址」输入框都只需要填前缀（admin、chenzhou…），
 * 域名自动补齐；初始化向导的管理员默认就是 admin@<域名>。
 */




const SETTING_KEY = 'mail_domain';
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SUBDOMAIN_PREFIXES = ['mail', 'email', 'smtp', 'inbox', 'mx'];

/** 规范化域名：去空白、去前导 @、小写、校验形状；不合法返回 ''。 */
function normalizeDomain(value) {
  const text = str(value, 200)
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[.\s]+$/, '');
  if (!text || text.length > 190) return '';
  return DOMAIN.test(text) ? text : '';
}

/** 取出地址里的域名部分。 */
function domainOf(address) {
  const email = normalizeEmail(address);
  const at = email.lastIndexOf('@');
  return at > 0 ? normalizeDomain(email.slice(at + 1)) : '';
}

/** 取出地址里的本地部分（不带 @）。 */
function localPartOf(address) {
  const email = normalizeEmail(address);
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * 从访问域名猜测收件域名：
 *   mail.example.com → example.com；example.com → example.com；xxx.workers.dev → ''（不猜）。
 */
function domainFromHost(host) {
  const text = str(host, 200).trim().toLowerCase().split(':')[0];
  if (!text || !DOMAIN.test(text)) return '';
  if (text.endsWith('.workers.dev') || text.endsWith('.pages.dev')) return '';
  const labels = text.split('.');
  if (labels.length >= 3 && SUBDOMAIN_PREFIXES.includes(labels[0])) {
    return normalizeDomain(labels.slice(1).join('.'));
  }
  return labels.length === 2 ? text : '';
}

/** 读库里学到的域名。 */
async function storedDomain(env) {
  const row = await dbFirst(env, 'SELECT value FROM settings WHERE key = ?', SETTING_KEY);
  return normalizeDomain(row?.value);
}

/** 学到一个域名（先到先得，已存在则不覆盖）。 */
async function rememberDomain(env, value) {
  const domain = normalizeDomain(value);
  if (!domain) return '';
  const current = await storedDomain(env);
  if (current) return current;
  await dbRun(
    env,
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    SETTING_KEY,
    domain,
    nowIso(),
  );
  return domain;
}

/** 当前请求的访问域名：优先 Host 头，本地/测试环境回退到 URL。 */
function requestHost(request) {
  const header = request?.headers?.get?.('host');
  if (header) return header;
  try {
    return new URL(String(request?.url || '')).hostname;
  } catch {
    return '';
  }
}

/** 综合三个来源得出当前收件域名；拿不到返回 ''。 */
async function resolveDomain(env, request) {
  const configured = normalizeDomain(env?.MAIL_DOMAIN);
  if (configured) return configured;
  const learned = await storedDomain(env);
  if (learned) return learned;
  return domainFromHost(requestHost(request));
}

/** 域名是从哪来的，用于界面提示。 */
async function domainSource(env) {
  if (normalizeDomain(env?.MAIL_DOMAIN)) return 'env';
  if (await storedDomain(env)) return 'mail';
  return 'unknown';
}

/**
 * 把「只填前缀」的输入补全成完整地址。
 * 返回 { email, domain, local }：域名未知且输入里也没有 @ 时，email 是半成品，由调用方决定怎么报错。
 */
async function expandAddress(env, raw, { request, local = '' } = {}) {
  const input = normalizeEmail(raw);
  if (input.includes('@')) {
    return { email: input, domain: domainOf(input), local: localPartOf(input) };
  }
  const domain = await resolveDomain(env, request);
  const prefix = (input || normalizeEmail(local)).trim();
  if (!prefix) return { email: '', domain, local: '' };
  return { email: domain ? `${prefix}@${domain}` : prefix, domain, local: prefix };
}

/** 同 expandAddress，但失败直接抛 400，消息按「域名能不能自动识别」分开提示。 */
async function requireAddress(env, raw, { request, local = '', field = '邮箱地址' } = {}) {
  const expanded = await expandAddress(env, raw, { request, local });
  if (!expanded.email) throw new HttpError(400, 'invalid_email', `请填写${field}`);
  if (!expanded.email.includes('@')) {
    throw new HttpError(
      400,
      'need_domain',
      '暂时无法自动识别收件域名：请填写完整邮箱地址，或在 wrangler.toml 里设置 MAIL_DOMAIN',
    );
  }
  if (!LOCAL_PART.test(expanded.local) || expanded.local.length > 64 || !expanded.domain) {
    throw new HttpError(400, 'invalid_email', `${field}格式不正确`);
  }
  return expanded;
}

/** 默认管理员地址：admin@<域名>。 */
async function defaultAdminAddress(env, request) {
  const domain = await resolveDomain(env, request);
  return domain ? `admin@${domain}` : '';
}

/**
 * 极简 MIME 解析器：
 * - RFC 2047 编码字（=?utf-8?B?...?=）解码，含多段拼接
 * - multipart 递归拆分（alternative / mixed / related）
 * - base64 / quoted-printable 正文解码
 * - 附件仅记录元信息（名称、类型、大小），正文不入库
 */


const MAX_DEPTH = 6;

function splitHeaderBody(input) {
  const text = String(input || '');
  const crlf = text.indexOf('\r\n\r\n');
  if (crlf >= 0) return { headerText: text.slice(0, crlf), bodyText: text.slice(crlf + 4) };
  const lf = text.indexOf('\n\n');
  if (lf >= 0) return { headerText: text.slice(0, lf), bodyText: text.slice(lf + 2) };
  return { headerText: text, bodyText: '' };
}

function parseHeaders(block) {
  const headers = Object.create(null);
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  let current = '';
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ' ' + line.trim();
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) continue;
    current = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[current] = headers[current] ? `${headers[current]}, ${value}` : value;
  }
  return headers;
}

function parseParams(value) {
  const params = Object.create(null);
  const pattern = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let match;
  while ((match = pattern.exec(String(value || ''))) !== null) {
    const key = match[1].toLowerCase();
    let raw = match[2].trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    params[key] = raw;
  }
  return params;
}

function parseContentType(value) {
  const text = String(value || 'text/plain');
  const semi = text.indexOf(';');
  const type = (semi >= 0 ? text.slice(0, semi) : text).trim().toLowerCase() || 'text/plain';
  const params = semi >= 0 ? parseParams(text.slice(semi)) : Object.create(null);
  return { type, params };
}

function decodeBytes(bytes, charset) {
  const label = String(charset || 'utf-8')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
  const candidates = [label, 'utf-8', 'gb18030'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      // 不支持的 charset 标签，继续尝试下一个
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function base64ToBytes(text) {
  const cleaned = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeQuotedPrintable(text) {
  const source = String(text || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = source.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else {
        // 非 ASCII 字符（邮件头里可能出现）按 UTF-8 编码
        for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
      }
    }
  }
  return new Uint8Array(bytes);
}

function decodeTransfer(body, encoding, charset) {
  const mode = String(encoding || '7bit').trim().toLowerCase();
  if (mode === 'base64') return decodeBytes(base64ToBytes(body), charset);
  if (mode === 'quoted-printable') return decodeBytes(decodeQuotedPrintable(body), charset);
  return decodeBytes(new TextEncoder().encode(body), charset);
}

function decodeEncodedWord(word) {
  const match = String(word).match(/^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/);
  if (!match) return null;
  const charset = match[1].split('*')[0];
  const encoding = match[2].toUpperCase();
  const payload = match[3];
  if (encoding === 'B') {
    return decodeBytes(base64ToBytes(payload), charset);
  }
  return decodeBytes(decodeQuotedPrintable(payload.replace(/_/g, ' ')), charset);
}

/** 解码邮件头中的 RFC 2047 编码字。 */
function decodeWords(value) {
  let text = str(value, 20000);
  if (!text.includes('=?')) return text;
  // 相邻编码字之间的空白应被忽略
  text = text.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1');
  return text.replace(/=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=/g, (word) => decodeEncodedWord(word) ?? word);
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const chunks = String(body).split(marker);
  const parts = [];
  for (let index = 1; index < chunks.length; index += 1) {
    let chunk = chunks[index];
    if (chunk.startsWith('--')) break; // 结束标记
    chunk = chunk.replace(/^\r?\n/, '');
    if (chunk.trim()) parts.push(chunk);
  }
  return parts;
}

function attachmentName(headers) {
  const disposition = parseParams(headers['content-disposition'] || '');
  const continuation = Object.keys(disposition).find((key) => key.startsWith('filename*'));
  if (continuation) {
    const raw = disposition[continuation];
    const match = raw.match(/^([\w-]+)'[^']*'(.+)$/);
    if (match) {
      try {
        return decodeURIComponent(match[2]);
      } catch {
        return match[2];
      }
    }
    return raw;
  }
  return disposition.filename || disposition.name || '';
}

function walkPart(partText, depth, state) {
  if (depth > MAX_DEPTH) return;
  const { headerText, bodyText } = splitHeaderBody(partText);
  const headers = parseHeaders(headerText);
  const { type, params } = parseContentType(headers['content-type']);
  const charset = params.charset || 'utf-8';
  const encoding = headers['content-transfer-encoding'] || '7bit';

  if (type.startsWith('multipart/') && params.boundary) {
    for (const child of splitMultipart(bodyText, params.boundary)) {
      walkPart(child, depth + 1, state);
    }
    return;
  }

  if (type === 'message/rfc822') {
    walkPart(bodyText, depth + 1, state);
    return;
  }

  const disposition = String(headers['content-disposition'] || '').toLowerCase();
  const isAttachment = disposition.startsWith('attachment') || Boolean(params.name);

  if (!isAttachment && type === 'text/html') {
    if (!state.html) state.html = decodeTransfer(bodyText, encoding, charset);
    return;
  }
  if (!isAttachment && type === 'text/plain') {
    if (!state.text) state.text = decodeTransfer(bodyText, encoding, charset);
    return;
  }

  const filename = attachmentName(headers) || params.name || '';
  if (filename) {
    state.attachments.push({
      filename: str(filename, 200),
      type: type || 'application/octet-stream',
      size: bodyText.length,
    });
  }
}

const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/**
 * 判断一段正文是不是 HTML。
 * 有些发信方只发 HTML（甚至不带 Content-Type，按 RFC 会退回 text/plain），
 * 旧版本还会把整篇 HTML 当纯文本存下来 —— 都靠这个函数兜住，避免显示成一堆源码。
 */
function looksLikeHtml(value) {
  const source = str(value, 400000);
  const head = source.trimStart().slice(0, 200).toLowerCase();
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]|^<body[\s>]/.test(head)) return true;
  if (/<\/html>|<\/body>/i.test(source)) return true;
  const opens = (source.match(/<(table|tr|td|div|p|span|a|img|br|h[1-6])\b[^>]*>/gi) || []).length;
  const closes = (source.match(/<\/(table|tr|td|div|p|span|a|h[1-6])>/gi) || []).length;
  return opens >= 8 && closes >= 3;
}

function htmlToText(html) {
  return str(html, 400000)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z#0-9]+);/g, (full, name) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      if (key.startsWith('#x')) {
        const code = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      if (key.startsWith('#')) {
        const code = Number.parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      return full;
    })
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析原始邮件。
 * @returns {{subject: string, from: string, text: string, html: string, attachments: Array, preview: string}}
 */
function parseMail(raw) {
  const source = String(raw || '');
  const { headerText } = splitHeaderBody(source);
  const headers = parseHeaders(headerText);
  const state = { text: '', html: '', attachments: [] };
  walkPart(source, 0, state);

  const subject = decodeWords(headers.subject || '').replace(/\s+/g, ' ').trim() || '(无主题)';
  const from = decodeWords(headers.from || '').trim();
  const text = state.text.replace(/\r\n/g, '\n').trim();
  const html = state.html.trim();
  const previewSource = text || htmlToText(html);

  return {
    subject: str(subject, 500),
    from,
    messageId: str(headers['message-id'], 400).trim(),
    text,
    html,
    attachments: state.attachments,
    preview: previewOf(previewSource, 180),
    size: source.length,
  };
}

/**
 * 邮件接口：列表、详情、标记、删除、发送。
 */






const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;
const MAX_BODY_BYTES = 900 * 1024;

/**
 * 全站保留上限：整库最多留这么多封（收件 + 发件各自按这个上限算）。
 * 默认 500 封；配 MAIL_RETENTION=0 可以关掉清理（等于不限）。
 */
function retentionLimit(env) {
  const raw = env?.MAIL_RETENTION;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 500;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 500;
  if (value === 0) return 0;
  return Math.min(Math.max(Math.floor(value), 20), 5000);
}

/** 按全站上限砍掉最旧的邮件：超出部分不分账号，一律删除。 */
async function trimStore(env) {
  const limit = retentionLimit(env);
  if (!limit) return;
  await dbRun(
    env,
    'DELETE FROM emails WHERE id NOT IN (SELECT id FROM emails ORDER BY id DESC LIMIT ?)',
    limit,
  );
  await dbRun(
    env,
    'DELETE FROM sends WHERE id NOT IN (SELECT id FROM sends ORDER BY id DESC LIMIT ?)',
    limit,
  );
}

/** 垃圾箱保留天数，默认 30 天（可用 TRASH_RETENTION_DAYS 覆盖）。 */
function trashTtlDays(env) {
  const value = Number(env?.TRASH_RETENTION_DAYS);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(Math.max(Math.floor(value), 1), 365);
}

/** 清掉垃圾箱里超过保留期的邮件，返回删除条数。 */
async function purgeExpiredTrash(env, userId) {
  const cutoff = new Date(Date.now() - trashTtlDays(env) * 86400000).toISOString();
  const result = await dbRun(
    env,
    'DELETE FROM emails WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?',
    userId,
    cutoff,
  );
  return result.changes;
}

function toListItem(row) {
  return {
    id: Number(row.id),
    from: row.sender,
    fromName: cleanDisplayName(row.sender_name || ''),
    to: row.receiver,
    subject: row.subject,
    preview: row.preview,
    receivedAt: row.received_at,
    isRead: Number(row.is_read) === 1,
    isStarred: Number(row.is_starred) === 1,
    hasAttachments: str(row.attachments) !== '' && str(row.attachments) !== '[]',
    deleted: Boolean(row.deleted_at),
    deletedAt: row.deleted_at || null,
  };
}

function toSentItem(row) {
  return {
    id: Number(row.id),
    to: row.receiver,
    subject: row.subject,
    preview: previewOf(row.body, 150),
    sentAt: row.sent_at,
    status: row.status || 'sent',
    error: row.error || '',
  };
}

/** GET /api/mails?box=inbox|starred|trash&page=1&pageSize=25&q=&unread=1 */
async function handleMailList(request, env) {
  const { user } = await requireUser(request, env);
  await purgeExpiredTrash(env, user.id);
  const url = new URL(request.url);
  const box = str(url.searchParams.get('box') || 'inbox', 20);
  const page = intParam(url.searchParams.get('page'), 1, 1, 100000);
  const pageSize = intParam(url.searchParams.get('pageSize'), PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX);
  const query = str(url.searchParams.get('q'), 120).trim();
  const unreadOnly = url.searchParams.get('unread') === '1';
  const offset = (page - 1) * pageSize;

  if (box === 'sent') {
    const where = ['user_id = ?'];
    const params = [user.id];
    if (query) {
      where.push('(subject LIKE ? OR receiver LIKE ? OR body LIKE ?)');
      params.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }
    const filter = where.join(' AND ');
    const totalRow = await dbFirst(env, `SELECT COUNT(*) AS total FROM sends WHERE ${filter}`, ...params);
    const rows = await dbAll(
      env,
      `SELECT * FROM sends WHERE ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      offset,
    );
    return ok({
      box,
      page,
      pageSize,
      total: Number(totalRow?.total || 0),
      items: rows.map(toSentItem),
    });
  }

  const where = ['user_id = ?'];
  const params = [user.id];
  if (box === 'trash') {
    where.push('deleted_at IS NOT NULL');
  } else {
    where.push('deleted_at IS NULL');
  }
  if (box === 'starred') where.push('is_starred = 1');
  if (unreadOnly) where.push('is_read = 0');
  if (query) {
    where.push('(subject LIKE ? OR sender LIKE ? OR preview LIKE ?)');
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  const filter = where.join(' AND ');
  const totalRow = await dbFirst(env, `SELECT COUNT(*) AS total FROM emails WHERE ${filter}`, ...params);
  const rows = await dbAll(
    env,
    `SELECT * FROM emails WHERE ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    offset,
  );
  return ok({
    box,
    page,
    pageSize,
    total: Number(totalRow?.total || 0),
    items: rows.map(toListItem),
    ...(box === 'trash' ? { trashTtlDays: trashTtlDays(env) } : {}),
  });
}

async function loadOwnedMail(env, user, id) {
  const row = await dbFirst(env, 'SELECT * FROM emails WHERE id = ? AND user_id = ?', id, user.id);
  if (!row) throw new HttpError(404, 'not_found', '邮件不存在');
  return row;
}

/** GET /api/mails/:id */
async function handleMailGet(request, env, id) {
  const { user } = await requireUser(request, env);
  const row = await loadOwnedMail(env, user, id);
  let attachments = [];
  try {
    attachments = JSON.parse(row.attachments || '[]');
  } catch {
    attachments = [];
  }
  // 旧版本/旧 Worker 写进来的 HTML 正文可能被记成 text，这里就地纠正，不改库
  const bodyType = row.body_type === 'html' ? 'html' : looksLikeHtml(row.body) ? 'html' : 'text';
  return ok({
    mail: {
      id: Number(row.id),
      from: row.sender,
      fromName: cleanDisplayName(row.sender_name || ''),
      realFrom: row.real_sender || '',
      to: row.receiver,
      subject: row.subject,
      body: row.body,
      bodyType,
      attachments: Array.isArray(attachments) ? attachments : [],
      receivedAt: row.received_at,
      isRead: Number(row.is_read) === 1,
      isStarred: Number(row.is_starred) === 1,
      deleted: Boolean(row.deleted_at),
      size: Number(row.size || 0),
    },
  });
}

/** PATCH /api/mails/:id  body: { isRead?: boolean, isStarred?: boolean } */
async function handleMailPatch(request, env, id) {
  const { user } = await requireUser(request, env);
  const row = await loadOwnedMail(env, user, id);
  const body = await readJson(request);
  const nextRead = typeof body.isRead === 'boolean' ? (body.isRead ? 1 : 0) : Number(row.is_read);
  const nextStar = typeof body.isStarred === 'boolean' ? (body.isStarred ? 1 : 0) : Number(row.is_starred);
  // 从垃圾箱恢复
  const nextDeleted = body.restore === true ? null : row.deleted_at;
  await dbRun(
    env,
    'UPDATE emails SET is_read = ?, is_starred = ?, deleted_at = ? WHERE id = ? AND user_id = ?',
    nextRead,
    nextStar,
    nextDeleted,
    id,
    user.id,
  );
  return ok({
    mail: { id: Number(id), isRead: nextRead === 1, isStarred: nextStar === 1, deleted: Boolean(nextDeleted) },
  });
}

/** DELETE /api/mails/:id?permanent=1 —— 默认移入垃圾箱。 */
async function handleMailDelete(request, env, id) {
  const { user } = await requireUser(request, env);
  const row = await loadOwnedMail(env, user, id);
  const url = new URL(request.url);
  const permanent = url.searchParams.get('permanent') === '1' || Boolean(row.deleted_at);
  if (permanent) {
    await dbRun(env, 'DELETE FROM emails WHERE id = ? AND user_id = ?', id, user.id);
  } else {
    await dbRun(env, 'UPDATE emails SET deleted_at = ? WHERE id = ? AND user_id = ?', nowIso(), id, user.id);
  }
  return ok({ deleted: true, permanent });
}

/** POST /api/mails/trash/empty */
async function handleEmptyTrash(request, env) {
  const { user } = await requireUser(request, env);
  const result = await dbRun(env, 'DELETE FROM emails WHERE user_id = ? AND deleted_at IS NOT NULL', user.id);
  return ok({ removed: result.changes });
}

/** GET /api/sent/:id */
async function handleSentGet(request, env, id) {
  const { user } = await requireUser(request, env);
  const row = await dbFirst(env, 'SELECT * FROM sends WHERE id = ? AND user_id = ?', id, user.id);
  if (!row) throw new HttpError(404, 'not_found', '邮件不存在');
  return ok({
    mail: {
      id: Number(row.id),
      from: row.sender,
      to: row.receiver,
      subject: row.subject,
      body: row.body,
      sentAt: row.sent_at,
      status: row.status || 'sent',
      error: row.error || '',
      isStarred: false,
      isRead: true,
    },
  });
}

/** DELETE /api/sent/:id —— 删除一条已发送记录（发出去的邮件收不回来，这里只删本地记录） */
async function handleSentDelete(request, env, id) {
  const { user } = await requireUser(request, env);
  const row = await dbFirst(env, 'SELECT id FROM sends WHERE id = ? AND user_id = ?', id, user.id);
  if (!row) throw new HttpError(404, 'not_found', '邮件不存在');
  const result = await dbRun(env, 'DELETE FROM sends WHERE id = ? AND user_id = ?', id, user.id);
  return ok({ deleted: result.changes > 0, id: Number(id) });
}

function friendlySendError(message) {
  const text = String(message || '');
  if (/not a verified address|verified address/i.test(text)) {
    return {
      code: 'recipient_unverified',
      message: '收件地址未通过 Cloudflare 验证。免费计划只能发往已验证地址，可在 Email Routing 中验证收件人或升级 Workers 付费计划。',
    };
  }
  if (/email sending is not|not enabled|unauthorized/i.test(text)) {
    return { code: 'sending_unavailable', message: '发信服务不可用，请检查 EMAIL 绑定与 Email Routing 配置。' };
  }
  if (/daily|quota|limit/i.test(text)) {
    return { code: 'quota_exceeded', message: '已达到发信额度限制，请稍后再试。' };
  }
  return { code: 'send_failed', message: `发送失败：${text.slice(0, 200)}` };
}

/** POST /api/mails/send */
async function handleSend(request, env) {
  const { user } = await requireUser(request, env);
  const body = await readJson(request, { limit: 1024 * 1024 });
  const to = normalizeEmail(body.to);
  const subject = str(body.subject, 300).trim() || '(无主题)';
  const text = trimToBytes(str(body.body, 500000), MAX_BODY_BYTES);
  const requestedRaw = str(body.from, 320).trim();
  // 只填前缀（如 billing）时自动补上当前收件域名，与界面上的输入框行为一致
  const requestedFrom = requestedRaw && !requestedRaw.includes('@')
    ? (await expandAddress(env, requestedRaw, { request })).email
    : normalizeEmail(requestedRaw);

  if (!isValidEmail(to)) throw new HttpError(400, 'invalid_recipient', '请输入有效的收件人地址');
  if (!text.trim()) throw new HttpError(400, 'empty_body', '邮件正文不能为空');
  // 管理员可以代任意地址发信（例如系统通知、多个业务邮箱），普通用户只能用自己账号的地址
  if (requestedFrom && requestedFrom !== user.email && user.role !== 'admin') {
    throw new HttpError(403, 'forbidden_from', '只有管理员可以指定发件人地址');
  }
  const from = requestedFrom || user.email;
  if (!isValidEmail(from)) throw new HttpError(400, 'invalid_sender', '发件人地址格式不正确');
  if (!env.EMAIL || typeof env.EMAIL.send !== 'function') {
    throw new HttpError(503, 'email_binding_missing', '未绑定发信服务，请为 Worker 添加 EMAIL 绑定');
  }

  try {
    await env.EMAIL.send({
      from: { email: from, name: user.name || undefined },
      to,
      subject,
      text,
    });
  } catch (error) {
    const friendly = friendlySendError(error?.message || error);
    await dbRun(
      env,
      'INSERT INTO sends (user_id, sender, receiver, subject, body, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      user.id,
      from,
      to,
      subject,
      text,
      'failed',
      str(error?.message || 'unknown', 500),
      nowIso(),
    );
    throw new HttpError(502, friendly.code, friendly.message);
  }

  const result = await dbRun(
    env,
    'INSERT INTO sends (user_id, sender, receiver, subject, body, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    user.id,
    from,
    to,
    subject,
    text,
    'sent',
    null,
    nowIso(),
  );
  await trimStore(env);
  return ok({ id: result.lastRowId, from, to, subject });
}

/**
 * 登录 / 初始化 / 个人资料接口。
 */







const MIN_PASSWORD = 8;

function assertPassword(password) {
  const value = str(password, 200);
  if (value.length < MIN_PASSWORD) {
    throw new HttpError(400, 'weak_password', `密码至少 ${MIN_PASSWORD} 位`);
  }
  if (value.length > 128) {
    throw new HttpError(400, 'weak_password', '密码过长');
  }
  return value;
}

/**
 * 旧版本用 12 万轮 PBKDF2 写哈希，而 Workers 运行时的上限是 10 万轮，
 * 这类密码无法在校验时重算 —— 明确告诉用户去重置，而不是含糊地报「密码不正确」。
 */
function unsupportedHashError(iterations) {
  return new HttpError(
    403,
    'password_reset_required',
    `该账号的密码哈希用了 ${iterations} 轮 PBKDF2，超过运行时上限 100000 轮，无法校验。请让管理员在「账号管理」里重置一次密码。`,
  );
}

async function sessionPayload(env, request, user) {
  const { token, expiresAt } = await createSession(env, user, request);
  return { token, expiresAt, user: publicUser(user) };
}

/** GET /api/setup —— 前端据此决定显示初始化向导还是登录页，并自动填好管理员地址。 */
async function handleSetupStatus(env, request) {
  const total = await countUsers(env);
  const domain = await resolveDomain(env, request);
  return ok({
    needsSetup: total === 0,
    userCount: total,
    domain,
    defaultAdmin: domain ? `admin@${domain}` : '',
    localOnly: Boolean(domain),
    version: 2,
  });
}

/** POST /api/setup —— 仅在系统还没有任何账号时可用。邮箱可省略，默认 admin@<域名>。 */
async function handleSetup(request, env) {
  const total = await countUsers(env);
  if (total > 0) throw new HttpError(403, 'setup_closed', '系统已初始化，请直接登录');

  const body = await readJson(request);
  const address = await requireAddress(env, body.email || 'admin', { request, local: 'admin' });
  const email = address.email;
  const name = str(body.name, 60).trim() || '管理员';
  const password = assertPassword(body.password);

  const passwordHash = await hashPassword(password, env);
  const result = await dbRun(
    env,
    'INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    email,
    name,
    passwordHash,
    'admin',
    'active',
    nowIso(),
  );
  const user = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', result.lastRowId);
  await rememberDomain(env, address.domain || domainOf(email));
  await adoptOrphanMail(env, user.id, user.email);
  // 剩下的无主邮件（收件地址没有对应账号）全部归到刚建好的管理员
  await adoptAllOrphanMail(env, Number(user.id));
  await markLogin(env, user.id);
  return json({ ok: true, ...(await sessionPayload(env, request, user)) });
}

/** POST /api/auth/login —— 识别得到域名时允许只填前缀。 */
async function handleLogin(request, env) {
  const body = await readJson(request);
  const typed = normalizeEmail(body.email);
  const email = (await expandAddress(env, typed, { request })).email;
  const password = str(body.password, 200);
  if (!email || !password) throw new HttpError(400, 'invalid_credentials', '请输入邮箱和密码');
  if (!isValidEmail(email)) throw new HttpError(401, 'invalid_credentials', '邮箱或密码不正确');

  const ip = clientIp(request);
  if (await isLoginThrottled(env, email, ip)) {
    throw new HttpError(429, 'too_many_attempts', '尝试次数过多，请 15 分钟后再试');
  }

  const user = await findUserByEmail(env, email);
  let passwordOk = false;
  if (user) {
    const result = await checkPassword(password, user.password_hash);
    if (typeof result === 'object' && result !== null && result.unsupported) {
      await recordLoginAttempt(env, email, ip, false);
      throw unsupportedHashError(result.unsupported);
    }
    passwordOk = result === 'ok';
  }
  await recordLoginAttempt(env, email, ip, Boolean(user && passwordOk));

  if (!user || !passwordOk) throw new HttpError(401, 'invalid_credentials', '邮箱或密码不正确');
  if (user.status !== 'active') throw new HttpError(403, 'account_disabled', '该账号已被停用，请联系管理员');

  await markLogin(env, user.id);
  await upgradePasswordHash(env, user, password);
  return json({ ok: true, ...(await sessionPayload(env, request, user)) });
}

/** 登录成功时顺手把旧的低轮数哈希升级到当前配置（失败不影响登录）。 */
async function upgradePasswordHash(env, user, password) {
  const stored = passwordIterations(user.password_hash);
  const target = pbkdf2Iterations(env);
  if (!stored || stored >= target) return;
  try {
    await dbRun(env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password, env), user.id);
  } catch {
    /* 升级失败就算了，下次登录再试 */
  }
}

/** POST /api/auth/logout */
async function handleLogout(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) await destroySession(env, match[1].trim());
  return ok();
}

/** GET /api/me */
async function handleMe(request, env) {
  const { user } = await requireUser(request, env);
  await purgeExpiredTrash(env, user.id);
  const counts = await dbFirst(
    env,
    `SELECT
       SUM(CASE WHEN is_read = 0 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS unread,
       SUM(CASE WHEN is_starred = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS starred,
       SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash,
       COUNT(*) AS total
     FROM emails WHERE user_id = ?`,
    user.id,
  );
  const sentRow = await dbFirst(env, 'SELECT COUNT(*) AS total FROM sends WHERE user_id = ?', user.id);
  const domain = await resolveDomain(env, request);
  return ok({
    user,
    domain,
    defaultAdmin: domain ? `admin@${domain}` : '',
    mailbox: localPart(user.email),
    counts: {
      unread: Number(counts?.unread || 0),
      starred: Number(counts?.starred || 0),
      trash: Number(counts?.trash || 0),
      inbox: Number(counts?.total || 0) - Number(counts?.trash || 0),
      sent: Number(sentRow?.total || 0),
    },
    canSendAs: user.role === 'admin',
    trashTtlDays: trashTtlDays(env),
    mailRetention: retentionLimit(env),
  });
}

/** PATCH /api/me —— 修改显示名。 */
async function handleUpdateProfile(request, env) {
  const { user } = await requireUser(request, env);
  const body = await readJson(request);
  const name = str(body.name, 60).trim();
  if (!name) throw new HttpError(400, 'invalid_name', '昵称不能为空');
  await dbRun(env, 'UPDATE users SET name = ? WHERE id = ?', name, user.id);
  const fresh = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return ok({ user: publicUser(fresh) });
}

/** POST /api/me/password */
async function handleChangePassword(request, env) {
  const { user } = await requireUser(request, env);
  const body = await readJson(request);
  const current = str(body.currentPassword, 200);
  const next = assertPassword(body.newPassword);
  const row = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', user.id);
  const result = row ? await checkPassword(current, row.password_hash) : 'mismatch';
  if (typeof result === 'object' && result !== null && result.unsupported) {
    throw unsupportedHashError(result.unsupported);
  }
  if (!row || result !== 'ok') {
    throw new HttpError(400, 'invalid_password', '当前密码不正确');
  }
  const passwordHash = await hashPassword(next, env);
  await dbRun(env, 'UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, user.id);
  // 其他设备上的会话全部失效，当前会话保留
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  await destroyUserSessions(env, user.id, token ? await sha256Hex(token) : '');
  return ok({ message: '密码已更新' });
}

/**
 * 管理员接口：账号管理（普通用户 + 管理员）。
 */






async function activeAdminCount(env, excludeId = 0) {
  const row = await dbFirst(
    env,
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
    excludeId,
  );
  return Number(row?.total || 0);
}

/** GET /api/users */
async function handleUserList(request, env) {
  await requireAdmin(request, env);
  const rows = await dbAll(
    env,
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM emails e WHERE e.user_id = u.id AND e.deleted_at IS NULL) AS mail_count,
            (SELECT COUNT(*) FROM sends s WHERE s.user_id = u.id) AS sent_count
       FROM users u
      ORDER BY (u.role = 'admin') DESC, u.id ASC`,
  );
  return ok({
    users: rows.map((row) => ({
      ...publicUser(row),
      mailCount: Number(row.mail_count || 0),
      sentCount: Number(row.sent_count || 0),
    })),
  });
}

/** POST /api/users */
async function handleUserCreate(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const address = await requireAddress(env, body.email, { request });
  const email = address.email;
  const name = str(body.name, 60).trim();
  const role = body.role === 'admin' ? 'admin' : 'user';
  const password = assertPassword(body.password);
  const status = body.status === 'disabled' ? 'disabled' : 'active';

  const exists = await dbFirst(env, 'SELECT id FROM users WHERE email = ?', email);
  if (exists) throw new HttpError(409, 'email_taken', '该邮箱已存在');

  const passwordHash = await hashPassword(password, env);
  const result = await dbRun(
    env,
    'INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    email,
    name || email.split('@')[0],
    passwordHash,
    role,
    status,
    nowIso(),
  );
  const row = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', result.lastRowId);
  await rememberDomain(env, address.domain || domainOf(email));
  await adoptOrphanMail(env, row.id, row.email);
  return ok({ user: publicUser(row) });
}

/** PATCH /api/users/:id */
async function handleUserUpdate(request, env, id) {
  const { user: actor } = await requireAdmin(request, env);
  const targetId = Number(id);
  const row = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', targetId);
  if (!row) throw new HttpError(404, 'not_found', '用户不存在');

  const body = await readJson(request);
  const name = body.name === undefined ? row.name : str(body.name, 60).trim();
  const role = body.role === undefined ? row.role : body.role === 'admin' ? 'admin' : 'user';
  const status = body.status === undefined ? row.status : body.status === 'disabled' ? 'disabled' : 'active';

  if (!name) throw new HttpError(400, 'invalid_name', '昵称不能为空');
  if (targetId === actor.id && (role !== 'admin' || status !== 'active')) {
    throw new HttpError(400, 'self_lockout', '不能停用或降级当前登录的管理员账号');
  }
  const losingAdmin = row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active');
  if (losingAdmin && (await activeAdminCount(env, targetId)) === 0) {
    throw new HttpError(400, 'last_admin', '至少需要保留一名可用的管理员');
  }

  await dbRun(env, 'UPDATE users SET name = ?, role = ?, status = ? WHERE id = ?', name, role, status, targetId);
  if (status === 'disabled') await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', targetId);
  const fresh = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', targetId);
  return ok({ user: publicUser(fresh) });
}

/** POST /api/users/:id/password */
async function handleUserResetPassword(request, env, id) {
  await requireAdmin(request, env);
  const targetId = Number(id);
  const row = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', targetId);
  if (!row) throw new HttpError(404, 'not_found', '用户不存在');
  const body = await readJson(request);
  const password = assertPassword(body.password);
  await dbRun(env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password, env), targetId);
  await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', targetId);
  return ok({ message: '密码已重置' });
}

/** DELETE /api/users/:id */
async function handleUserDelete(request, env, id) {
  const { user: actor } = await requireAdmin(request, env);
  const targetId = Number(id);
  if (targetId === actor.id) throw new HttpError(400, 'self_delete', '不能删除当前登录的账号');
  const row = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', targetId);
  if (!row) throw new HttpError(404, 'not_found', '用户不存在');
  if (row.role === 'admin' && row.status === 'active' && (await activeAdminCount(env, targetId)) === 0) {
    throw new HttpError(400, 'last_admin', '至少需要保留一名可用的管理员');
  }
  await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', targetId);
  await dbRun(env, 'DELETE FROM emails WHERE user_id = ?', targetId);
  await dbRun(env, 'DELETE FROM sends WHERE user_id = ?', targetId);
  await dbRun(env, 'DELETE FROM users WHERE id = ?', targetId);
  return ok({ deleted: true });
}

/** GET /api/admin/overview —— 简单统计卡片 */
async function handleAdminOverview(request, env) {
  await requireAdmin(request, env);
  const users = await dbFirst(env, 'SELECT COUNT(*) AS total FROM users');
  const mails = await dbFirst(env, 'SELECT COUNT(*) AS total FROM emails');
  const sent = await dbFirst(env, 'SELECT COUNT(*) AS total FROM sends');
  const unread = await dbFirst(env, 'SELECT COUNT(*) AS total FROM emails WHERE is_read = 0 AND deleted_at IS NULL');
  return ok({
    stats: {
      users: Number(users?.total || 0),
      mails: Number(mails?.total || 0),
      sent: Number(sent?.total || 0),
      unread: Number(unread?.total || 0),
    },
  });
}

/**
 * GET /api/diagnostics —— 管理员自检。
 * 「admin 收不到无主邮件」这类问题通常卡在三处：信根本没进 Worker（Email Routing 没配 catch-all）、
 * 进来了但 user_id 为空（还没建管理员/旧版本写进库）、或者归属到了别的账号。
 * 这个接口把三处都摊开，并在需要时提供一键归属。
 */
async function handleDiagnostics(request, env) {
  await requireAdmin(request, env);
  const total = async (sql, ...args) => Number((await dbFirst(env, sql, ...args))?.total || 0);
  const emails = await total('SELECT COUNT(*) AS total FROM emails');
  const orphans = await total('SELECT COUNT(*) AS total FROM emails WHERE user_id IS NULL');
  const stranded = await dbAll(
    env,
    `SELECT id, receiver, subject, received_at
       FROM emails WHERE user_id IS NULL ORDER BY id DESC LIMIT 5`,
  );
  const users = await dbAll(
    env,
    `SELECT u.id, u.email, u.role, u.status,
            (SELECT COUNT(*) FROM emails e WHERE e.user_id = u.id AND e.deleted_at IS NULL) AS mail_count
       FROM users u ORDER BY (u.role = 'admin') DESC, u.id ASC`,
  );
  const admin = await firstAdminUser(env);
  return ok({
    version: 2,
    domain: await resolveDomain(env, request),
    domainSource: await domainSource(env),
    admin: admin ? { id: Number(admin.id), email: admin.email } : null,
    stats: {
      emails,
      orphans,
      unread: await total('SELECT COUNT(*) AS total FROM emails WHERE is_read = 0 AND deleted_at IS NULL'),
      sends: await total('SELECT COUNT(*) AS total FROM sends'),
      apiKeys: await total('SELECT COUNT(*) AS total FROM api_keys WHERE revoked_at IS NULL'),
      sessions: await total('SELECT COUNT(*) AS total FROM sessions'),
    },
    users: users.map((row) => ({
      id: Number(row.id),
      email: row.email,
      role: row.role,
      status: row.status,
      mailCount: Number(row.mail_count || 0),
    })),
    stranded: stranded.map((row) => ({
      id: Number(row.id),
      receiver: row.receiver,
      subject: row.subject,
      receivedAt: row.received_at,
    })),
    hints: [
      '收信地址必须先在 Email Routing 里路由到这个 Worker（推荐配置 catch-all），否则邮件根本不会进来。',
      '无主邮件会即时归到第一个可用的管理员账号；这里显示 0 封说明没有滞留。',
      '若这封邮件是旧版本写进来的（user_id 为空），点「归到管理员」即可追回。',
    ],
  });
}

/** POST /api/diagnostics/adopt —— 把滞留的无主邮件一次性归到管理员 */
async function handleAdoptOrphans(request, env) {
  const { user } = await requireAdmin(request, env);
  const admin = await firstAdminUser(env);
  const target = admin ? Number(admin.id) : Number(user.id);
  const moved = await adoptAllOrphanMail(env, target);
  return ok({ moved, owner: admin ? admin.email : user.email });
}

/**
 * API 密钥管理接口。
 *
 * 密钥用于让脚本 / 第三方系统直接调用收发邮件接口，不必模拟网页登录：
 *   curl -H "x-api-key: cm_xxx" https://mail.example.com/api/mails
 */




const DOCS = [
  { method: 'GET', path: '/api/mails?box=inbox&page=1&pageSize=25&q=关键词', desc: '拉取邮件列表（box=inbox|starred|trash|sent）' },
  { method: 'GET', path: '/api/mails/:id', desc: '读取单封邮件正文与附件信息' },
  { method: 'POST', path: '/api/mails/send', desc: '发信，JSON: {to, subject, body, from?}' },
  { method: 'PATCH', path: '/api/mails/:id', desc: '标记已读/星标，JSON: {isRead, isStarred}；从垃圾箱恢复用 {restore: true}' },
  { method: 'DELETE', path: '/api/mails/:id', desc: '删除邮件（进垃圾箱；已在垃圾箱或带 ?permanent=1 时永久删除）' },
  { method: 'POST', path: '/api/mails/trash/empty', desc: '清空垃圾箱' },
  { method: 'POST', path: '/api/keys', desc: '新建接口密钥，JSON: {name}；明文只在响应里返回一次' },
  { method: 'POST', path: '/api/keys/:id/revoke', desc: '撤销接口密钥（彻底删除记录，不可恢复）' },
  { method: 'GET', path: '/api/me', desc: '当前账号信息与未读统计' },
];

/** GET /api/keys */
async function handleKeyList(request, env) {
  const { user } = await requireUser(request, env);
  const keys = await listApiKeys(env, user.id);
  return ok({
    keys,
    prefix: API_KEY_PREFIX,
    docs: DOCS,
    canSendAs: user.role === 'admin',
  });
}

/** POST /api/keys  { name } */
async function handleKeyCreate(request, env) {
  const { user } = await requireUser(request, env);
  const body = await readJson(request);
  try {
    const created = await createApiKey(env, user.id, str(body.name, 60));
    return ok({ id: created.id, key: created.key, masked: created.masked, name: str(body.name, 60).trim() || '默认密钥' });
  } catch (error) {
    if (error && error.code) throw new HttpError(error.status || 400, error.code, error.message);
    throw error;
  }
}

/** POST /api/keys/:id/revoke —— 撤销即彻底删除 */
async function handleKeyRevoke(request, env, id) {
  const { user } = await requireUser(request, env);
  const removed = await revokeApiKey(env, user.id, id);
  if (!removed) throw new HttpError(404, 'not_found', '密钥不存在');
  return ok({ revoked: id, deleted: true });
}

/**
 * 启动自检：建表 + 可选的引导管理员。
 * 每个 isolate 只执行一次，失败会重置以便下一次请求重试。
 */





/** 按 D1 绑定缓存；同一 isolate 内每个库只跑一次自检。 */
const readyPromises = new WeakMap();

function ensureReady(env) {
  const key = env?.DB;
  if (!key) return ensureSchema(env);
  let promise = readyPromises.get(key);
  if (!promise) {
    promise = (async () => {
      await ensureSchema(env);
      await bootstrapAdmin(env);
      await recoverAdminPasswords(env);
      await adoptOrphansToAdmin(env);
    })().catch((error) => {
      readyPromises.delete(key);
      throw error;
    });
    readyPromises.set(key, promise);
  }
  return promise;
}

/**
 * 旧版本用 12 万轮 PBKDF2 写哈希，而 Workers 运行时的上限是 10 万轮，这类密码无法校验。
 * 只要还配置着 ADMIN_PASSWORD，就顺手把这类管理员账号救回来，避免把自己锁在门外。
 */
async function recoverAdminPasswords(env) {
  const password = str(env?.ADMIN_PASSWORD, 200);
  if (!password || password.length < 8) return;
  let rows = [];
  try {
    rows = await dbAll(env, "SELECT id, email, password_hash FROM users WHERE role = 'admin'");
  } catch {
    return;
  }
  const broken = rows.filter((row) => passwordIterations(row.password_hash) > PBKDF2_MAX_ITERATIONS);
  if (!broken.length) return;
  const hash = await hashPassword(password, env);
  for (const row of broken) {
    await dbRun(env, 'UPDATE users SET password_hash = ? WHERE id = ?', hash, row.id);
    await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', row.id);
    console.log(`管理员 ${row.email} 的密码哈希绕过了运行时上限，已按 ADMIN_PASSWORD 重置`);
  }
}

/**
 * 启动时把历史遗留的无主邮件（user_id 为空）统归到管理员，
 * 兼容旧库升级、以及「先收到信、后建账号」的时序。
 */
async function adoptOrphansToAdmin(env) {
  try {
    const admin = await firstAdminUser(env);
    if (!admin) return;
    const moved = await adoptAllOrphanMail(env, Number(admin.id));
    if (moved) console.log(`已把 ${moved} 封无主邮件归到管理员 ${admin.email}`);
  } catch {
    // 归属失败不影响服务启动
  }
}

/**
 * ADMIN_PASSWORD 是必填项，ADMIN_EMAIL 可以只填前缀。
 * 一个都不填时默认 admin@<域名>，域名能自动识别就自动建号，识别不到就留给网页初始化向导。
 */
async function bootstrapAdmin(env) {
  const password = str(env?.ADMIN_PASSWORD, 200);
  if (!password) return;
  if (password.length < 8) {
    console.warn('ADMIN_PASSWORD 少于 8 位，已跳过自动创建管理员');
    return;
  }

  const raw = normalizeEmail(env?.ADMIN_EMAIL);
  const domain = await resolveDomain(env);
  const prefix = raw.includes('@') ? '' : raw || 'admin';
  const email = raw.includes('@') ? raw : prefix && domain ? `${prefix}@${domain}` : '';

  if (!email) {
    console.warn('已设置 ADMIN_PASSWORD，但无法确定收件域名（MAIL_DOMAIN 未配置且尚无历史邮件），已跳过自动建号');
    return;
  }
  if (!isValidEmail(email)) {
    console.warn(`ADMIN_EMAIL（${email}）格式不正确，已跳过自动创建管理员`);
    return;
  }
  if ((await countUsers(env)) > 0) return;

  const exists = await dbFirst(env, 'SELECT id FROM users WHERE email = ?', email);
  if (exists) return;

  await dbRun(
    env,
    'INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    email,
    '管理员',
    await hashPassword(password, env),
    'admin',
    'active',
    nowIso(),
  );
  await rememberDomain(env, normalizeDomain(email.slice(email.lastIndexOf('@') + 1)));
  console.log(`已根据环境变量创建管理员 ${email}`);
}

/**
 * 收信入口：Email Routing → Worker。
 * 收件地址匹配到用户邮箱则归入该用户；匹配不到的无主邮件一律归到管理员，
 * 保证任何一封信都不会落在没人可见的「黑洞」里。
 */






const MAX_STORED_BODY = 900 * 1024;

function bareAddress(value) {
  const text = str(value, 400).trim().replace(/^<|>$/g, '');
  const angle = text.match(/<([^<>]+)>/);
  return normalizeEmail(angle ? angle[1] : text);
}

async function matchRecipient(env, address) {
  if (!address) return null;
  const direct = await dbFirst(env, 'SELECT id, email FROM users WHERE lower(email) = ?', address);
  if (direct) return direct;
  // 域名换了但本地部分相同的场景
  const local = address.split('@')[0];
  if (!local) return null;
  return dbFirst(env, "SELECT id, email FROM users WHERE lower(substr(email, 1, instr(email, '@') - 1)) = ? LIMIT 1", local);
}

async function handleIncomingEmail(message, env, ctx) {
  await ensureSchema(env);

  const recipient = bareAddress(message.to || message.headers.get('to') || '');
  const raw = await new Response(message.raw).text();
  const parsed = parseMail(raw);

  const headerFrom = splitAddress(parsed.from || message.headers.get('from') || '');
  const sender = headerFrom.address || bareAddress(message.from);
  const senderName = str(headerFrom.name, 120);
  const realSender = bareAddress(message.from) || sender;
  // Message-ID 优先取平台给的 header，缺失时退回原始邮件头（用于去重）
  const messageId = str(message.headers.get('message-id') || parsed.messageId, 400).trim() || null;

  const user = await matchRecipient(env, recipient);
  // 无主邮件（收件地址没有对应账号）全部归到管理员，宁可多收也不丢信；
  // 连管理员都还没有（初始化没走完）时退回最早的可用账号，最后才允许留空。
  const owner = user || (await firstAdminUser(env)) || (await orphanFallbackUser(env));
  if (owner && !user) {
    console.log(`[orphan] ${recipient || '(未知收件人)'} 没有对应账号，已归到 ${owner.email}`);
  }
  // 第一封邮件就能把收件域名学下来，之后所有地址输入框都只需要填前缀
  if (recipient) await rememberDomain(env, domainOf(recipient));
  const html = parsed.html ? trimToBytes(parsed.html, MAX_STORED_BODY) : '';
  const text = parsed.text ? trimToBytes(parsed.text, MAX_STORED_BODY) : '';
  // 只发 HTML 的邮件（有些发信方连 Content-Type 都不写）也要按 HTML 存
  const bodyType = html || looksLikeHtml(text) ? 'html' : 'text';
  const body = html || text || '(无内容)';

  try {
    if (messageId) {
      const existing = await dbFirst(env, 'SELECT id FROM emails WHERE message_id = ?', messageId);
      if (existing) return;
    }

    await dbRun(
      env,
      `INSERT OR IGNORE INTO emails
         (message_id, user_id, sender, sender_name, real_sender, receiver, subject, body, body_type, preview, attachments, is_read, is_starred, received_at, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      messageId,
      owner ? Number(owner.id) : null,
      sender,
      senderName,
      realSender,
      recipient,
      parsed.subject,
      body,
      bodyType,
      parsed.preview,
      JSON.stringify(parsed.attachments || []),
      nowIso(),
      parsed.size,
    );

    await trimStore(env);
  } catch (error) {
    console.error('inbound email failed', error);
    // 抛出让 Cloudflare 稍后重试，避免静默丢信
    throw error;
  }
}

/**
 * Cloud Mail —— Cloudflare Worker 入口。
 *
 * fetch: 提供静态界面与 JSON API（自动建表、多用户）
 * email: 接收 Email Routing 投递的邮件
 */









/** 构建时由 scripts/build.mjs 替换为内联的界面 HTML。 */
const APP_HTML = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\" />\n  <meta name=\"color-scheme\" content=\"light dark\" />\n  <meta name=\"description\" content=\"Cloud Mail —— 运行在 Cloudflare Worker 上的极简邮箱\" />\n  <title>Cloud Mail</title>\n  <link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%234f46e5'/%3E%3Cpath d='M16 23.5c0-1.9 1.6-3.5 3.5-3.5h25c1.9 0 3.5 1.6 3.5 3.5v17c0 1.9-1.6 3.5-3.5 3.5h-25c-1.9 0-3.5-1.6-3.5-3.5v-17Z' fill='none' stroke='white' stroke-width='3'/%3E%3Cpath d='m17 24 15 11 15-11' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\" />\n  <style>/* ============ 基础 ============ */\n*,\n*::before,\n*::after { box-sizing: border-box; }\n\n:root {\n  --font: \"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\",\n    \"Noto Sans SC\", \"Microsoft YaHei\", sans-serif;\n  --mono: ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace;\n\n  --bg: #f5f6f9;\n  --surface: #ffffff;\n  --surface-2: #f2f3f7;\n  --surface-3: #e8eaf1;\n  --border: #e6e8ef;\n  --border-strong: #d5d8e3;\n  --text: #14161f;\n  --text-2: #4b5266;\n  --muted: #7b8296;\n  --accent: #4f46e5;\n  --accent-hover: #4338ca;\n  --accent-soft: #eceafe;\n  --accent-text: #4338ca;\n  --danger: #d92d20;\n  --danger-soft: #fef3f2;\n  --success: #067647;\n  --star: #f59e0b;\n  --paper: #ffffff;\n  --paper-text: #1b1e28;\n\n  --shadow-xs: 0 1px 2px rgba(16, 20, 35, 0.06);\n  --shadow-sm: 0 2px 6px rgba(16, 20, 35, 0.06), 0 1px 2px rgba(16, 20, 35, 0.04);\n  --shadow-md: 0 12px 32px -12px rgba(16, 20, 35, 0.22);\n  --shadow-lg: 0 32px 64px -24px rgba(16, 20, 35, 0.35);\n\n  --radius-sm: 8px;\n  --radius: 12px;\n  --radius-lg: 18px;\n  --rail-w: 76px;\n  --list-w: 340px;\n  --header-h: 62px;\n}\n\n:root[data-theme=\"dark\"] {\n  --bg: #0c0e14;\n  --surface: #14161f;\n  --surface-2: #1b1e29;\n  --surface-3: #242835;\n  --border: #232734;\n  --border-strong: #303646;\n  --text: #eef0f6;\n  --text-2: #b3b9c9;\n  --muted: #8b93a7;\n  --accent: #7b74ff;\n  --accent-hover: #8f89ff;\n  --accent-soft: #1e1f3d;\n  --accent-text: #b4b0ff;\n  --danger: #ff6b62;\n  --danger-soft: #2a1614;\n  --success: #3ecf8e;\n  --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.4);\n  --shadow-md: 0 16px 40px -16px rgba(0, 0, 0, 0.7);\n  --shadow-lg: 0 40px 80px -32px rgba(0, 0, 0, 0.85);\n}\n\n@media (prefers-color-scheme: dark) {\n  :root[data-theme=\"auto\"] {\n    --bg: #0c0e14;\n    --surface: #14161f;\n    --surface-2: #1b1e29;\n    --surface-3: #242835;\n    --border: #232734;\n    --border-strong: #303646;\n    --text: #eef0f6;\n    --text-2: #b3b9c9;\n    --muted: #8b93a7;\n    --accent: #7b74ff;\n    --accent-hover: #8f89ff;\n    --accent-soft: #1e1f3d;\n    --accent-text: #b4b0ff;\n    --danger: #ff6b62;\n    --danger-soft: #2a1614;\n    --success: #3ecf8e;\n    --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.4);\n    --shadow-md: 0 16px 40px -16px rgba(0, 0, 0, 0.7);\n    --shadow-lg: 0 40px 80px -32px rgba(0, 0, 0, 0.85);\n  }\n}\n\nhtml, body { height: 100%; }\n\nbody {\n  margin: 0;\n  font-family: var(--font);\n  font-size: 14px;\n  line-height: 1.5;\n  color: var(--text);\n  background: var(--bg);\n  -webkit-font-smoothing: antialiased;\n  text-rendering: optimizeLegibility;\n}\n\nbutton, input, textarea, select { font: inherit; color: inherit; }\nbutton { cursor: pointer; background: none; border: 0; padding: 0; }\na { color: var(--accent); text-decoration: none; }\na:hover { text-decoration: underline; }\n::selection { background: var(--accent-soft); color: var(--accent-text); }\n\n:focus-visible {\n  outline: 2px solid var(--accent);\n  outline-offset: 2px;\n}\n\n/* 滚动条 */\n* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }\n*::-webkit-scrollbar { width: 10px; height: 10px; }\n*::-webkit-scrollbar-thumb {\n  background: var(--border-strong);\n  border: 3px solid transparent;\n  border-radius: 999px;\n  background-clip: content-box;\n}\n*::-webkit-scrollbar-thumb:hover { background-color: var(--muted); background-clip: content-box; }\n*::-webkit-scrollbar-track { background: transparent; }\n\n.app-root { height: 100%; }\n\n/* ============ 原子组件 ============ */\n.btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 7px;\n  height: 38px;\n  padding: 0 15px;\n  border-radius: 10px;\n  border: 1px solid var(--border);\n  background: var(--surface);\n  color: var(--text);\n  font-size: 13.5px;\n  font-weight: 550;\n  white-space: nowrap;\n  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;\n  box-shadow: var(--shadow-xs);\n}\n.btn:hover { background: var(--surface-2); border-color: var(--border-strong); }\n.btn:active { transform: translateY(1px); }\n.btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }\n.btn svg { flex: none; }\n\n.btn-primary {\n  background: var(--accent);\n  border-color: transparent;\n  color: #fff;\n  box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--accent) 70%, transparent);\n}\n.btn-primary:hover { background: var(--accent-hover); border-color: transparent; }\n\n.btn-ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--text-2); }\n.btn-ghost:hover { background: var(--surface-2); border-color: transparent; color: var(--text); }\n\n.btn-danger { color: var(--danger); }\n.btn-danger:hover { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }\n\n.btn-block { width: 100%; height: 44px; font-size: 14px; }\n\n.icon-btn {\n  display: inline-grid;\n  place-items: center;\n  width: 34px;\n  height: 34px;\n  border-radius: 9px;\n  color: var(--muted);\n  transition: background 0.14s ease, color 0.14s ease;\n  flex: none;\n}\n.icon-btn:hover { background: var(--surface-2); color: var(--text); }\n.icon-btn.is-active { color: var(--star); }\n.icon-btn.is-on { color: var(--accent); background: var(--accent-soft); }\n\n.field { display: flex; flex-direction: column; gap: 7px; }\n.field > label { font-size: 12.5px; font-weight: 600; color: var(--text-2); letter-spacing: 0.01em; }\n.field .hint { font-size: 12px; color: var(--muted); line-height: 1.5; }\n\n/* 邮箱地址输入：只填前缀，域名自动补在后面 */\n.input-group { display: flex; align-items: stretch; }\n.input-group > .input { border-top-right-radius: 0; border-bottom-right-radius: 0; }\n.input-group > .input:focus { position: relative; z-index: 1; }\n.input-group > .affix {\n  display: inline-flex;\n  align-items: center;\n  padding: 0 13px;\n  border: 1px solid var(--border-strong);\n  border-left: 0;\n  border-radius: 0 10px 10px 0;\n  background: var(--surface-2);\n  color: var(--text-2);\n  font-size: 13px;\n  white-space: nowrap;\n  user-select: none;\n}\n.input-group > .affix.is-muted { color: var(--muted); }\n\n.input, .textarea, .select {\n  width: 100%;\n  min-height: 42px;\n  padding: 10px 13px;\n  background: var(--surface);\n  border: 1px solid var(--border-strong);\n  border-radius: 10px;\n  color: var(--text);\n  transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;\n}\n.input::placeholder, .textarea::placeholder { color: var(--muted); }\n.input:hover, .textarea:hover, .select:hover { border-color: var(--muted); }\n.input:focus, .textarea:focus, .select:focus {\n  outline: none;\n  border-color: var(--accent);\n  box-shadow: 0 0 0 3.5px color-mix(in srgb, var(--accent) 16%, transparent);\n}\n.textarea { resize: vertical; min-height: 150px; line-height: 1.65; }\n.select { appearance: none; cursor: pointer; padding-right: 34px; }\n\n.badge {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 21px;\n  padding: 0 8px;\n  border-radius: 999px;\n  font-size: 11.5px;\n  font-weight: 600;\n  letter-spacing: 0.01em;\n  background: var(--surface-2);\n  color: var(--text-2);\n  border: 1px solid var(--border);\n}\n.badge-accent { background: var(--accent-soft); color: var(--accent-text); border-color: transparent; }\n.badge-danger { background: var(--danger-soft); color: var(--danger); border-color: transparent; }\n.badge-success { background: color-mix(in srgb, var(--success) 12%, transparent); color: var(--success); border-color: transparent; }\n\n.avatar {\n  display: grid;\n  place-items: center;\n  width: 36px;\n  height: 36px;\n  border-radius: 50%;\n  color: #fff;\n  font-size: 13px;\n  font-weight: 650;\n  letter-spacing: 0.02em;\n  flex: none;\n  user-select: none;\n  box-shadow: inset 0 -1px 2px rgba(0, 0, 0, 0.16);\n}\n.avatar-lg { width: 56px; height: 56px; font-size: 19px; }\n\n.brand-mark {\n  display: grid;\n  place-items: center;\n  width: 38px;\n  height: 38px;\n  border-radius: 11px;\n  background: linear-gradient(145deg, #6366f1, #4338ca);\n  color: #fff;\n  box-shadow: 0 8px 18px -8px rgba(79, 70, 229, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.25);\n  flex: none;\n}\n\n.spinner {\n  width: 16px;\n  height: 16px;\n  border-radius: 50%;\n  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);\n  border-top-color: currentColor;\n  animation: spin 0.7s linear infinite;\n}\n@keyframes spin { to { transform: rotate(360deg); } }\n\n.empty {\n  display: grid;\n  justify-items: center;\n  gap: 10px;\n  padding: 64px 24px;\n  text-align: center;\n  color: var(--muted);\n}\n.empty .empty-icon {\n  display: grid;\n  place-items: center;\n  width: 54px;\n  height: 54px;\n  border-radius: 16px;\n  background: var(--surface-2);\n  color: var(--muted);\n  margin-bottom: 2px;\n}\n.empty strong { color: var(--text-2); font-size: 14px; font-weight: 600; }\n.empty p { margin: 0; font-size: 12.5px; max-width: 30ch; line-height: 1.6; }\n\n.divider { height: 1px; background: var(--border); border: 0; margin: 0; }\n\n/* ============ 登录 / 初始化 ============ */\n.auth-screen {\n  min-height: 100dvh;\n  display: grid;\n  place-items: center;\n  padding: 28px 20px;\n  background:\n    radial-gradient(900px 520px at 8% -12%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 62%),\n    radial-gradient(760px 480px at 104% 4%, color-mix(in srgb, #06b6d4 13%, transparent), transparent 58%),\n    var(--bg);\n}\n.auth-card {\n  width: 100%;\n  max-width: 408px;\n  padding: 34px 32px 28px;\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 22px;\n  box-shadow: var(--shadow-lg);\n}\n.auth-head { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }\n.auth-head h1 { margin: 0; font-size: 19px; font-weight: 680; letter-spacing: -0.02em; }\n.auth-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }\n.auth-form { display: flex; flex-direction: column; gap: 15px; }\n.auth-foot { margin-top: 20px; text-align: center; font-size: 12px; color: var(--muted); line-height: 1.6; }\n.auth-error {\n  display: none;\n  padding: 10px 12px;\n  border-radius: 10px;\n  background: var(--danger-soft);\n  color: var(--danger);\n  font-size: 12.5px;\n  line-height: 1.5;\n  border: 1px solid color-mix(in srgb, var(--danger) 22%, transparent);\n}\n.auth-error.is-visible { display: block; animation: shake 0.3s ease; }\n@keyframes shake {\n  0%, 100% { transform: translateX(0); }\n  25% { transform: translateX(-4px); }\n  75% { transform: translateX(4px); }\n}\n.auth-theme { position: fixed; top: 18px; right: 18px; }\n\n/* ============ 主框架 ============ */\n.shell {\n  display: grid;\n  grid-template-columns: var(--rail-w) var(--list-w) minmax(0, 1fr);\n  /* 行高锁定为视口高度：正文再长也不会把整行撑高，避免侧栏底部按钮被挤出屏幕 */\n  grid-template-rows: minmax(0, 1fr);\n  height: 100dvh;\n  overflow: hidden;\n}\n\n/* 设置 / 管理页：占据列表 + 阅读两列 */\n.shell--page { grid-template-columns: var(--rail-w) minmax(0, 1fr); }\n.shell--page .list-pane { display: none; }\n\n/* ---- 左侧导航 ---- */\n.rail {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 6px;\n  padding: 16px 0 14px;\n  min-height: 0;\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  z-index: 3;\n}\n.rail .brand-mark { margin-bottom: 10px; }\n.rail-nav { display: flex; flex: 1; min-height: 0; flex-direction: column; align-items: center; gap: 4px; width: 100%; margin-top: 4px; }\n.rail-btn {\n  position: relative;\n  display: grid;\n  place-items: center;\n  width: 46px;\n  height: 42px;\n  border-radius: 11px;\n  color: var(--muted);\n  transition: background 0.14s ease, color 0.14s ease;\n}\n.rail-btn:hover { background: var(--surface-2); color: var(--text); }\n.rail-btn.is-active { background: var(--accent-soft); color: var(--accent-text); }\n.rail-btn .rail-badge {\n  position: absolute;\n  top: 5px;\n  right: 6px;\n  min-width: 16px;\n  height: 16px;\n  padding: 0 4px;\n  border-radius: 999px;\n  background: var(--accent);\n  color: #fff;\n  font-size: 10px;\n  font-weight: 700;\n  line-height: 16px;\n  text-align: center;\n  box-shadow: 0 0 0 2px var(--surface);\n}\n.rail-btn[data-tip]::after {\n  content: attr(data-tip);\n  position: absolute;\n  left: 54px;\n  top: 50%;\n  translate: 0 -50%;\n  padding: 5px 9px;\n  border-radius: 7px;\n  background: var(--text);\n  color: var(--surface);\n  font-size: 11.5px;\n  font-weight: 550;\n  white-space: nowrap;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.12s ease 0.25s;\n  z-index: 20;\n}\n.rail-btn[data-tip]:hover::after { opacity: 1; }\n.rail-spacer { flex: 1; }\n.rail-user { display: grid; place-items: center; }\n.rail-user button { border-radius: 50%; transition: box-shadow 0.14s ease; }\n.rail-user button:hover { box-shadow: 0 0 0 3px var(--accent-soft); }\n\n/* ---- 列表列 ---- */\n.list-pane {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n  background: var(--surface);\n  border-right: 1px solid var(--border);\n  z-index: 2;\n}\n.list-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  height: var(--header-h);\n  padding: 0 16px 0 20px;\n  flex: none;\n}\n.list-head h2 { margin: 0; font-size: 17px; font-weight: 680; letter-spacing: -0.02em; }\n.list-head .head-actions { display: flex; align-items: center; gap: 2px; }\n\n.search-wrap { position: relative; padding: 0 14px 10px; }\n.search-wrap svg { position: absolute; left: 26px; top: 11px; color: var(--muted); pointer-events: none; }\n.search-input {\n  width: 100%;\n  height: 36px;\n  padding: 0 30px 0 34px;\n  border-radius: 9px;\n  border: 1px solid transparent;\n  background: var(--surface-2);\n  font-size: 13px;\n  transition: background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;\n}\n.search-input:focus {\n  outline: none;\n  background: var(--surface);\n  border-color: var(--accent);\n  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);\n}\n.search-clear {\n  position: absolute;\n  right: 22px;\n  top: 7px;\n  display: grid;\n  place-items: center;\n  width: 22px;\n  height: 22px;\n  border-radius: 50%;\n  color: var(--muted);\n}\n.search-clear:hover { background: var(--surface-3); color: var(--text); }\n\n.chips { display: flex; gap: 6px; padding: 0 16px 12px; overflow-x: auto; scrollbar-width: none; flex: none; }\n.chips::-webkit-scrollbar { display: none; }\n.chip {\n  height: 27px;\n  padding: 0 11px;\n  border-radius: 999px;\n  border: 1px solid var(--border);\n  background: var(--surface);\n  color: var(--text-2);\n  font-size: 12.5px;\n  font-weight: 550;\n  white-space: nowrap;\n  transition: all 0.14s ease;\n}\n.chip:hover { border-color: var(--border-strong); background: var(--surface-2); }\n.chip.is-active { background: var(--accent); border-color: transparent; color: #fff; }\n\n.mail-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 12px; }\n.mail-item {\n  position: relative;\n  display: block;\n  width: 100%;\n  padding: 12px 12px 12px 14px;\n  border-radius: 11px;\n  text-align: left;\n  transition: background 0.12s ease;\n}\n.mail-item + .mail-item { margin-top: 1px; }\n.mail-item:hover { background: var(--surface-2); }\n.mail-item.is-active { background: var(--accent-soft); }\n.mail-item.is-active .mail-subject { color: var(--accent-text); }\n.mail-row1 { display: flex; align-items: baseline; gap: 8px; }\n.mail-from {\n  flex: 1;\n  min-width: 0;\n  font-size: 13.5px;\n  font-weight: 600;\n  color: var(--text);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.mail-time { flex: none; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }\n.mail-subject {\n  margin-top: 2px;\n  font-size: 13px;\n  font-weight: 500;\n  color: var(--text-2);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.mail-preview {\n  margin-top: 3px;\n  font-size: 12.5px;\n  color: var(--muted);\n  display: -webkit-box;\n  -webkit-line-clamp: 1;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  line-height: 1.5;\n}\n.mail-item.is-unread .mail-from { font-weight: 700; color: var(--text); }\n.mail-item.is-unread .mail-subject { color: var(--text); font-weight: 600; }\n.mail-item.is-unread::before {\n  content: \"\";\n  position: absolute;\n  left: 4px;\n  top: 18px;\n  width: 5px;\n  height: 5px;\n  border-radius: 50%;\n  background: var(--accent);\n}\n.mail-flags { display: inline-flex; align-items: center; gap: 5px; flex: none; }\n.mail-flags .star { color: var(--star); }\n.mail-flags .clip { color: var(--muted); }\n.list-more { display: grid; place-items: center; padding: 10px 0 4px; }\n.list-more button { font-size: 12.5px; color: var(--accent); font-weight: 550; }\n\n/* ---- 阅读列 ---- */\n.reader {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  /* 必须显式归零，否则长正文会撑高 flex 子项、把整行顶出视口 */\n  min-height: 0;\n  overflow: hidden;\n  background: var(--bg);\n  position: relative;\n}\n.reader-bar {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  height: var(--header-h);\n  padding: 0 14px;\n  flex: none;\n  border-bottom: 1px solid var(--border);\n  background: color-mix(in srgb, var(--surface) 72%, transparent);\n  backdrop-filter: blur(12px);\n}\n.reader-bar .bar-title { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.reader-back { display: none; }\n.reader-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 30px 28px 60px; }\n.reader-inner { max-width: 780px; margin: 0 auto; }\n\n.mail-head { margin-bottom: 20px; }\n.mail-head h1 {\n  margin: 0 0 14px;\n  font-size: 23px;\n  line-height: 1.3;\n  font-weight: 680;\n  letter-spacing: -0.025em;\n  word-break: break-word;\n}\n.mail-meta { display: flex; align-items: center; gap: 12px; }\n.mail-meta-text { min-width: 0; flex: 1; }\n.mail-meta-text .who { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }\n.mail-meta-text .name { font-size: 13.5px; font-weight: 650; }\n.mail-meta-text .addr { font-size: 12px; color: var(--muted); word-break: break-all; }\n.mail-meta-text .to { margin-top: 3px; font-size: 12px; color: var(--muted); word-break: break-all; }\n.mail-date { font-size: 12px; color: var(--muted); white-space: nowrap; }\n\n.mail-paper {\n  margin-top: 22px;\n  background: var(--paper);\n  border: 1px solid var(--border);\n  border-radius: 14px;\n  overflow: hidden;\n  box-shadow: var(--shadow-sm);\n}\n.mail-frame { display: block; width: 100%; border: 0; min-height: 240px; background: var(--paper); }\n.mail-plain {\n  padding: 24px 26px;\n  color: var(--paper-text);\n  font-size: 14.5px;\n  line-height: 1.75;\n  white-space: pre-wrap;\n  word-break: break-word;\n  font-family: var(--font);\n}\n.mail-attachments { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }\n.attachment {\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px;\n  border-radius: 10px;\n  background: var(--surface);\n  border: 1px solid var(--border);\n  font-size: 12.5px;\n  color: var(--text-2);\n  box-shadow: var(--shadow-xs);\n}\n.attachment .size { color: var(--muted); font-size: 11.5px; }\n.mail-notice {\n  margin-top: 14px;\n  padding: 9px 12px;\n  border-radius: 10px;\n  background: var(--surface-2);\n  border: 1px dashed var(--border-strong);\n  font-size: 12.5px;\n  color: var(--text-2);\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n.mail-notice button { color: var(--accent); font-weight: 600; font-size: 12.5px; }\n/* 提醒条紧贴在正文上方时，两侧留白要收一收，避免正文被推得太开 */\n.mail-notice + .mail-paper { margin-top: 12px; }\n\n/* ---- 设置 / 管理 ---- */\n.page-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 26px 28px 60px; }\n.page-inner { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }\n.page-title { margin: 0; font-size: 20px; font-weight: 680; letter-spacing: -0.02em; }\n.page-sub { margin: -12px 0 0; font-size: 13px; color: var(--muted); }\n\n.card {\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: var(--radius-lg);\n  overflow: hidden;\n}\n.card-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 16px 20px;\n  border-bottom: 1px solid var(--border);\n}\n.card-head h3 { margin: 0; font-size: 14px; font-weight: 650; }\n.card-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }\n.card-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; }\n.card-body.tight { padding: 0; }\n\n.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }\n.form-actions { display: flex; gap: 8px; justify-content: flex-end; padding-top: 2px; }\n\n.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }\n.stat {\n  padding: 14px 16px;\n  border-radius: var(--radius);\n  background: var(--surface);\n  border: 1px solid var(--border);\n}\n.stat .label { font-size: 12px; color: var(--muted); }\n.stat .value { margin-top: 4px; font-size: 22px; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }\n\n.table-wrap { overflow-x: auto; }\ntable.data { width: 100%; border-collapse: collapse; font-size: 13px; }\ntable.data th {\n  padding: 10px 16px;\n  text-align: left;\n  font-size: 11.5px;\n  font-weight: 600;\n  letter-spacing: 0.04em;\n  text-transform: uppercase;\n  color: var(--muted);\n  background: var(--surface-2);\n  border-bottom: 1px solid var(--border);\n  white-space: nowrap;\n}\ntable.data td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }\ntable.data tr:last-child td { border-bottom: 0; }\ntable.data tbody tr:hover { background: var(--surface-2); }\ntable.data .cell-user { display: flex; align-items: center; gap: 10px; min-width: 0; }\ntable.data .cell-user .u-name { font-weight: 600; }\ntable.data .cell-user .u-mail { font-size: 11.5px; color: var(--muted); }\ntable.data .row-actions { display: flex; gap: 4px; justify-content: flex-end; }\ntable.data .mono { font-family: var(--mono); font-size: 12px; color: var(--muted); }\n\n.list-rows { display: flex; flex-direction: column; }\n.row-item {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 12px 20px;\n  border-bottom: 1px solid var(--border);\n}\n.row-item:last-child { border-bottom: 0; }\n.row-item .row-main { flex: 1; min-width: 0; }\n.row-item .row-title { font-size: 13.5px; font-weight: 600; }\n.row-item .row-desc { font-size: 12px; color: var(--muted); margin-top: 1px; }\n\n.steps { counter-reset: step; display: flex; flex-direction: column; gap: 14px; padding: 0; margin: 0; list-style: none; }\n.steps li { position: relative; padding-left: 34px; font-size: 13px; color: var(--text-2); line-height: 1.65; }\n.steps li::before {\n  counter-increment: step;\n  content: counter(step);\n  position: absolute;\n  left: 0;\n  top: 0;\n  display: grid;\n  place-items: center;\n  width: 22px;\n  height: 22px;\n  border-radius: 50%;\n  background: var(--accent-soft);\n  color: var(--accent-text);\n  font-size: 11.5px;\n  font-weight: 700;\n}\n.steps code, .code-inline {\n  font-family: var(--mono);\n  font-size: 12px;\n  padding: 1.5px 5px;\n  border-radius: 5px;\n  background: var(--surface-3);\n  color: var(--text);\n}\npre.code-block {\n  margin: 0;\n  padding: 14px 16px;\n  border-radius: 10px;\n  background: var(--surface-2);\n  border: 1px solid var(--border);\n  font-family: var(--mono);\n  font-size: 12.5px;\n  line-height: 1.7;\n  overflow-x: auto;\n  color: var(--text-2);\n}\n\n/* ---- 垃圾箱提示 / 右键菜单 ---- */\n.trash-hint {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin: 0 14px 10px;\n  padding: 8px 11px;\n  border-radius: 9px;\n  background: var(--surface-2);\n  border: 1px solid var(--border);\n  font-size: 11.5px;\n  line-height: 1.5;\n  color: var(--muted);\n}\n.trash-hint svg { flex: none; color: var(--accent-text); }\n\n.ctx-menu {\n  position: fixed;\n  z-index: 90;\n  min-width: 186px;\n  padding: 5px;\n  border-radius: 12px;\n  background: var(--surface);\n  border: 1px solid var(--border);\n  box-shadow: var(--shadow-lg);\n  animation: ctx-in 0.12s ease;\n}\n@keyframes ctx-in { from { opacity: 0; transform: scale(0.97) translateY(-3px); } }\n.ctx-item {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  width: 100%;\n  padding: 8px 10px;\n  border: 0;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--text);\n  font-size: 13px;\n  font-family: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n.ctx-item svg { flex: none; color: var(--muted); }\n.ctx-item:hover { background: var(--surface-2); }\n.ctx-item.is-danger { color: var(--danger); }\n.ctx-item.is-danger svg { color: var(--danger); }\n.ctx-item.is-danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }\n\n/* ---- 弹窗 ---- */\n.modal-backdrop {\n  position: fixed;\n  inset: 0;\n  z-index: 60;\n  display: grid;\n  place-items: center;\n  padding: 24px;\n  background: color-mix(in srgb, #000 42%, transparent);\n  backdrop-filter: blur(3px);\n  animation: fade-in 0.16s ease;\n}\n@keyframes fade-in { from { opacity: 0; } }\n.modal {\n  width: 100%;\n  max-width: 560px;\n  max-height: calc(100dvh - 48px);\n  display: flex;\n  flex-direction: column;\n  background: var(--surface);\n  border: 1px solid var(--border);\n  border-radius: 18px;\n  box-shadow: var(--shadow-lg);\n  animation: modal-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1);\n  overflow: hidden;\n}\n.modal.wide { max-width: 680px; }\n.modal.narrow { max-width: 440px; }\n@keyframes modal-in {\n  from { opacity: 0; transform: translateY(8px) scale(0.985); }\n}\n.modal-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 16px 18px 14px 22px;\n  border-bottom: 1px solid var(--border);\n}\n.modal-head h3 { margin: 0; font-size: 15px; font-weight: 650; }\n.modal-body { padding: 20px 22px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }\n.modal-foot {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 14px 18px;\n  border-top: 1px solid var(--border);\n  background: var(--surface-2);\n}\n.modal-foot .spacer { flex: 1; }\n\n/* ---- Toast ---- */\n.toasts {\n  position: fixed;\n  left: 50%;\n  bottom: 26px;\n  translate: -50% 0;\n  z-index: 90;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 8px;\n  pointer-events: none;\n}\n.toast {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  max-width: min(90vw, 460px);\n  padding: 10px 15px;\n  border-radius: 11px;\n  background: color-mix(in srgb, var(--text) 92%, transparent);\n  color: var(--surface);\n  font-size: 13px;\n  font-weight: 500;\n  box-shadow: var(--shadow-md);\n  animation: toast-in 0.2s cubic-bezier(0.2, 0.9, 0.3, 1);\n  line-height: 1.45;\n}\n.toast.is-danger { background: var(--danger); color: #fff; }\n.toast.is-success { background: #0f7a52; color: #fff; }\n.toast.is-out { animation: toast-out 0.18s ease forwards; }\n@keyframes toast-in { from { opacity: 0; transform: translateY(10px); } }\n@keyframes toast-out { to { opacity: 0; transform: translateY(6px); } }\n\n/* ---- 骨架屏 ---- */\n.skeleton { background: var(--surface-2); border-radius: 7px; animation: pulse 1.4s ease-in-out infinite; }\n@keyframes pulse { 50% { opacity: 0.5; } }\n.sk-item { display: flex; flex-direction: column; gap: 7px; padding: 13px 16px; }\n.sk-line { height: 10px; }\n\n/* ============ 响应式 ============ */\n@media (max-width: 1080px) {\n  :root { --list-w: 300px; }\n  .reader-scroll { padding: 24px 20px 50px; }\n  .page-scroll { padding: 20px 20px 50px; }\n}\n\n@media (max-width: 900px) {\n  .shell { grid-template-columns: var(--rail-w) minmax(0, 1fr); }\n  .reader {\n    position: fixed;\n    inset: 0 0 0 var(--rail-w);\n    z-index: 40;\n    display: none;\n    background: var(--bg);\n    box-shadow: var(--shadow-lg);\n  }\n  .shell.reader-open .reader { display: flex; }\n  .reader-back { display: inline-grid; }\n  .list-pane { border-right: 0; }\n  .form-grid { grid-template-columns: minmax(0, 1fr); }\n}\n\n@media (max-width: 640px) {\n  :root { --rail-w: 0px; --header-h: 56px; }\n  .shell { grid-template-columns: minmax(0, 1fr); }\n  .rail {\n    position: fixed;\n    left: 0;\n    right: 0;\n    bottom: 0;\n    top: auto;\n    flex-direction: row;\n    justify-content: space-around;\n    gap: 0;\n    height: 62px;\n    padding: 0 6px calc(0px + env(safe-area-inset-bottom));\n    border-right: 0;\n    border-top: 1px solid var(--border);\n    z-index: 50;\n  }\n  .rail .brand-mark, .rail-user { display: none; }\n  .rail-nav { flex-direction: row; justify-content: space-around; margin: 0; gap: 0; }\n  .rail-spacer { display: none; }\n  .rail-btn { width: 52px; height: 46px; }\n  .rail-btn[data-tip]::after { display: none; }\n  .rail-btn .rail-badge { top: 3px; right: 8px; }\n  .list-pane { border-right: 0; padding-bottom: 62px; }\n  .mail-list { padding-bottom: 8px; }\n  .reader { inset: 0; padding-bottom: 0; }\n  .reader-bar { padding: 0 8px; }\n  .reader-scroll { padding: 18px 16px 40px; }\n  .page-scroll { padding: 16px 16px 40px; }\n  .shell--page .reader { padding-bottom: 62px; }\n  .mail-head h1 { font-size: 19px; }\n  .auth-card { padding: 26px 22px 22px; border-radius: 18px; }\n  .modal-backdrop { padding: 12px; align-items: end; }\n  .modal { max-height: calc(100dvh - 24px); border-radius: 18px; }\n  .toasts { bottom: 78px; }\n  .mail-meta { align-items: flex-start; }\n  .form-actions { flex-direction: column-reverse; }\n  .form-actions .btn { width: 100%; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }\n}</style>\n</head>\n<body>\n  <div id=\"app\" class=\"app-root\"></div>\n  <div id=\"toasts\" class=\"toasts\" aria-live=\"polite\" aria-atomic=\"false\"></div>\n  <div id=\"modal-root\"></div>\n  <script>/**\n * Cloud Mail 前端：零框架、单文件、事件委托驱动。\n * 通过 /api/* 与 Worker 通信，令牌保存在 localStorage。\n */\n(() => {\n  'use strict';\n\n  /* ==================== 基础工具 ==================== */\n\n  const $ = (sel, root = document) => root.querySelector(sel);\n  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));\n\n  const ICONS = {\n    mail: '<rect x=\"2.5\" y=\"4.5\" width=\"19\" height=\"15\" rx=\"2.6\"/><path d=\"m3.4 6.8 7.8 5.5a1.4 1.4 0 0 0 1.6 0l7.8-5.5\"/>',\n    'mail-open': '<path d=\"M3 10.3 12 3l9 7.3V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8.7Z\"/><path d=\"m3 10.3 9 6.2 9-6.2\"/>',\n    star: '<path d=\"m12 3.7 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.7Z\"/>',\n    send: '<path d=\"M21.4 2.6 10.7 13.3\"/><path d=\"M21.4 2.6 14.7 21l-4-8.1-8.1-4 18.8-6.3Z\"/>',\n    reply: '<path d=\"M9.4 5.6 4 11l5.4 5.4\"/><path d=\"M4 11h9a7 7 0 0 1 7 7v1\"/>',\n    trash: '<path d=\"M4 7h16\"/><path d=\"M9.2 7V5.3A1.3 1.3 0 0 1 10.5 4h3a1.3 1.3 0 0 1 1.3 1.3V7\"/><path d=\"m6.4 7 .8 12.1a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9L17.6 7\"/><path d=\"M10.4 11v6M13.6 11v6\"/>',\n    settings: '<circle cx=\"12\" cy=\"12\" r=\"3.1\"/><path d=\"M19.2 14.6a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z\"/>',\n    users: '<path d=\"M16 20.5v-1.7a3.5 3.5 0 0 0-3.5-3.5H6.5A3.5 3.5 0 0 0 3 18.8v1.7\"/><circle cx=\"9.5\" cy=\"8\" r=\"3.6\"/><path d=\"M21 20.5v-1.7a3.5 3.5 0 0 0-2.6-3.4\"/><path d=\"M16.4 4.7a3.6 3.6 0 0 1 0 6.9\"/>',\n    search: '<circle cx=\"11\" cy=\"11\" r=\"6.4\"/><path d=\"m15.8 15.8 4.6 4.6\"/>',\n    x: '<path d=\"M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8\"/>',\n    refresh: '<path d=\"M20 11.2A8 8 0 1 0 17.6 17\"/><path d=\"M20 4.6v6.6h-6.6\"/>',\n    pencil: '<path d=\"M4 20h4L18.6 9.4a2.1 2.1 0 0 0-3-3L5 17v3Z\"/><path d=\"m14.4 5.6 3 3\"/>',\n    back: '<path d=\"m15 5-7 7 7 7\"/>',\n    paperclip: '<path d=\"M20.4 11.6 12 20a4.9 4.9 0 0 1-7-6.9l8-8a3.3 3.3 0 0 1 4.7 4.6l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3\"/>',\n    logout: '<path d=\"M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5\"/><path d=\"m15 8 4 4-4 4\"/><path d=\"M19 12H9.5\"/>',\n    sun: '<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/>',\n    moon: '<path d=\"M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z\"/>',\n    monitor: '<rect x=\"3\" y=\"4\" width=\"18\" height=\"12.5\" rx=\"2.2\"/><path d=\"M8.5 20.5h7M12 16.5v4\"/>',\n    plus: '<path d=\"M12 5.2v13.6M5.2 12h13.6\"/>',\n    key: '<circle cx=\"8\" cy=\"15.8\" r=\"3.6\"/><path d=\"m10.6 13.2 6.6-6.6\"/><path d=\"m15.4 8.4 2.2 2.2\"/><path d=\"m17.6 6.2 2.2 2.2\"/>',\n    shield: '<path d=\"M12 3 5 5.4v6c0 4.4 3 7.4 7 9.6 4-2.2 7-5.2 7-9.6v-6L12 3Z\"/><path d=\"m9.2 11.8 2 2 3.6-3.9\"/>',\n    alert: '<path d=\"M10.3 4.4 2.7 17.6a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z\"/><path d=\"M12 9.4v4.2\"/><circle cx=\"12\" cy=\"17\" r=\".7\" fill=\"currentColor\" stroke=\"none\"/>',\n    check: '<path d=\"m5 12.6 4.6 4.6L19 7.4\"/>',\n    image: '<rect x=\"3\" y=\"4.5\" width=\"18\" height=\"15\" rx=\"2.4\"/><circle cx=\"8.4\" cy=\"10\" r=\"1.6\"/><path d=\"m3.8 18 5-4.6 3.7 2.9 3-2.6 4.7 4.3\"/>',\n    info: '<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11.2v5.4\"/><circle cx=\"12\" cy=\"7.8\" r=\".75\" fill=\"currentColor\" stroke=\"none\"/>',\n  };\n\n  function icon(name, size = 18, extraClass = '') {\n    const body = ICONS[name] || '';\n    return `<svg class=\"${extraClass}\" width=\"${size}\" height=\"${size}\" viewBox=\"0 0 24 24\" fill=\"none\"\n      stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"\n      aria-hidden=\"true\" focusable=\"false\">${body}</svg>`;\n  }\n\n  /** 读取表单字段值（避免与 HTMLFormElement 自身属性同名冲突）。 */\n  function fv(form, name) {\n    const field = form.elements.namedItem(name);\n    return field && 'value' in field ? field.value : '';\n  }\n\n  function esc(value) {\n    return String(value == null ? '' : value)\n      .replace(/&/g, '&amp;')\n      .replace(/</g, '&lt;')\n      .replace(/>/g, '&gt;')\n      .replace(/\"/g, '&quot;')\n      .replace(/'/g, '&#39;');\n  }\n\n  function initials(name, email) {\n    const source = String(name || '').trim() || String(email || '').split('@')[0] || '?';\n    const parts = source.split(/[\\s._-]+/).filter(Boolean);\n    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();\n    return source.slice(0, 2).toUpperCase();\n  }\n\n  const AVATAR_COLORS = [\n    ['#6366f1', '#4338ca'],\n    ['#0ea5e9', '#0369a1'],\n    ['#10b981', '#047857'],\n    ['#f59e0b', '#b45309'],\n    ['#ec4899', '#be185d'],\n    ['#8b5cf6', '#6d28d9'],\n    ['#14b8a6', '#0f766e'],\n    ['#ef4444', '#b91c1c'],\n  ];\n\n  function avatarStyle(seed) {\n    const text = String(seed || '');\n    let hash = 0;\n    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000;\n    const [a, b] = AVATAR_COLORS[hash % AVATAR_COLORS.length];\n    return `background:linear-gradient(145deg,${a},${b})`;\n  }\n\n  function avatar(name, email, size = '') {\n    const cls = `avatar ${size}`.trim();\n    return `<span class=\"${cls}\" style=\"${avatarStyle(email || name)}\" aria-hidden=\"true\">${esc(initials(name, email))}</span>`;\n  }\n\n  function fmtDate(iso) {\n    if (!iso) return '';\n    const date = new Date(iso);\n    if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16);\n    const now = new Date();\n    const sameDay = date.toDateString() === now.toDateString();\n    const pad = (n) => String(n).padStart(2, '0');\n    if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;\n    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;\n    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;\n  }\n\n  function fmtFull(iso) {\n    if (!iso) return '';\n    const date = new Date(iso);\n    if (Number.isNaN(date.getTime())) return String(iso);\n    const pad = (n) => String(n).padStart(2, '0');\n    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;\n  }\n\n  function fmtBytes(bytes) {\n    const size = Number(bytes || 0);\n    if (!size) return '';\n    if (size < 1024) return `${size} B`;\n    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;\n    return `${(size / 1024 / 1024).toFixed(1)} MB`;\n  }\n\n  const SUBJECT_FALLBACK = '(无主题)';\n\n  function displayName(name, email) {\n    return String(name || '').trim() || String(email || '').split('@')[0] || '未知发件人';\n  }\n\n  /* ==================== 状态 ==================== */\n\n  const LS_TOKEN = 'cm.token';\n  const LS_THEME = 'cm.theme';\n  const LS_LAST = 'cm.lastAddress';\n\n  const state = {\n    token: localStorage.getItem(LS_TOKEN) || '',\n    theme: localStorage.getItem(LS_THEME) || 'auto',\n    user: null,\n    domain: '',\n    domainSource: '',\n    mailbox: '',\n    canSendAs: false,\n    trashTtlDays: 30,\n    mailRetention: 0,\n    keys: [],\n    counts: { inbox: 0, unread: 0, starred: 0, trash: 0, sent: 0 },\n    setup: { needsSetup: false, userCount: 0, defaultAdmin: '' },\n    view: 'inbox',\n    q: '',\n    unreadOnly: false,\n    page: 1,\n    pageSize: 25,\n    items: [],\n    total: 0,\n    listLoading: false,\n    listSeq: 0,\n    selectedId: null,\n    mail: null,\n    mailLoading: false,\n    allowImages: false,\n    modal: null,\n  };\n\n  const VIEW_META = {\n    inbox: { title: '收件箱', box: 'inbox' },\n    starred: { title: '星标', box: 'starred' },\n    sent: { title: '已发送', box: 'sent' },\n    trash: { title: '垃圾箱', box: 'trash' },\n    settings: { title: '设置' },\n    admin: { title: '账号管理' },\n  };\n\n  const isPageView = () => state.view === 'settings' || state.view === 'admin';\n\n  /* ==================== 主题 ==================== */\n\n  function applyTheme(theme) {\n    state.theme = ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';\n    document.documentElement.dataset.theme = state.theme;\n    localStorage.setItem(LS_THEME, state.theme);\n    const next = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';\n    $$('[data-theme-toggle]').forEach((btn) => {\n      btn.innerHTML = icon(state.theme === 'auto' ? 'monitor' : state.theme === 'dark' ? 'moon' : 'sun', 17);\n      btn.title = `切换主题（当前：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[state.theme]}）`;\n      btn.dataset.nextTheme = next;\n    });\n  }\n\n  /* ==================== 网络 ==================== */\n\n  async function api(path, options = {}) {\n    const { method = 'GET', body, auth = true } = options;\n    const headers = { accept: 'application/json' };\n    if (body !== undefined) headers['content-type'] = 'application/json';\n    if (auth && state.token) headers.authorization = `Bearer ${state.token}`;\n\n    let response;\n    try {\n      response = await fetch(path, {\n        method,\n        headers,\n        body: body === undefined ? undefined : JSON.stringify(body),\n      });\n    } catch {\n      throw new Error('网络连接失败，请检查网络后重试');\n    }\n\n    let data = null;\n    try {\n      data = await response.json();\n    } catch {\n      data = null;\n    }\n\n    if (!response.ok || (data && data.ok === false)) {\n      const error = new Error((data && data.error && data.error.message) || `请求失败（${response.status}）`);\n      error.code = data && data.error ? data.error.code : 'http_error';\n      error.status = response.status;\n      if (response.status === 401 && auth && state.token) handleSessionExpired();\n      throw error;\n    }\n    return data || {};\n  }\n\n  /* ==================== 提示 ==================== */\n\n  function toast(message, type = 'info') {\n    const root = $('#toasts');\n    if (!root) return;\n    const node = document.createElement('div');\n    node.className = `toast${type === 'danger' ? ' is-danger' : type === 'success' ? ' is-success' : ''}`;\n    node.innerHTML = `${icon(type === 'danger' ? 'alert' : type === 'success' ? 'check' : 'info', 17)}<span>${esc(message)}</span>`;\n    root.appendChild(node);\n    setTimeout(() => {\n      node.classList.add('is-out');\n      setTimeout(() => node.remove(), 220);\n    }, 3200);\n  }\n\n  /* ==================== 弹窗 ==================== */\n\n  function openModal({ title, body, footer = '', size = '', onMount }) {\n    closeModal();\n    const root = $('#modal-root');\n    root.innerHTML = `\n      <div class=\"modal-backdrop\" data-action=\"modal-backdrop\">\n        <div class=\"modal ${size}\" role=\"dialog\" aria-modal=\"true\" aria-label=\"${esc(title)}\">\n          <div class=\"modal-head\">\n            <h3>${esc(title)}</h3>\n            <button class=\"icon-btn\" data-action=\"modal-close\" aria-label=\"关闭\">${icon('x')}</button>\n          </div>\n          <div class=\"modal-body\">${body}</div>\n          ${footer ? `<div class=\"modal-foot\">${footer}</div>` : ''}\n        </div>\n      </div>`;\n    state.modal = root.firstElementChild;\n    const focusTarget = $('input:not([type=hidden]), textarea, select', state.modal);\n    if (focusTarget) setTimeout(() => focusTarget.focus(), 40);\n    if (onMount) onMount(state.modal);\n  }\n\n  function closeModal() {\n    const root = $('#modal-root');\n    if (root) root.innerHTML = '';\n    state.modal = null;\n  }\n\n  function confirmDialog({ title = '确认操作', message, confirmText = '确认', danger = false }) {\n    return new Promise((resolve) => {\n      openModal({\n        title,\n        size: 'narrow',\n        body: `<p style=\"margin:0;color:var(--text-2);font-size:13.5px;line-height:1.7\">${esc(message)}</p>`,\n        footer: `\n          <div class=\"spacer\"></div>\n          <button class=\"btn btn-ghost\" data-action=\"modal-close\">取消</button>\n          <button class=\"btn ${danger ? 'btn-danger' : 'btn-primary'}\" data-action=\"confirm-ok\">${esc(confirmText)}</button>`,\n        onMount(node) {\n          $('[data-action=\"confirm-ok\"]', node).addEventListener('click', () => {\n            closeModal();\n            resolve(true);\n          });\n          node.addEventListener('click', (event) => {\n            if (event.target === node) {\n              closeModal();\n              resolve(false);\n            }\n          });\n          $('[data-action=\"modal-close\"]', node).addEventListener('click', () => resolve(false));\n        },\n      });\n    });\n  }\n\n  /* ==================== 登录 / 初始化 ==================== */\n\n  function authError(node, message) {\n    const box = $('.auth-error', node);\n    if (!box) return;\n    box.textContent = message;\n    box.classList.toggle('is-visible', Boolean(message));\n  }\n\n  /** 地址输入框：识别到域名时只填前缀，域名作为后缀自动补齐。 */\n  function addressInput({ id, name, label, value = '', placeholder = '前缀', autocomplete = 'username', hint = '', disabled = false }) {\n    const field = `${label ? `<label for=\"${id}\">${label}</label>` : ''}`;\n    if (state.domain) {\n      return `<div class=\"field\">\n        ${field}\n        <div class=\"input-group\">\n          <input id=\"${id}\" class=\"input\" name=\"${name}\" type=\"text\" inputmode=\"email\" autocomplete=\"${autocomplete}\"\n            value=\"${esc(value)}\" placeholder=\"${esc(placeholder)}\" ${disabled ? 'disabled' : 'required'} />\n          <span class=\"affix\">@${esc(state.domain)}</span>\n        </div>\n        ${hint ? `<span class=\"hint\">${hint}</span>` : ''}\n      </div>`;\n    }\n    return `<div class=\"field\">\n      ${field}\n      <input id=\"${id}\" class=\"input\" name=\"${name}\" type=\"text\" inputmode=\"email\" autocomplete=\"${autocomplete}\"\n        value=\"${esc(value)}\" placeholder=\"${esc(placeholder === '前缀' ? 'admin@example.com' : placeholder)}\" ${disabled ? 'disabled' : 'required'} />\n      ${hint ? `<span class=\"hint\">${hint}</span>` : ''}\n    </div>`;\n  }\n\n  /** 把完整地址按当前域名拆成前缀，用于输入框回填。 */\n  function prefixOfAddress(address) {\n    const text = String(address || '').trim();\n    if (!text) return '';\n    if (!state.domain) return text;\n    const suffix = `@${state.domain}`.toLowerCase();\n    return text.toLowerCase().endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text;\n  }\n\n  /** 输入框里的内容 → 完整地址：只填前缀就自动补上 @域名。 */\n  function addressValueOf(raw) {\n    const text = String(raw || '').trim();\n    if (!text) return '';\n    if (text.includes('@')) return text;\n    return state.domain ? `${text}@${state.domain}` : text;\n  }\n\n  /** 记住上次登录的地址，下次打开登录页自动填上（只填前缀部分）。 */\n  function rememberedAddress() {\n    const saved = localStorage.getItem(LS_LAST) || '';\n    if (!saved) return '';\n    if (!state.domain) return saved;\n    const suffix = `@${state.domain}`.toLowerCase();\n    return saved.toLowerCase().endsWith(suffix) ? saved.slice(0, saved.length - suffix.length) : saved;\n  }\n\n  function rememberAddress(email) {\n    try {\n      if (email) localStorage.setItem(LS_LAST, email);\n    } catch {\n      /* 隐私模式下写不进去就算了 */\n    }\n  }\n\n  function domainHint(extra = '') {\n    if (state.domain) {\n      return `收件域名 ${esc(state.domain)} 已自动识别${extra ? `，${extra}` : ''}`;\n    }\n    return '暂时无法识别收件域名：可以填完整地址，或在 wrangler.toml 里设置 MAIL_DOMAIN（收到第一封邮件后也会自动识别）';\n  }\n\n  function renderAuth() {\n    const setup = state.setup.needsSetup;\n    const themeBtn = `<button class=\"icon-btn auth-theme\" data-action=\"toggle-theme\" data-theme-toggle aria-label=\"切换主题\"></button>`;\n    app().innerHTML = `\n      <div class=\"auth-screen\">\n        ${themeBtn}\n        <div class=\"auth-card\">\n          <div class=\"auth-head\">\n            <span class=\"brand-mark\">${icon('mail', 21)}</span>\n            <div>\n              <h1>${setup ? '初始化 Cloud Mail' : 'Cloud Mail'}</h1>\n              <p>${setup ? '创建第一个管理员账号' : `登录你的邮箱${state.domain ? ` · @${esc(state.domain)}` : ''}`}</p>\n            </div>\n          </div>\n          ${\n            setup\n              ? `\n          <form class=\"auth-form\" data-form=\"setup\" novalidate>\n            <div class=\"auth-error\"></div>\n            <div class=\"field\">\n              <label for=\"setup-name\">显示名称</label>\n              <input id=\"setup-name\" class=\"input\" name=\"name\" autocomplete=\"name\" placeholder=\"例如：林可\" />\n            </div>\n            ${addressInput({\n              id: 'setup-email',\n              name: 'email',\n              label: '管理员邮箱',\n              value: state.setup.defaultAdmin ? state.setup.defaultAdmin.split('@')[0] : 'admin',\n              placeholder: 'admin',\n              hint: domainHint('管理员默认使用这个地址，需已在 Email Routing 中启用'),\n            })}\n            <div class=\"field\">\n              <label for=\"setup-password\">登录密码</label>\n              <input id=\"setup-password\" class=\"input\" name=\"password\" type=\"password\" autocomplete=\"new-password\"\n                placeholder=\"至少 8 位\" required />\n            </div>\n            <div class=\"field\">\n              <label for=\"setup-confirm\">确认密码</label>\n              <input id=\"setup-confirm\" class=\"input\" name=\"confirm\" type=\"password\" autocomplete=\"new-password\" required />\n            </div>\n            <button class=\"btn btn-primary btn-block\" type=\"submit\">创建管理员账号</button>\n          </form>\n          <div class=\"auth-foot\">数据表会在首次运行时自动创建，无需手动执行 SQL。</div>`\n              : `\n          <form class=\"auth-form\" data-form=\"login\" novalidate>\n            <div class=\"auth-error\"></div>\n            ${addressInput({\n              id: 'login-email',\n              name: 'email',\n              label: '邮箱地址',\n              value: rememberedAddress(),\n              placeholder: state.domain ? '前缀，如 admin' : 'admin@example.com',\n              hint: state.domain ? `${esc(state.domain)} 已自动识别，只填 @ 前面的部分` : '',\n            })}\n            <div class=\"field\">\n              <label for=\"login-password\">密码</label>\n              <input id=\"login-password\" class=\"input\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required />\n            </div>\n            <button class=\"btn btn-primary btn-block\" type=\"submit\">登录</button>\n          </form>\n          <div class=\"auth-foot\">忘记密码？请让管理员在「账号管理」中重置。</div>`\n          }\n        </div>\n      </div>`;\n    applyTheme(state.theme);\n    const first = $('input', app());\n    if (first) setTimeout(() => first.focus(), 60);\n  }\n\n  async function submitLogin(form) {\n    const submitBtn = $('button[type=submit]', form);\n    authError(form, '');\n    submitBtn.disabled = true;\n    const original = submitBtn.textContent;\n    submitBtn.textContent = '登录中…';\n    try {\n      const data = await api('/api/auth/login', {\n        method: 'POST',\n        auth: false,\n        body: {\n          email: fv(form, 'email').trim(),\n          password: fv(form, 'password'),\n        },\n      });\n      state.token = data.token;\n      localStorage.setItem(LS_TOKEN, data.token);\n      rememberAddress(data.user && data.user.email);\n      await bootApp(data.user);\n    } catch (error) {\n      authError(form, error.message);\n      submitBtn.disabled = false;\n      submitBtn.textContent = original;\n    }\n  }\n\n  async function submitSetup(form) {\n    const submitBtn = $('button[type=submit]', form);\n    authError(form, '');\n    if (fv(form, 'password') !== fv(form, 'confirm')) {\n      authError(form, '两次输入的密码不一致');\n      return;\n    }\n    if (String(fv(form, 'password')).length < 8) {\n      authError(form, '密码至少需要 8 位');\n      return;\n    }\n    submitBtn.disabled = true;\n    const original = submitBtn.textContent;\n    submitBtn.textContent = '创建中…';\n    try {\n      const data = await api('/api/setup', {\n        method: 'POST',\n        auth: false,\n        body: {\n          name: fv(form, 'name').trim(),\n          email: fv(form, 'email').trim(),\n          password: fv(form, 'password'),\n        },\n      });\n      state.token = data.token;\n      localStorage.setItem(LS_TOKEN, data.token);\n      rememberAddress(data.user && data.user.email);\n      state.setup.needsSetup = false;\n      toast('初始化完成，欢迎使用 Cloud Mail', 'success');\n      await bootApp(data.user);\n    } catch (error) {\n      authError(form, error.message);\n      submitBtn.disabled = false;\n      submitBtn.textContent = original;\n    }\n  }\n\n  /* ==================== 主界面骨架 ==================== */\n\n  function app() {\n    return $('#app');\n  }\n\n  function shell() {\n    return $('.shell');\n  }\n\n  function railBadge(count) {\n    if (!count) return '';\n    return `<span class=\"rail-badge\">${count > 99 ? '99+' : count}</span>`;\n  }\n\n  function renderShell() {\n    const user = state.user || {};\n    const meta = VIEW_META[state.view] || VIEW_META.inbox;\n    app().innerHTML = `\n      <div class=\"shell${isPageView() ? ' shell--page' : ''}\">\n        <aside class=\"rail\">\n          <span class=\"brand-mark\" title=\"Cloud Mail\">${icon('mail', 21)}</span>\n          <nav class=\"rail-nav\" aria-label=\"主导航\">\n            ${railButton('inbox', 'mail', '收件箱', state.counts.unread)}\n            ${railButton('starred', 'star', '星标')}\n            ${railButton('sent', 'send', '已发送')}\n            ${railButton('trash', 'trash', '垃圾箱')}\n            <div class=\"rail-spacer\"></div>\n            ${user.role === 'admin' ? railButton('admin', 'users', '账号管理') : ''}\n            ${railButton('settings', 'settings', '设置')}\n          </nav>\n          <div class=\"rail-user\">\n            <button data-action=\"user-menu\" aria-label=\"账户\">${avatar(user.name, user.email)}</button>\n          </div>\n        </aside>\n\n        <section class=\"list-pane\" aria-label=\"${esc(meta.title)}\">\n          <header class=\"list-head\">\n            <h2>${esc(meta.title)}</h2>\n            <div class=\"head-actions\">\n              ${state.view === 'trash' ? `<button class=\"icon-btn\" data-action=\"empty-trash\" title=\"清空垃圾箱\">${icon('trash')}</button>` : ''}\n              <button class=\"icon-btn\" data-action=\"compose\" title=\"写邮件\">${icon('pencil')}</button>\n              <button class=\"icon-btn\" data-action=\"refresh\" title=\"刷新\">${icon('refresh')}</button>\n            </div>\n          </header>\n          <div class=\"search-wrap\">\n            ${icon('search', 15)}\n            <input id=\"search\" class=\"search-input\" type=\"search\" placeholder=\"搜索邮件…\" autocomplete=\"off\"\n              value=\"${esc(state.q)}\" aria-label=\"搜索邮件\" />\n            ${state.q ? `<button class=\"search-clear\" data-action=\"clear-search\" aria-label=\"清除\">${icon('x', 13)}</button>` : ''}\n          </div>\n          <div class=\"chips\">\n            <button class=\"chip${state.unreadOnly ? '' : ' is-active'}\" data-action=\"chip-all\">全部</button>\n            <button class=\"chip${state.unreadOnly ? ' is-active' : ''}\" data-action=\"chip-unread\">未读</button>\n          </div>\n          ${state.view === 'trash' ? `<p class=\"trash-hint\">${icon('info', 13)}<span>垃圾箱邮件保留 ${state.trashTtlDays} 天后自动清除，右键可恢复</span></p>` : ''}\n          <div class=\"mail-list\" id=\"mail-list\"></div>\n        </section>\n\n        <main class=\"reader\" id=\"reader\"></main>\n      </div>`;\n    applyTheme(state.theme);\n    renderList();\n    renderReader();\n  }\n\n  function railButton(view, iconName, label, badge = 0) {\n    const active = state.view === view ? ' is-active' : '';\n    return `<button class=\"rail-btn${active}\" data-action=\"nav\" data-view=\"${view}\" data-tip=\"${label}\" aria-label=\"${label}\"\n      ${active ? 'aria-current=\"page\"' : ''}>${icon(iconName, 20)}${railBadge(badge)}</button>`;\n  }\n\n  function updateRail() {\n    if (!shell() || isPageView()) return;\n    $$('.rail-btn', shell()).forEach((btn) => {\n      const active = btn.dataset.view === state.view;\n      btn.classList.toggle('is-active', active);\n      const badge = $('.rail-badge', btn);\n      if (btn.dataset.view === 'inbox') {\n        if (state.counts.unread > 0) {\n          if (badge) badge.textContent = state.counts.unread > 99 ? '99+' : String(state.counts.unread);\n          else btn.insertAdjacentHTML('beforeend', railBadge(state.counts.unread));\n        } else if (badge) {\n          badge.remove();\n        }\n      }\n    });\n    document.title = state.counts.unread > 0 ? `(${state.counts.unread}) Cloud Mail` : 'Cloud Mail';\n  }\n\n  /* ==================== 列表 ==================== */\n\n  function renderList() {\n    const list = $('#mail-list');\n    if (!list) return;\n    if (state.listLoading && state.items.length === 0) {\n      list.innerHTML = Array.from({ length: 7 })\n        .map(\n          () => `<div class=\"sk-item\">\n            <div class=\"skeleton sk-line\" style=\"width:38%\"></div>\n            <div class=\"skeleton sk-line\" style=\"width:82%\"></div>\n            <div class=\"skeleton sk-line\" style=\"width:64%\"></div>\n          </div>`,\n        )\n        .join('');\n      return;\n    }\n    if (state.items.length === 0) {\n      list.innerHTML = emptyListHtml();\n      return;\n    }\n    const rows = state.items.map(mailItemHtml).join('');\n    const more =\n      state.items.length < state.total\n        ? `<div class=\"list-more\"><button data-action=\"load-more\">加载更多（还有 ${state.total - state.items.length} 封）</button></div>`\n        : '';\n    list.innerHTML = rows + more;\n    highlightActive();\n  }\n\n  function emptyListHtml() {\n    const isSearch = Boolean(state.q);\n    const messages = {\n      inbox: isSearch ? '没有匹配的邮件' : '收件箱空空如也',\n      starred: '还没有星标邮件',\n      sent: '还没有发送记录',\n      trash: '垃圾箱是空的',\n    };\n    const hints = {\n      inbox: isSearch ? '换个关键词试试' : `发送到 @${state.domain || '你的域名'} 的邮件会出现在这里`,\n      starred: '在阅读邮件时点击星标图标即可收藏',\n      sent: '点击右上角的铅笔图标写第一封邮件',\n      trash: '删除的邮件会先移到这里',\n    };\n    return `<div class=\"empty\">\n      <div class=\"empty-icon\">${icon(isSearch ? 'search' : 'mail-open', 24)}</div>\n      <strong>${esc(messages[state.view] || '没有邮件')}</strong>\n      <p>${esc(hints[state.view] || '')}</p>\n    </div>`;\n  }\n\n  function mailItemHtml(item) {\n    const sent = state.view === 'sent';\n    const whoName = sent ? item.to : displayName(item.fromName, item.from);\n    const time = sent ? item.sentAt : item.receivedAt;\n    const unread = !sent && !item.isRead;\n    const ttlLeft = state.view === 'trash' && item.deletedAt\n      ? state.trashTtlDays - Math.floor((Date.now() - Date.parse(item.deletedAt)) / 86400000)\n      : null;\n    const flags = [\n      ttlLeft != null ? `<span class=\"badge\">${ttlLeft > 0 ? `${ttlLeft} 天后清除` : '即将清除'}</span>` : '',\n      !sent && item.isStarred ? `<span class=\"star\" title=\"已加星标\">${icon('star', 13)}</span>` : '',\n      item.hasAttachments ? `<span class=\"clip\" title=\"含附件\">${icon('paperclip', 13)}</span>` : '',\n      sent && item.status === 'failed' ? `<span class=\"badge badge-danger\">失败</span>` : '',\n    ]\n      .filter(Boolean)\n      .join('');\n    return `<button class=\"mail-item${unread ? ' is-unread' : ''}${state.selectedId === item.id ? ' is-active' : ''}\"\n        data-action=\"open-mail\" data-id=\"${item.id}\" data-sent=\"${sent ? '1' : '0'}\">\n      <div class=\"mail-row1\">\n        <span class=\"mail-from\">${esc(whoName)}</span>\n        <span class=\"mail-time\">${esc(fmtDate(time))}</span>\n      </div>\n      <div class=\"mail-subject\">${esc(item.subject || SUBJECT_FALLBACK)}</div>\n      <div class=\"mail-preview\">${esc(item.preview || '')}</div>\n      ${flags ? `<div class=\"mail-flags\" style=\"margin-top:5px\">${flags}</div>` : ''}\n    </button>`;\n  }\n\n  function highlightActive() {\n    $$('.mail-item', $('#mail-list') || document).forEach((node) => {\n      node.classList.toggle('is-active', Number(node.dataset.id) === state.selectedId);\n    });\n  }\n\n  async function loadList({ reset = false } = {}) {\n    if (isPageView()) return;\n    if (reset) {\n      state.page = 1;\n      state.items = [];\n    }\n    state.listLoading = true;\n    const seq = ++state.listSeq;\n    if (reset || state.items.length === 0) renderList();\n\n    const params = new URLSearchParams({\n      box: VIEW_META[state.view].box,\n      page: String(state.page),\n      pageSize: String(state.pageSize),\n    });\n    if (state.q) params.set('q', state.q);\n    if (state.unreadOnly && state.view === 'inbox') params.set('unread', '1');\n\n    try {\n      const data = await api(`/api/mails?${params.toString()}`);\n      if (seq !== state.listSeq) return;\n      const items = Array.isArray(data.items) ? data.items : [];\n      state.items = reset || state.page === 1 ? items : state.items.concat(items);\n      state.total = Number(data.total || 0);\n      if (reset) {\n        const node = $('#mail-list');\n        if (node) node.scrollTop = 0;\n      }\n    } catch (error) {\n      if (seq !== state.listSeq) return;\n      if (error.status !== 401) toast(error.message, 'danger');\n      state.items = [];\n    } finally {\n      if (seq === state.listSeq) {\n        state.listLoading = false;\n        renderList();\n      }\n    }\n  }\n\n  /* ==================== 阅读器 ==================== */\n\n  function renderReader() {\n    const reader = $('#reader');\n    if (!reader) return;\n    if (isPageView()) {\n      reader.innerHTML =\n        state.view === 'admin' ? renderAdminPage({ loading: true }) : renderSettingsPage();\n      if (state.view === 'admin') loadAdmin();\n      else bindSettingsPage();\n      return;\n    }\n    if (state.mailLoading) {\n      reader.innerHTML = `<div class=\"reader-bar\"><span class=\"bar-title\">加载中…</span></div>\n        <div class=\"reader-scroll\"><div class=\"reader-inner\">\n          <div class=\"skeleton\" style=\"height:26px;width:65%;margin-bottom:16px\"></div>\n          <div class=\"skeleton\" style=\"height:44px;width:100%\"></div>\n          <div class=\"skeleton\" style=\"height:220px;width:100%;margin-top:22px\"></div>\n        </div></div>`;\n      return;\n    }\n    if (!state.mail) {\n      reader.innerHTML = emptyReaderHtml();\n      return;\n    }\n    reader.innerHTML = mailReaderHtml(state.mail);\n    afterReaderMount();\n  }\n\n  function emptyReaderHtml() {\n    const admin = state.user && state.user.role === 'admin';\n    return `<div class=\"reader-bar\"><span class=\"bar-title\">Cloud Mail</span></div>\n      <div class=\"reader-scroll\">\n        <div class=\"reader-inner\" style=\"display:grid;place-items:center;min-height:58vh\">\n          <div class=\"empty\" style=\"padding:0\">\n            <div class=\"empty-icon\" style=\"width:64px;height:64px;border-radius:20px\">${icon('mail-open', 28)}</div>\n            <strong style=\"font-size:15px\">选择一封邮件开始阅读</strong>\n            <p style=\"max-width:34ch\">你的邮箱地址是 <strong style=\"color:var(--text-2)\">${esc(state.user ? state.user.email : '')}</strong></p>\n            <div style=\"display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center\">\n              <button class=\"btn btn-primary\" data-action=\"compose\">${icon('pencil', 15)}写邮件</button>\n              ${admin ? `<button class=\"btn\" data-action=\"nav\" data-view=\"admin\">${icon('users', 15)}账号管理</button>` : ''}\n            </div>\n            <p style=\"margin-top:14px;font-size:12px\">快捷键：<span class=\"code-inline\">c</span> 写邮件 · <span class=\"code-inline\">/</span> 搜索</p>\n          </div>\n        </div>\n      </div>`;\n  }\n\n  function mailReaderHtml(mail) {\n    const sent = Boolean(mail.sentAt) && !mail.receivedAt;\n    const title = mail.subject || SUBJECT_FALLBACK;\n    const bodyHtml =\n      mail.bodyType === 'html'\n        ? `<iframe class=\"mail-frame\" id=\"mail-frame\" title=\"邮件内容\" sandbox=\"allow-same-origin allow-popups allow-popups-to-escape-sandbox\" referrerpolicy=\"no-referrer\"></iframe>`\n        : `<div class=\"mail-plain\">${esc(mail.body || '（无正文）')}</div>`;\n\n    const attachments = Array.isArray(mail.attachments) && mail.attachments.length\n      ? `<div class=\"mail-attachments\">${mail.attachments\n          .map(\n            (file) => `<span class=\"attachment\">${icon('paperclip', 14)}${esc(file.filename || '附件')}\n              <span class=\"size\">${esc(fmtBytes(file.size))}</span></span>`,\n          )\n          .join('')}</div>`\n      : '';\n\n    const blockedImages =\n      mail.bodyType === 'html' && !state.allowImages && /<img[^>]+src=[\"']?https?:/i.test(mail.body || '')\n        ? `<div class=\"mail-notice\">${icon('image', 15)}<span>为保护隐私，外部图片已被拦截</span>\n             <button data-action=\"allow-images\">显示图片</button></div>`\n        : '';\n\n    const sendFailed =\n      mail.status === 'failed'\n        ? `<div class=\"mail-notice\" style=\"border-color:color-mix(in srgb, var(--danger) 35%, transparent);color:var(--danger)\">\n             ${icon('alert', 15)}<span>发送失败：${esc(mail.error || '未知原因')}</span></div>`\n        : '';\n\n    const isProxyMail = Boolean(\n      state.user && mail.to && String(mail.to).toLowerCase() !== String(state.user.email || '').toLowerCase(),\n    );\n    const metaLeft = sent\n      ? `<div class=\"who\"><span class=\"name\">发给 ${esc(displayName('', mail.to))}</span><span class=\"addr\">&lt;${esc(mail.to)}&gt;</span></div>\n         <div class=\"to\">发件人：${esc(mail.from || '')}</div>`\n      : `<div class=\"who\"><span class=\"name\">${esc(displayName(mail.fromName, mail.from))}</span><span class=\"addr\">&lt;${esc(mail.from)}&gt;</span></div>\n         <div class=\"to\">收件人：${esc(mail.to)}${isProxyMail ? ' <span class=\"badge\">代收</span>' : ''}${mail.realFrom && mail.realFrom !== mail.from ? ` · 实际发件人 ${esc(mail.realFrom)}` : ''}</div>`;\n\n    const toolbar = sent\n      ? `<button class=\"icon-btn reader-back\" data-action=\"reader-close\" aria-label=\"返回\">${icon('back')}</button>\n         <span class=\"bar-title\">已发送</span>\n         <span class=\"badge ${mail.status === 'failed' ? 'badge-danger' : 'badge-success'}\">${mail.status === 'failed' ? '发送失败' : '已送达'}</span>\n         <button class=\"icon-btn\" data-action=\"mail-delete\" title=\"删除发件记录\">${icon('trash')}</button>`\n      : `<button class=\"icon-btn reader-back\" data-action=\"reader-close\" aria-label=\"返回\">${icon('back')}</button>\n         <span class=\"bar-title\">${esc(VIEW_META[state.view] ? VIEW_META[state.view].title : '邮件')}</span>\n         ${state.view === 'trash' ? `<button class=\"icon-btn\" data-action=\"mail-restore\" title=\"移回收件箱\">${icon('refresh')}</button>` : ''}\n         ${state.view !== 'trash' ? `<button class=\"icon-btn\" data-action=\"mail-reply\" title=\"回复\">${icon('reply')}</button>` : ''}\n         <button class=\"icon-btn${mail.isStarred ? ' is-active' : ''}\" data-action=\"mail-star\" title=\"${mail.isStarred ? '取消星标' : '加星标'}\"\n           aria-pressed=\"${mail.isStarred ? 'true' : 'false'}\">${icon('star')}</button>\n         <button class=\"icon-btn\" data-action=\"mail-unread\" title=\"标记为未读\">${icon('mail')}</button>\n         <button class=\"icon-btn\" data-action=\"mail-delete\" title=\"${state.view === 'trash' ? '永久删除' : '移入垃圾箱'}\">${icon('trash')}</button>`;\n\n    return `<div class=\"reader-bar\">${toolbar}</div>\n      <div class=\"reader-scroll\">\n        <div class=\"reader-inner\">\n          <div class=\"mail-head\">\n            <h1>${esc(title)}</h1>\n            <div class=\"mail-meta\">\n              ${sent ? `<span class=\"avatar\" style=\"${avatarStyle(mail.to)}\">${esc(initials('', mail.to))}</span>` : avatar(mail.fromName, mail.from)}\n              <div class=\"mail-meta-text\">${metaLeft}</div>\n              <div class=\"mail-date\">${esc(fmtFull(sent ? mail.sentAt : mail.receivedAt))}</div>\n            </div>\n          </div>\n          ${blockedImages}\n          <div class=\"mail-paper\">${bodyHtml}</div>\n          ${attachments}\n          ${sendFailed}\n        </div>\n      </div>`;\n  }\n\n  function buildMailDocument(mail) {\n    const allowImages = state.allowImages;\n    const csp = [\n      \"default-src 'none'\",\n      `img-src ${allowImages ? 'https: http: data:' : 'data:'}`,\n      \"style-src 'unsafe-inline' https: http:\",\n      'font-src https: http: data:',\n      'media-src https: http:',\n      \"form-action 'none'\",\n    ].join('; ');\n    const css = `\n      :root { color-scheme: light; }\n      html, body { margin: 0; padding: 0; background: #fff; }\n      body {\n        padding: 22px 24px 26px;\n        color: #1b1e28;\n        font: 14.5px/1.72 -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif;\n        word-break: break-word;\n        overflow-wrap: anywhere;\n      }\n      img { max-width: 100%; height: auto; }\n      a { color: #4f46e5; }\n      table { max-width: 100%; }\n      pre { white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }\n      blockquote { margin: 10px 0; padding: 2px 0 2px 14px; border-left: 3px solid #e6e8ef; color: #5b6172; }\n      hr { border: 0; border-top: 1px solid #e6e8ef; margin: 18px 0; }\n      * { max-width: 100%; }\n    `;\n    const head = `<meta charset=\"utf-8\">\n      <meta http-equiv=\"Content-Security-Policy\" content=\"${esc(csp)}\">\n      <base target=\"_blank\" rel=\"noopener noreferrer\">\n      <style>${css}</style>`;\n    const raw = String(mail.body || '');\n    // 有些邮件本身就是一整个 HTML 文档（带 doctype），直接嵌进 body 会出现嵌套 <html>\n    if (/^\\s*(<!doctype[^>]*>\\s*)?<html[\\s>]/i.test(raw.slice(0, 400))) {\n      if (/<head[^>]*>/i.test(raw)) return raw.replace(/<head([^>]*)>/i, `<head$1>${head}`);\n      if (/<html[^>]*>/i.test(raw)) return raw.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);\n      return `<!doctype html><html><head>${head}</head>${raw}`;\n    }\n    return `<!doctype html><html><head>${head}</head><body>${raw}</body></html>`;\n  }\n\n  function afterReaderMount() {\n    const frame = $('#mail-frame');\n    if (!frame || !state.mail) return;\n    frame.addEventListener('load', () => {\n      try {\n        const doc = frame.contentDocument;\n        if (!doc) return;\n        const height = Math.max(200, doc.documentElement.scrollHeight + 4);\n        frame.style.height = `${Math.min(height, 2000)}px`;\n      } catch {\n        frame.style.height = '520px';\n      }\n    });\n    frame.srcdoc = buildMailDocument(state.mail);\n    const scroll = $('.reader-scroll', $('#reader'));\n    if (scroll) scroll.scrollTop = 0;\n  }\n\n  async function openMail(id, isSent) {\n    state.selectedId = Number(id);\n    state.mailLoading = true;\n    state.mail = null;\n    state.allowImages = false;\n    highlightActive();\n    renderReader();\n    if (window.innerWidth <= 900 && shell()) shell().classList.add('reader-open');\n\n    try {\n      const path = isSent ? `/api/sent/${id}` : `/api/mails/${id}`;\n      const data = await api(path);\n      state.mail = data.mail;\n      state.mailLoading = false;\n      renderReader();\n\n      if (!isSent && data.mail && !data.mail.isRead) {\n        await api(`/api/mails/${id}`, { method: 'PATCH', body: { isRead: true } });\n        const item = state.items.find((row) => row.id === Number(id));\n        if (item) item.isRead = true;\n        state.mail.isRead = true;\n        state.counts.unread = Math.max(0, state.counts.unread - 1);\n        renderList();\n        updateRail();\n      }\n    } catch (error) {\n      state.mailLoading = false;\n      state.selectedId = null;\n      renderReader();\n      toast(error.message, 'danger');\n    }\n  }\n\n  function closeReader() {\n    state.selectedId = null;\n    state.mail = null;\n    if (shell()) shell().classList.remove('reader-open');\n    renderReader();\n    highlightActive();\n  }\n\n  /* ==================== 写邮件 ==================== */\n\n  function openCompose(prefill = {}) {\n    const from = state.user ? state.user.email : '';\n    const canSendAs = Boolean(state.user && state.user.role === 'admin');\n    const fromValue = prefixOfAddress(prefill.from || '');\n    const fromField = !canSendAs\n      ? ''\n      : state.domain\n        ? `<div class=\"field\">\n            <label for=\"c-from\">发件人</label>\n            <div class=\"input-group\">\n              <input id=\"c-from\" class=\"input\" name=\"from\" type=\"text\" inputmode=\"email\" autocomplete=\"off\"\n                placeholder=\"${esc(prefixOfAddress(from))}\" value=\"${esc(fromValue)}\" />\n              <span class=\"affix\">@${esc(state.domain)}</span>\n            </div>\n            <span class=\"hint\">只填前缀，域名自动补成 @${esc(state.domain)}；留空则用 ${esc(from)}</span>\n          </div>`\n        : `<div class=\"field\">\n            <label for=\"c-from\">发件人</label>\n            <input id=\"c-from\" class=\"input\" name=\"from\" type=\"text\" inputmode=\"email\" autocomplete=\"off\"\n              placeholder=\"${esc(from)}\" value=\"${esc(prefill.from || '')}\" />\n            <span class=\"hint\">管理员可代其他地址发信；留空则使用 ${esc(from)}</span>\n          </div>`;\n    openModal({\n      title: prefill.reply ? '回复邮件' : '写邮件',\n      size: 'wide',\n      body: `\n        <form id=\"compose-form\" style=\"display:flex;flex-direction:column;gap:14px\">\n          ${fromField}\n          <div class=\"field\">\n            <label for=\"c-to\">收件人</label>\n            <input id=\"c-to\" class=\"input\" name=\"to\" type=\"email\" placeholder=\"someone@example.com\"\n              value=\"${esc(prefill.to || '')}\" required />\n          </div>\n          <div class=\"field\">\n            <label for=\"c-subject\">主题</label>\n            <input id=\"c-subject\" class=\"input\" name=\"subject\" placeholder=\"主题\" value=\"${esc(prefill.subject || '')}\" />\n          </div>\n          <div class=\"field\">\n            <label for=\"c-body\">正文</label>\n            <textarea id=\"c-body\" class=\"textarea\" name=\"body\" placeholder=\"写点什么…\" style=\"min-height:200px\">${esc(prefill.body || '')}</textarea>\n            <span class=\"hint\">${canSendAs\n              ? '发信域名需已在 Cloudflare Email Routing 中启用；代发地址也需是可投递的域名。'\n              : `发件人固定为 ${esc(from)}，发信域名需已在 Cloudflare Email Routing 中启用。`}</span>\n          </div>\n        </form>`,\n      footer: `\n        <span class=\"hint\" style=\"font-size:12px;color:var(--muted)\">Ctrl / ⌘ + Enter 发送</span>\n        <div class=\"spacer\"></div>\n        <button class=\"btn btn-ghost\" data-action=\"modal-close\">取消</button>\n        <button class=\"btn btn-primary\" type=\"submit\" form=\"compose-form\" id=\"compose-send\">${icon('send', 15)}发送</button>`,\n      onMount(node) {\n        const form = $('#compose-form', node);\n        const bodyField = $('#c-body', node);\n        if (bodyField) bodyField.focus();\n        form.addEventListener('submit', async (event) => {\n          event.preventDefault();\n          const button = $('#compose-send', node);\n          const to = fv(form, 'to').trim();\n          const subject = fv(form, 'subject').trim();\n          const body = fv(form, 'body');\n          const sender = canSendAs ? addressValueOf(fv(form, 'from')) : '';\n          if (!to) return toast('请填写收件人', 'danger');\n          if (!body.trim()) return toast('邮件正文不能为空', 'danger');\n          button.disabled = true;\n          const original = button.innerHTML;\n          button.innerHTML = '<span class=\"spinner\"></span>发送中…';\n          try {\n            const payload = { to, subject, body };\n            if (sender) payload.from = sender;\n            await api('/api/mails/send', { method: 'POST', body: payload });\n            closeModal();\n            toast(`已发送给 ${to}`, 'success');\n            if (state.view === 'sent') loadList({ reset: true });\n            refreshCounts();\n          } catch (error) {\n            button.disabled = false;\n            button.innerHTML = original;\n            toast(error.message, 'danger');\n          }\n        });\n        form.addEventListener('keydown', (event) => {\n          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {\n            event.preventDefault();\n            form.requestSubmit();\n          }\n        });\n      },\n    });\n  }\n\n  /** 纯文本化，用于回复时引用原文。 */\n  function plainTextOf(mail) {\n    const raw = String(mail.body || '');\n    if (mail.bodyType !== 'html') return raw;\n    return raw\n      .replace(/<(script|style)[\\s\\S]*?<\\/\\1>/gi, ' ')\n      .replace(/<br\\s*\\/?>/gi, '\\n')\n      .replace(/<\\/(p|div|tr|li|h[1-6])>/gi, '\\n')\n      .replace(/<[^>]+>/g, ' ')\n      .replace(/&nbsp;/gi, ' ')\n      .replace(/&amp;/gi, '&')\n      .replace(/&lt;/gi, '<')\n      .replace(/&gt;/gi, '>')\n      .replace(/&quot;/gi, '\"')\n      .replace(/[ \\t]+/g, ' ')\n      .replace(/\\n{3,}/g, '\\n\\n')\n      .trim();\n  }\n\n  function replyToMail() {\n    const mail = state.mail;\n    if (!mail || mail.sentAt) return;\n    const subject = /^re:/i.test(mail.subject || '') ? mail.subject : `Re: ${mail.subject || SUBJECT_FALLBACK}`;\n    const quote = plainTextOf(mail)\n      .split('\\n')\n      .map((line) => `> ${line}`)\n      .join('\\n');\n    const body = `\\n\\n在 ${fmtFull(mail.receivedAt)}，${displayName(mail.fromName, mail.from)} 写道：\\n${quote}`;\n    // 管理员默认用「这封信是发给谁」的地址回，保持身份一致\n    const from = state.user && state.user.role === 'admin' ? mail.to || '' : '';\n    openCompose({ to: mail.from, subject, body, from, reply: true });\n  }\n\n  /* ==================== 设置页 ==================== */\n\n  function renderSettingsPage() {\n    const user = state.user || {};\n    const themeOptions = [\n      ['auto', 'system', '跟随系统'],\n      ['light', 'sun', '浅色'],\n      ['dark', 'moon', '深色'],\n    ];\n    return `<div class=\"reader-bar\">\n        <button class=\"icon-btn reader-back\" data-action=\"nav\" data-view=\"inbox\" aria-label=\"返回\">${icon('back')}</button>\n        <span class=\"bar-title\">设置</span>\n      </div>\n      <div class=\"page-scroll\">\n        <div class=\"page-inner\">\n          <div>\n            <h1 class=\"page-title\">设置</h1>\n            <p class=\"page-sub\" style=\"margin-top:6px\">管理你的账号、密码与界面偏好。</p>\n          </div>\n\n          <section class=\"card\">\n            <div class=\"card-head\">\n              <div>\n                <h3>个人资料</h3>\n                <p>显示名称会出现在发件人信息中</p>\n              </div>\n              ${avatar(user.name, user.email, 'avatar-lg')}\n            </div>\n            <div class=\"card-body\">\n              <form data-form=\"profile\" class=\"form-grid\">\n                <div class=\"field\">\n                  <label for=\"p-name\">显示名称</label>\n                  <input id=\"p-name\" class=\"input\" name=\"name\" value=\"${esc(user.name || '')}\" maxlength=\"60\" />\n                </div>\n                <div class=\"field\">\n                  <label for=\"p-email\">邮箱地址</label>\n                  <input id=\"p-email\" class=\"input\" value=\"${esc(user.email || '')}\" disabled />\n                  <span class=\"hint\">邮箱地址不可修改，如需更换请让管理员新建账号</span>\n                </div>\n                <div class=\"form-actions\" style=\"grid-column:1/-1\">\n                  <button class=\"btn btn-primary\" type=\"submit\">保存资料</button>\n                </div>\n              </form>\n            </div>\n          </section>\n\n          <section class=\"card\">\n            <div class=\"card-head\">\n              <div>\n                <h3>登录密码</h3>\n                <p>修改后其他设备上的登录状态会失效</p>\n              </div>\n              ${icon('key', 18)}\n            </div>\n            <div class=\"card-body\">\n              <form data-form=\"password\" class=\"form-grid\">\n                <div class=\"field\">\n                  <label for=\"p-current\">当前密码</label>\n                  <input id=\"p-current\" class=\"input\" name=\"current\" type=\"password\" autocomplete=\"current-password\" required />\n                </div>\n                <div class=\"field\">\n                  <label for=\"p-next\">新密码</label>\n                  <input id=\"p-next\" class=\"input\" name=\"next\" type=\"password\" autocomplete=\"new-password\" placeholder=\"至少 8 位\" required />\n                </div>\n                <div class=\"form-actions\" style=\"grid-column:1/-1\">\n                  <button class=\"btn btn-primary\" type=\"submit\">更新密码</button>\n                </div>\n              </form>\n            </div>\n          </section>\n\n          <section class=\"card\">\n            <div class=\"card-head\"><div><h3>外观</h3><p>选择界面配色</p></div>${icon('sun', 18)}</div>\n            <div class=\"card-body\">\n              <div style=\"display:flex;gap:8px;flex-wrap:wrap\">\n                ${themeOptions\n                  .map(\n                    ([value, iconName, label]) => `<button class=\"btn${state.theme === value ? ' btn-primary' : ''}\"\n                      data-action=\"set-theme\" data-theme=\"${value}\">${icon(iconName, 15)}${label}</button>`,\n                  )\n                  .join('')}\n              </div>\n            </div>\n          </section>\n\n          <section class=\"card\">\n            <div class=\"card-head\"><div><h3>邮箱信息</h3><p>当前 Worker 的运行配置</p></div>${icon('shield', 18)}</div>\n            <div class=\"card-body tight\">\n              <div class=\"list-rows\">\n                ${infoRow('邮箱地址', user.email || '—')}\n                ${infoRow('收件域名', state.domain ? `@${state.domain}（自动识别）` : '未识别 · 可设置 MAIL_DOMAIN')}\n                ${infoRow('账号角色', user.role === 'admin' ? '管理员' : '普通成员')}\n                ${infoRow('邮件保留', state.mailRetention > 0\n                  ? `全站最多 ${state.mailRetention} 封，超出后清理最旧的`\n                  : '不限（全站永久保留）')}\n                ${infoRow('垃圾箱清理', `${state.trashTtlDays} 天后自动删除`)}\n                ${infoRow('上次登录', user.lastLoginAt ? fmtFull(user.lastLoginAt) : '首次登录')}\n              </div>\n            </div>\n          </section>\n\n          <section class=\"card\">\n            <div class=\"card-head\">\n              <div><h3>邮件接口密钥</h3><p>供脚本 / 第三方系统直接调用收发接口</p></div>\n              <button class=\"icon-btn\" data-action=\"key-new\" title=\"新建密钥\">${icon('plus')}</button>\n            </div>\n            <div class=\"card-body tight\" id=\"key-body\">\n              <div class=\"row-item\"><span class=\"skeleton sk-line\" style=\"width:60%\"></span></div>\n              <div class=\"row-item\"><span class=\"skeleton sk-line\" style=\"width:40%\"></span></div>\n            </div>\n          </section>\n\n          <section class=\"card\">\n            <div class=\"card-head\"><div><h3>会话</h3><p>退出后需要重新输入密码</p></div></div>\n            <div class=\"card-body\" style=\"flex-direction:row\">\n              <button class=\"btn btn-danger\" data-action=\"logout\">${icon('logout', 15)}退出登录</button>\n            </div>\n          </section>\n        </div>\n      </div>`;\n  }\n\n  function infoRow(label, value) {\n    return `<div class=\"row-item\">\n      <div class=\"row-main\"><div class=\"row-desc\">${esc(label)}</div></div>\n      <div style=\"font-size:13px;color:var(--text-2);text-align:right;word-break:break-all\">${esc(value)}</div>\n    </div>`;\n  }\n\n  function bindSettingsPage() {\n    loadApiKeys();\n    const form = $('[data-form=\"profile\"]');\n    if (!form) return;\n    const pwdForm = $('[data-form=\"password\"]');\n    if (pwdForm) {\n      pwdForm.addEventListener('submit', async (event) => {\n        event.preventDefault();\n        const button = $('button[type=submit]', pwdForm);\n        button.disabled = true;\n        try {\n          await api('/api/me/password', {\n            method: 'POST',\n            body: { currentPassword: fv(pwdForm, 'current'), newPassword: fv(pwdForm, 'next') },\n          });\n          pwdForm.reset();\n          toast('密码已更新', 'success');\n        } catch (error) {\n          toast(error.message, 'danger');\n        } finally {\n          button.disabled = false;\n        }\n      });\n    }\n  }\n\n  /* ==================== 接口密钥 ==================== */\n\n  async function loadApiKeys() {\n    const node = $('#key-body');\n    if (!node) return;\n    try {\n      const data = await api('/api/keys');\n      state.keys = Array.isArray(data.keys) ? data.keys : [];\n      node.innerHTML = keysHtml(state.keys);\n    } catch (error) {\n      node.innerHTML = `<div class=\"row-item\"><div class=\"row-main\"><div class=\"row-desc\">${esc(error.message)}</div></div></div>`;\n    }\n  }\n\n  function keysHtml(keys) {\n    const rows = keys.length\n      ? keys\n          .map(\n            (key) => `<div class=\"row-item\">\n          <div class=\"row-main\">\n            <div class=\"row-title\">${esc(key.name || '未命名密钥')}</div>\n            <div class=\"row-desc\"><span class=\"code-inline\">${esc(key.masked)}</span> · 创建于 ${esc(fmtDate(key.createdAt))}${key.lastUsedAt ? ` · 最近使用 ${esc(fmtDate(key.lastUsedAt))}` : ' · 尚未使用'}</div>\n          </div>\n          <button class=\"btn btn-ghost\" data-action=\"key-revoke\" data-id=\"${key.id}\">撤销</button>\n        </div>`,\n          )\n          .join('')\n      : `<div class=\"row-item\">\n          <div class=\"row-main\">\n            <div class=\"row-title\">还没有密钥</div>\n            <div class=\"row-desc\">点击右上角 + 新建，即可用 x-api-key 头调用 /api/* 收发邮件</div>\n          </div>\n        </div>`;\n    return `${rows}\n      <div class=\"row-item\" style=\"display:block\">\n        <div class=\"row-desc\" style=\"margin-bottom:8px\">调用示例</div>\n        <pre class=\"code-block\">curl -H \"x-api-key: cm_你的密钥\" \\\\\n  https://你的域名/api/mails?box=inbox\n\ncurl -X POST -H \"x-api-key: cm_你的密钥\" \\\\\n  -H \"content-type: application/json\" \\\\\n  -d '{\"to\":\"friend@example.com\",\"subject\":\"你好\",\"body\":\"正文\"}' \\\\\n  https://你的域名/api/mails/send</pre>\n      </div>`;\n  }\n\n  function openKeyForm() {\n    openModal({\n      title: '新建接口密钥',\n      body: `<form id=\"key-form\" class=\"form-grid\">\n          <div class=\"field\" style=\"grid-column:1/-1\">\n            <label for=\"k-name\">名称</label>\n            <input id=\"k-name\" class=\"input\" name=\"name\" placeholder=\"例如：监控告警机器人\" maxlength=\"60\" />\n            <span class=\"hint\">名称只用于区分用途，密钥可随时撤销</span>\n          </div>\n        </form>`,\n      footer: `<div class=\"spacer\"></div>\n        <button class=\"btn btn-ghost\" data-action=\"modal-close\">取消</button>\n        <button class=\"btn btn-primary\" type=\"submit\" form=\"key-form\" id=\"key-submit\">${icon('key', 15)}创建</button>`,\n      onMount(node) {\n        const form = $('#key-form', node);\n        const input = $('#k-name', node);\n        if (input) input.focus();\n        form.addEventListener('submit', async (event) => {\n          event.preventDefault();\n          const button = $('#key-submit', node);\n          button.disabled = true;\n          try {\n            const data = await api('/api/keys', { method: 'POST', body: { name: fv(form, 'name').trim() } });\n            showNewKey(data.key, data.masked);\n            loadApiKeys();\n          } catch (error) {\n            toast(error.message, 'danger');\n            button.disabled = false;\n          }\n        });\n      },\n    });\n  }\n\n  function showNewKey(key, masked) {\n    openModal({\n      title: '密钥已创建',\n      body: `<p class=\"page-sub\" style=\"margin:0 0 12px\">请立即复制保存。关闭后只能看到缩略形式 <span class=\"code-inline\">${esc(masked)}</span>。</p>\n        <pre class=\"code-block\" id=\"new-key\">${esc(key)}</pre>`,\n      footer: `<div class=\"spacer\"></div>\n        <button class=\"btn\" data-action=\"key-copy\" data-key=\"${esc(key)}\">${icon('key', 15)}复制密钥</button>\n        <button class=\"btn btn-primary\" data-action=\"modal-close\">完成</button>`,\n    });\n  }\n\n  async function copyText(text) {\n    try {\n      await navigator.clipboard.writeText(text);\n      toast('已复制到剪贴板', 'success');\n      return;\n    } catch {\n      /* 退回到选中复制 */\n    }\n    try {\n      const area = document.createElement('textarea');\n      area.value = text;\n      area.style.position = 'fixed';\n      area.style.opacity = '0';\n      document.body.appendChild(area);\n      area.select();\n      document.execCommand('copy');\n      area.remove();\n      toast('已复制到剪贴板', 'success');\n    } catch {\n      toast('复制失败，请手动选择文本', 'danger');\n    }\n  }\n\n  async function revokeKey(id) {\n    const confirmed = await confirmDialog({\n      title: '撤销密钥',\n      message: '撤销会把这条密钥从服务器彻底删除：用它的脚本立即失效，记录也不可恢复。',\n      confirmText: '撤销并删除',\n      danger: true,\n    });\n    if (!confirmed) return;\n    try {\n      await api(`/api/keys/${id}/revoke`, { method: 'POST' });\n      toast('密钥已删除', 'success');\n      loadApiKeys();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  /* ==================== 账号管理 ==================== */\n\n  function renderAdminPage({ loading = false } = {}) {\n    return `<div class=\"reader-bar\">\n        <button class=\"icon-btn reader-back\" data-action=\"nav\" data-view=\"inbox\" aria-label=\"返回\">${icon('back')}</button>\n        <span class=\"bar-title\">账号管理</span>\n        <button class=\"btn btn-primary\" data-action=\"user-new\" style=\"height:32px;font-size:12.5px\">${icon('plus', 14)}新建账号</button>\n      </div>\n      <div class=\"page-scroll\">\n        <div class=\"page-inner\">\n          <div>\n            <h1 class=\"page-title\">账号管理</h1>\n            <p class=\"page-sub\" style=\"margin-top:6px\">为团队成员创建普通账号：每个账号拥有独立邮箱与收件箱。</p>\n          </div>\n          <div class=\"stat-grid\" id=\"admin-stats\">\n            ${['账号', '邮件', '已发送', '未读'].map((label) => `<div class=\"stat\"><div class=\"label\">${label}</div><div class=\"value\"><span class=\"skeleton\" style=\"display:inline-block;width:34px;height:20px\"></span></div></div>`).join('')}\n          </div>\n          <section class=\"card\">\n            <div class=\"card-head\">\n              <div><h3>成员账号</h3><p>普通成员只能访问自己的邮箱</p></div>\n              <button class=\"icon-btn\" data-action=\"admin-refresh\" title=\"刷新\">${icon('refresh')}</button>\n            </div>\n            <div class=\"card-body tight\" id=\"admin-users\">\n              ${loading ? '<div class=\"empty\"><span class=\"spinner\"></span></div>' : ''}\n            </div>\n          </section>\n          <section class=\"card\">\n            <div class=\"card-head\">\n              <div><h3>收信诊断</h3><p>查看无主邮件去向、域名来源与账号归属</p></div>\n              <button class=\"icon-btn\" data-action=\"diag-run\" title=\"运行检查\">${icon('shield')}</button>\n            </div>\n            <div class=\"card-body tight\" id=\"diag-body\">\n              <div class=\"row-item\">\n                <div class=\"row-main\">\n                  <div class=\"row-title\">点右上角运行检查</div>\n                  <div class=\"row-desc\">会列出总邮件数、滞留的无主邮件、各账号收件数与收件域名来源</div>\n                </div>\n              </div>\n            </div>\n          </section>\n        </div>\n      </div>`;\n  }\n\n  async function loadAdmin() {\n    try {\n      const [usersData, overview] = await Promise.all([api('/api/users'), api('/api/admin/overview')]);\n      const stats = overview.stats || {};\n      const statsNode = $('#admin-stats');\n      if (statsNode) {\n        const entries = [\n          ['账号', stats.users || 0],\n          ['邮件', stats.mails || 0],\n          ['已发送', stats.sent || 0],\n          ['未读', stats.unread || 0],\n        ];\n        statsNode.innerHTML = entries\n          .map(([label, value]) => `<div class=\"stat\"><div class=\"label\">${label}</div><div class=\"value\">${value}</div></div>`)\n          .join('');\n      }\n      const node = $('#admin-users');\n      if (node) node.innerHTML = usersTableHtml(usersData.users || []);\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function runDiagnostics() {\n    const node = $('#diag-body');\n    if (!node) return;\n    node.innerHTML = '<div class=\"empty\"><span class=\"spinner\"></span></div>';\n    try {\n      const data = await api('/api/diagnostics');\n      node.innerHTML = diagnosticsHtml(data);\n    } catch (error) {\n      node.innerHTML = `<div class=\"row-item\"><div class=\"row-main\"><div class=\"row-desc\">${esc(error.message)}</div></div></div>`;\n    }\n  }\n\n  function diagnosticsHtml(data) {\n    const stats = data.stats || {};\n    const sourceLabel = { env: 'MAIL_DOMAIN 环境变量', mail: '历史邮件学到的', unknown: '未识别' };\n    const row = (title, desc) => `<div class=\"row-item\">\n        <div class=\"row-main\"><div class=\"row-title\">${title}</div><div class=\"row-desc\">${desc}</div></div>\n      </div>`;\n    const users = (data.users || [])\n      .map((u) => `${esc(u.email)}${u.role === 'admin' ? '（管理员）' : ''}${u.status === 'disabled' ? '（已停用）' : ''} · ${u.mailCount} 封`)\n      .join('<br>');\n    const stranded = (data.stranded || []).length\n      ? data.stranded\n          .map((m) => `#${m.id} · ${esc(m.subject || '(无主题)')} → ${esc(m.receiver || '(未知地址)')}`)\n          .join('<br>')\n      : '没有滞留邮件';\n    const orphanAction =\n      Number(stats.orphans || 0) > 0\n        ? `<div class=\"row-item\" style=\"display:block\">\n             <button class=\"btn btn-primary\" data-action=\"diag-adopt\">把这 ${stats.orphans} 封无主邮件归到管理员</button>\n           </div>`\n        : '';\n    return [\n      row('收件域名', `${data.domain ? esc('@' + data.domain) : '未识别'} · 来源：${esc(sourceLabel[data.domainSource] || data.domainSource || '未知')}`),\n      row('管理员账号', data.admin ? esc(data.admin.email) : '还没有可用管理员'),\n      row('邮件统计', `共 ${stats.emails || 0} 封 · 无主 ${stats.orphans || 0} 封 · 未读 ${stats.unread || 0} 封 · 已发送 ${stats.sends || 0} 条 · 接口密钥 ${stats.apiKeys || 0} 个`),\n      row('各账号收件', users || '还没有账号'),\n      row('滞留（无主）邮件', stranded),\n      orphanAction,\n      row(\n        '排查提示',\n        (data.hints || []).map((h, i) => `${i + 1}. ${esc(h)}`).join('<br>'),\n      ),\n    ].join('');\n  }\n\n  async function adoptOrphans() {\n    try {\n      const data = await api('/api/diagnostics/adopt', { method: 'POST' });\n      toast(data.moved ? `已把 ${data.moved} 封无主邮件归到 ${data.owner}` : '没有滞留邮件需要处理', 'success');\n      runDiagnostics();\n      loadList({ reset: true });\n      refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  function usersTableHtml(users) {\n    if (!users.length) {\n      return '<div class=\"empty\"><strong>还没有账号</strong><p>点击右上角新建第一个账号</p></div>';\n    }\n    const me = state.user || {};\n    const rows = users\n      .map((user) => {\n        const isMe = user.id === me.id;\n        const roleBadge = user.role === 'admin' ? '<span class=\"badge badge-accent\">管理员</span>' : '<span class=\"badge\">普通成员</span>';\n        const statusBadge = user.status === 'disabled' ? '<span class=\"badge badge-danger\">已停用</span>' : '';\n        const actions = [\n          `<button class=\"icon-btn\" data-action=\"user-reset\" data-id=\"${user.id}\" title=\"重置密码\">${icon('key', 16)}</button>`,\n          `<button class=\"icon-btn\" data-action=\"user-toggle\" data-id=\"${user.id}\" data-status=\"${user.status}\"\n             title=\"${user.status === 'disabled' ? '启用账号' : '停用账号'}\" ${isMe ? 'disabled style=\"opacity:.35;cursor:not-allowed\"' : ''}>${icon('shield', 16)}</button>`,\n          `<button class=\"icon-btn ${isMe ? '' : 'btn-danger'}\" data-action=\"user-delete\" data-id=\"${user.id}\" title=\"删除账号\"\n             ${isMe ? 'disabled style=\"opacity:.35;cursor:not-allowed\"' : ''}>${icon('trash', 16)}</button>`,\n        ].join('');\n        return `<tr>\n          <td>\n            <div class=\"cell-user\">\n              ${avatar(user.name, user.email)}\n              <div style=\"min-width:0\">\n                <div class=\"u-name\">${esc(user.name || user.email.split('@')[0])}${isMe ? ' <span class=\"badge\" style=\"height:18px\">我</span>' : ''}</div>\n                <div class=\"u-mail\">${esc(user.email)}</div>\n              </div>\n            </div>\n          </td>\n          <td>${roleBadge} ${statusBadge}</td>\n          <td class=\"mono\">${user.mailCount || 0}</td>\n          <td class=\"mono\">${user.sentCount || 0}</td>\n          <td class=\"mono\" style=\"white-space:nowrap\">${esc(user.lastLoginAt ? fmtDate(user.lastLoginAt) : '—')}</td>\n          <td><div class=\"row-actions\">${actions}</div></td>\n        </tr>`;\n      })\n      .join('');\n    return `<div class=\"table-wrap\"><table class=\"data\">\n      <thead><tr><th>成员</th><th>角色</th><th>邮件</th><th>已发送</th><th>最近登录</th><th></th></tr></thead>\n      <tbody>${rows}</tbody></table></div>`;\n  }\n\n  function openUserForm(user) {\n    const editing = Boolean(user);\n    openModal({\n      title: editing ? '编辑账号' : '新建账号',\n      body: `\n        <form id=\"user-form\" style=\"display:flex;flex-direction:column;gap:14px\">\n          ${\n            editing\n              ? `<div class=\"field\">\n                  <label for=\"u-email\">邮箱地址</label>\n                  <input id=\"u-email\" class=\"input\" value=\"${esc(user.email)}\" disabled />\n                </div>`\n              : addressInput({\n                  id: 'u-email',\n                  name: 'email',\n                  label: '邮箱地址',\n                  placeholder: 'member',\n                  hint: domainHint('需在 Cloudflare Email Routing 中启用该地址才能收信'),\n                })\n          }\n          <div class=\"field\">\n            <label for=\"u-name\">显示名称</label>\n            <input id=\"u-name\" class=\"input\" name=\"name\" maxlength=\"60\" value=\"${esc(user ? user.name : '')}\"\n              placeholder=\"留空则取邮箱前缀\" />\n          </div>\n          ${\n            editing\n              ? ''\n              : `<div class=\"field\">\n                  <label for=\"u-password\">初始密码</label>\n                  <input id=\"u-password\" class=\"input\" name=\"password\" type=\"password\" autocomplete=\"new-password\" placeholder=\"至少 8 位\" required />\n                </div>`\n          }\n          <div class=\"form-grid\">\n            <div class=\"field\">\n              <label for=\"u-role\">角色</label>\n              <select id=\"u-role\" class=\"select\" name=\"role\">\n                <option value=\"user\"${user && user.role === 'user' ? ' selected' : ''}>普通成员</option>\n                <option value=\"admin\"${user && user.role === 'admin' ? ' selected' : ''}>管理员</option>\n              </select>\n            </div>\n            <div class=\"field\">\n              <label for=\"u-status\">状态</label>\n              <select id=\"u-status\" class=\"select\" name=\"status\">\n                <option value=\"active\"${user && user.status === 'active' ? ' selected' : ''}>正常</option>\n                <option value=\"disabled\"${user && user.status === 'disabled' ? ' selected' : ''}>停用</option>\n              </select>\n            </div>\n          </div>\n        </form>`,\n      footer: `\n        <div class=\"spacer\"></div>\n        <button class=\"btn btn-ghost\" data-action=\"modal-close\">取消</button>\n        <button class=\"btn btn-primary\" type=\"submit\" form=\"user-form\" id=\"user-save\">${editing ? '保存' : '创建账号'}</button>`,\n      onMount(node) {\n        const form = $('#user-form', node);\n        form.addEventListener('submit', async (event) => {\n          event.preventDefault();\n          const button = $('#user-save', node);\n          button.disabled = true;\n          try {\n            if (editing) {\n              await api(`/api/users/${user.id}`, {\n                method: 'PATCH',\n                body: { name: fv(form, 'name'), role: fv(form, 'role'), status: fv(form, 'status') },\n              });\n              toast('账号已更新', 'success');\n            } else {\n              await api('/api/users', {\n                method: 'POST',\n                body: {\n                  email: fv(form, 'email').trim(),\n                  name: fv(form, 'name').trim(),\n                  password: fv(form, 'password'),\n                  role: fv(form, 'role'),\n                  status: fv(form, 'status'),\n                },\n              });\n              toast('账号已创建', 'success');\n            }\n            closeModal();\n            loadAdmin();\n          } catch (error) {\n            button.disabled = false;\n            toast(error.message, 'danger');\n          }\n        });\n      },\n    });\n  }\n\n  function openResetPassword(user) {\n    openModal({\n      title: '重置密码',\n      size: 'narrow',\n      body: `<form id=\"reset-form\" style=\"display:flex;flex-direction:column;gap:14px\">\n          <p style=\"margin:0;font-size:13px;color:var(--text-2);line-height:1.65\">\n            为 <strong>${esc(user.name || user.email)}</strong> 设置新密码，该账号在所有设备上的登录状态会立即失效。\n          </p>\n          <div class=\"field\">\n            <label for=\"r-password\">新密码</label>\n            <input id=\"r-password\" class=\"input\" name=\"password\" type=\"password\" autocomplete=\"new-password\" placeholder=\"至少 8 位\" required />\n          </div>\n        </form>`,\n      footer: `<div class=\"spacer\"></div>\n        <button class=\"btn btn-ghost\" data-action=\"modal-close\">取消</button>\n        <button class=\"btn btn-primary\" type=\"submit\" form=\"reset-form\" id=\"reset-save\">重置密码</button>`,\n      onMount(node) {\n        const form = $('#reset-form', node);\n        form.addEventListener('submit', async (event) => {\n          event.preventDefault();\n          const button = $('#reset-save', node);\n          button.disabled = true;\n          try {\n            await api(`/api/users/${user.id}/password`, { method: 'POST', body: { password: fv(form, 'password') } });\n            closeModal();\n            toast('密码已重置', 'success');\n          } catch (error) {\n            button.disabled = false;\n            toast(error.message, 'danger');\n          }\n        });\n      },\n    });\n  }\n\n  async function findUser(id) {\n    try {\n      const data = await api('/api/users');\n      return (data.users || []).find((user) => user.id === Number(id)) || null;\n    } catch {\n      return null;\n    }\n  }\n\n  /* ==================== 账户 / 会话 ==================== */\n\n  function openUserMenu() {\n    const user = state.user || {};\n    openModal({\n      title: '账户',\n      size: 'narrow',\n      body: `<div style=\"display:flex;flex-direction:column;align-items:center;gap:10px;padding:6px 0 4px\">\n          ${avatar(user.name, user.email, 'avatar-lg')}\n          <div style=\"text-align:center\">\n            <div style=\"font-size:15px;font-weight:650\">${esc(user.name || user.email)}</div>\n            <div style=\"font-size:12.5px;color:var(--muted);margin-top:2px\">${esc(user.email)}</div>\n            <div style=\"margin-top:8px\">${user.role === 'admin' ? '<span class=\"badge badge-accent\">管理员</span>' : '<span class=\"badge\">普通成员</span>'}</div>\n          </div>\n        </div>`,\n      footer: `<button class=\"btn btn-ghost\" data-action=\"nav\" data-view=\"settings\">${icon('settings', 15)}设置</button>\n        <div class=\"spacer\"></div>\n        <button class=\"btn btn-danger\" data-action=\"logout\">${icon('logout', 15)}退出登录</button>`,\n    });\n  }\n\n  async function signOut(silent = false) {\n    if (state.token && !silent) {\n      try {\n        await api('/api/auth/logout', { method: 'POST' });\n      } catch {\n        /* 忽略 */\n      }\n    }\n    state.token = '';\n    state.user = null;\n    state.mail = null;\n    state.selectedId = null;\n    state.items = [];\n    localStorage.removeItem(LS_TOKEN);\n    closeModal();\n    await showAuth();\n  }\n\n  function handleSessionExpired() {\n    if (!state.token) return;\n    state.token = '';\n    localStorage.removeItem(LS_TOKEN);\n    toast('登录状态已失效，请重新登录', 'danger');\n    showAuth();\n  }\n\n  /* ==================== 数据刷新 ==================== */\n\n  async function refreshCounts() {\n    try {\n      const data = await api('/api/me');\n      state.user = data.user || state.user;\n      state.counts = { ...state.counts, ...(data.counts || {}) };\n      state.domain = data.domain || state.domain;\n      state.mailbox = data.mailbox || state.mailbox;\n      state.canSendAs = Boolean(data.canSendAs);\n      state.trashTtlDays = Number(data.trashTtlDays) || state.trashTtlDays;\n      state.mailRetention = Number(data.mailRetention) || 0;\n      updateRail();\n    } catch {\n      /* 静默 */\n    }\n  }\n\n  async function switchView(view) {\n    if (!VIEW_META[view]) return;\n    closeModal();\n    state.view = view;\n    state.q = '';\n    state.unreadOnly = false;\n    state.selectedId = null;\n    state.mail = null;\n    state.allowImages = false;\n    renderShell();\n    if (isPageView()) {\n      if (window.innerWidth <= 900 && shell()) shell().classList.add('reader-open');\n      if (view === 'settings') refreshCounts();\n    } else {\n      loadList({ reset: true });\n    }\n  }\n\n  /* ==================== 事件 ==================== */\n\n  document.addEventListener('click', async (event) => {\n    const trigger = event.target.closest('[data-action]');\n    if (!trigger) return;\n    const action = trigger.dataset.action;\n    closeContextMenu();\n\n    switch (action) {\n      case 'nav':\n        await switchView(trigger.dataset.view);\n        break;\n      case 'refresh':\n        await loadList({ reset: true });\n        await refreshCounts();\n        break;\n      case 'compose':\n        openCompose();\n        break;\n      case 'open-mail':\n        await openMail(trigger.dataset.id, trigger.dataset.sent === '1');\n        break;\n      case 'reader-close':\n        closeReader();\n        break;\n      case 'mail-star':\n        await toggleStar();\n        break;\n      case 'mail-unread':\n        await markUnread();\n        break;\n      case 'mail-delete':\n        await deleteMail();\n        break;\n      case 'allow-images':\n        state.allowImages = true;\n        renderReader();\n        break;\n      case 'empty-trash':\n        await emptyTrash();\n        break;\n      case 'mail-reply':\n        replyToMail();\n        break;\n      case 'mail-restore':\n        if (state.mail) await restoreMail(state.mail.id);\n        break;\n      case 'ctx-open':\n        await openMail(trigger.dataset.id, trigger.dataset.sent === '1');\n        break;\n      case 'ctx-reply':\n        await openMail(trigger.dataset.id, false);\n        replyToMail();\n        break;\n      case 'ctx-read':\n      case 'ctx-unread':\n        await patchListItem(Number(trigger.dataset.id), { isRead: action === 'ctx-read' });\n        break;\n      case 'ctx-star': {\n        const row = state.items.find((entry) => entry.id === Number(trigger.dataset.id));\n        await patchListItem(Number(trigger.dataset.id), { isStarred: !(row && row.isStarred) }, {\n          onOk: () => toast(row && row.isStarred ? '已取消星标' : '已加星标', 'success'),\n        });\n        break;\n      }\n      case 'ctx-delete':\n        await deleteListItem(Number(trigger.dataset.id));\n        break;\n      case 'ctx-restore':\n        await restoreMail(Number(trigger.dataset.id));\n        break;\n      case 'ctx-delete-forever':\n        await deleteListItem(Number(trigger.dataset.id), true);\n        break;\n      case 'ctx-empty-trash':\n        await emptyTrash();\n        break;\n      case 'ctx-again': {\n        const row = state.items.find((entry) => entry.id === Number(trigger.dataset.id));\n        openCompose({ to: row ? row.to : '', subject: row ? `Re: ${row.subject || SUBJECT_FALLBACK}` : '' });\n        break;\n      }\n      case 'ctx-sent-delete':\n        await deleteSent(Number(trigger.dataset.id));\n        break;\n      case 'chip-all':\n        if (!state.unreadOnly) break;\n        state.unreadOnly = false;\n        $$('.chip').forEach((chip) => chip.classList.remove('is-active'));\n        trigger.classList.add('is-active');\n        await loadList({ reset: true });\n        break;\n      case 'chip-unread':\n        if (state.unreadOnly) break;\n        state.unreadOnly = true;\n        $$('.chip').forEach((chip) => chip.classList.remove('is-active'));\n        trigger.classList.add('is-active');\n        await loadList({ reset: true });\n        break;\n      case 'clear-search':\n        state.q = '';\n        renderShell();\n        await loadList({ reset: true });\n        break;\n      case 'load-more':\n        state.page += 1;\n        await loadList();\n        break;\n      case 'toggle-theme':\n        applyTheme(trigger.dataset.nextTheme || 'auto');\n        break;\n      case 'set-theme':\n        applyTheme(trigger.dataset.theme);\n        $$('[data-action=\"set-theme\"]').forEach((btn) => {\n          btn.classList.toggle('btn-primary', btn.dataset.theme === state.theme);\n        });\n        break;\n      case 'user-menu':\n        openUserMenu();\n        break;\n      case 'logout':\n        await signOut();\n        break;\n      case 'modal-close':\n        closeModal();\n        break;\n      case 'modal-backdrop':\n        if (event.target === trigger) closeModal();\n        break;\n      case 'user-new':\n        openUserForm(null);\n        break;\n      case 'user-edit': {\n        const user = await findUser(trigger.dataset.id);\n        if (user) openUserForm(user);\n        break;\n      }\n      case 'user-reset': {\n        const user = await findUser(trigger.dataset.id);\n        if (user) openResetPassword(user);\n        break;\n      }\n      case 'user-toggle': {\n        const user = await findUser(trigger.dataset.id);\n        if (!user) break;\n        const nextStatus = user.status === 'disabled' ? 'active' : 'disabled';\n        try {\n          await api(`/api/users/${user.id}`, { method: 'PATCH', body: { status: nextStatus } });\n          toast(nextStatus === 'active' ? '账号已启用' : '账号已停用', 'success');\n          loadAdmin();\n        } catch (error) {\n          toast(error.message, 'danger');\n        }\n        break;\n      }\n      case 'user-delete': {\n        const user = await findUser(trigger.dataset.id);\n        if (!user) break;\n        const confirmed = await confirmDialog({\n          title: '删除账号',\n          message: `确定删除 ${user.email} 吗？该账号的邮件与会话将一并清除，且无法恢复。`,\n          confirmText: '删除',\n          danger: true,\n        });\n        if (!confirmed) break;\n        try {\n          await api(`/api/users/${user.id}`, { method: 'DELETE' });\n          toast('账号已删除', 'success');\n          loadAdmin();\n        } catch (error) {\n          toast(error.message, 'danger');\n        }\n        break;\n      }\n      case 'admin-refresh':\n        loadAdmin();\n        break;\n      case 'diag-run':\n        runDiagnostics();\n        break;\n      case 'diag-adopt':\n        adoptOrphans();\n        break;\n      case 'key-new':\n        openKeyForm();\n        break;\n      case 'key-copy':\n        await copyText(trigger.dataset.key || '');\n        break;\n      case 'key-revoke':\n        await revokeKey(Number(trigger.dataset.id));\n        break;\n      default:\n        break;\n    }\n  });\n\n  document.addEventListener('contextmenu', (event) => {\n    const row = event.target.closest('.mail-item');\n    if (!row) {\n      closeContextMenu();\n      return;\n    }\n    event.preventDefault();\n    const item = state.items.find((entry) => entry.id === Number(row.dataset.id));\n    if (!item) return;\n    openContextMenu(item, event.clientX, event.clientY);\n  });\n\n  document.addEventListener('click', (event) => {\n    if (!event.target.closest('#ctx-menu')) closeContextMenu();\n  }, true);\n\n  document.addEventListener('scroll', () => closeContextMenu(), true);\n  window.addEventListener('resize', () => closeContextMenu());\n\n  document.addEventListener('submit', (event) => {\n    const form = event.target;\n    if (!(form instanceof HTMLFormElement)) return;\n    const kind = form.dataset.form;\n    if (!kind) return;\n    event.preventDefault();\n    if (kind === 'login') submitLogin(form);\n    else if (kind === 'setup') submitSetup(form);\n    else if (kind === 'profile') {\n      const button = $('button[type=submit]', form);\n      button.disabled = true;\n      api('/api/me', { method: 'PATCH', body: { name: fv(form, 'name').trim() } })\n        .then((data) => {\n          state.user = data.user;\n          toast('资料已保存', 'success');\n          renderReader();\n        })\n        .catch((error) => toast(error.message, 'danger'))\n        .finally(() => {\n          button.disabled = false;\n        });\n    }\n  });\n\n  let searchTimer = 0;\n  document.addEventListener('input', (event) => {\n    if (event.target.id !== 'search') return;\n    const value = event.target.value;\n    clearTimeout(searchTimer);\n    searchTimer = setTimeout(() => {\n      if (state.q === value.trim()) return;\n      state.q = value.trim();\n      loadList({ reset: true });\n      const wrap = $('.search-wrap');\n      if (wrap) {\n        const existing = $('.search-clear', wrap);\n        if (state.q && !existing) {\n          wrap.insertAdjacentHTML('beforeend', `<button class=\"search-clear\" data-action=\"clear-search\" aria-label=\"清除\">${icon('x', 13)}</button>`);\n        } else if (!state.q && existing) {\n          existing.remove();\n        }\n      }\n    }, 280);\n  });\n\n  document.addEventListener('keydown', (event) => {\n    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement ? document.activeElement.tagName : '');\n    if (event.key === 'Escape') {\n      if ($('#ctx-menu')) {\n        closeContextMenu();\n        event.preventDefault();\n      } else if (state.modal) {\n        closeModal();\n        event.preventDefault();\n      } else if (state.selectedId && window.innerWidth <= 900) {\n        closeReader();\n      }\n      return;\n    }\n    if (typing || state.modal || event.metaKey || event.ctrlKey || event.altKey) return;\n    if (event.key === 'c') {\n      event.preventDefault();\n      openCompose();\n    } else if (event.key === '/') {\n      event.preventDefault();\n      const input = $('#search');\n      if (input) input.focus();\n    }\n  });\n\n  /* ==================== 邮件操作 ==================== */\n\n  async function toggleStar() {\n    if (!state.mail || state.mail.sentAt) return;\n    const next = !state.mail.isStarred;\n    try {\n      await api(`/api/mails/${state.mail.id}`, { method: 'PATCH', body: { isStarred: next } });\n      state.mail.isStarred = next;\n      const item = state.items.find((row) => row.id === state.mail.id);\n      if (item) item.isStarred = next;\n      if (state.view === 'starred' && !next) {\n        await loadList({ reset: true });\n      } else {\n        renderList();\n      }\n      renderReader();\n      state.counts.starred = Math.max(0, state.counts.starred + (next ? 1 : -1));\n      if (next) toast('已加星标', 'success');\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function markUnread() {\n    if (!state.mail || state.mail.sentAt) return;\n    try {\n      await api(`/api/mails/${state.mail.id}`, { method: 'PATCH', body: { isRead: false } });\n      const item = state.items.find((row) => row.id === state.mail.id);\n      if (item) item.isRead = false;\n      state.counts.unread += 1;\n      updateRail();\n      renderList();\n      toast('已标记为未读');\n      closeReader();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function deleteMail() {\n    if (!state.mail) return;\n    if (state.mail.sentAt) {\n      await deleteSent(state.mail.id);\n      return;\n    }\n    const permanent = state.view === 'trash';\n    if (permanent) {\n      const okToDelete = await confirmDialog({\n        title: '永久删除',\n        message: '该邮件将被永久删除，无法恢复。',\n        confirmText: '永久删除',\n        danger: true,\n      });\n      if (!okToDelete) return;\n    }\n    try {\n      await api(`/api/mails/${state.mail.id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' });\n      toast(permanent ? '邮件已永久删除' : '已移入垃圾箱', 'success');\n      closeReader();\n      await loadList({ reset: true });\n      await refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function emptyTrash() {\n    const confirmed = await confirmDialog({\n      title: '清空垃圾箱',\n      message: '垃圾箱中的所有邮件将被永久删除，无法恢复。',\n      confirmText: '清空',\n      danger: true,\n    });\n    if (!confirmed) return;\n    try {\n      const data = await api('/api/mails/trash/empty', { method: 'POST' });\n      toast(`已清空 ${data.removed || 0} 封邮件`, 'success');\n      state.selectedId = null;\n      state.mail = null;\n      await loadList({ reset: true });\n      renderReader();\n      await refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  /* ==================== 右键菜单 ==================== */\n\n  function closeContextMenu() {\n    const node = $('#ctx-menu');\n    if (node) node.remove();\n  }\n\n  function contextMenuEntries(item) {\n    const sent = state.view === 'sent';\n    const inTrash = state.view === 'trash';\n    if (inTrash) {\n      return [\n        { action: 'ctx-open', label: '打开', icon: 'mail-open' },\n        { action: 'ctx-restore', label: '移回收件箱', icon: 'refresh' },\n        { action: 'ctx-delete-forever', label: '永久删除', icon: 'trash', danger: true },\n        { action: 'ctx-empty-trash', label: '清空垃圾箱', icon: 'trash', danger: true },\n      ];\n    }\n    if (sent) {\n      return [\n        { action: 'ctx-open', label: '查看内容', icon: 'mail-open' },\n        { action: 'ctx-again', label: '再写一封', icon: 'pencil' },\n        { action: 'ctx-sent-delete', label: '删除发件记录', icon: 'trash', danger: true },\n      ];\n    }\n    return [\n      { action: 'ctx-open', label: '打开', icon: 'mail-open' },\n      { action: 'ctx-reply', label: '回复', icon: 'reply' },\n      { action: item.isRead ? 'ctx-unread' : 'ctx-read', label: item.isRead ? '标记为未读' : '标记为已读', icon: 'mail' },\n      { action: 'ctx-star', label: item.isStarred ? '取消星标' : '加星标', icon: 'star' },\n      { action: 'ctx-delete', label: '移入垃圾箱', icon: 'trash', danger: true },\n    ];\n  }\n\n  function openContextMenu(item, x, y) {\n    closeContextMenu();\n    const menu = document.createElement('div');\n    menu.id = 'ctx-menu';\n    menu.className = 'ctx-menu';\n    menu.setAttribute('role', 'menu');\n    menu.innerHTML = contextMenuEntries(item)\n      .map(\n        (entry) => `<button class=\"ctx-item${entry.danger ? ' is-danger' : ''}\" role=\"menuitem\"\n          data-action=\"${entry.action}\" data-id=\"${item.id}\" data-sent=\"${state.view === 'sent' ? '1' : '0'}\">\n          ${icon(entry.icon, 15)}<span>${esc(entry.label)}</span>\n        </button>`,\n      )\n      .join('');\n    document.body.appendChild(menu);\n    const rect = menu.getBoundingClientRect();\n    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));\n    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));\n    menu.style.left = `${left}px`;\n    menu.style.top = `${top}px`;\n  }\n\n  async function restoreMail(id) {\n    try {\n      await api(`/api/mails/${id}`, { method: 'PATCH', body: { restore: true } });\n      toast('已移回收件箱', 'success');\n      if (state.selectedId === Number(id)) closeReader();\n      await loadList({ reset: true });\n      await refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function patchListItem(id, body, { onOk } = {}) {\n    try {\n      await api(`/api/mails/${id}`, { method: 'PATCH', body });\n      if (onOk) onOk();\n      await loadList({ reset: true });\n      await refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function deleteSent(id) {\n    const confirmed = await confirmDialog({\n      title: '删除发件记录',\n      message: '只会删掉这里的发件记录，已经发出去的邮件无法从对方邮箱撤回。',\n      confirmText: '删除',\n      danger: true,\n    });\n    if (!confirmed) return;\n    try {\n      await api(`/api/sent/${id}`, { method: 'DELETE' });\n      toast('发件记录已删除', 'success');\n      if (state.selectedId === Number(id)) closeReader();\n      await loadList({ reset: true });\n      await refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  async function deleteListItem(id, permanent = false) {\n    if (permanent) {\n      const okToDelete = await confirmDialog({\n        title: '永久删除',\n        message: '该邮件将被永久删除，无法恢复。',\n        confirmText: '永久删除',\n        danger: true,\n      });\n      if (!okToDelete) return;\n    }\n    try {\n      await api(`/api/mails/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' });\n      toast(permanent ? '邮件已永久删除' : '已移入垃圾箱', 'success');\n      if (state.selectedId === Number(id)) closeReader();\n      await loadList({ reset: true });\n      await refreshCounts();\n    } catch (error) {\n      toast(error.message, 'danger');\n    }\n  }\n\n  /* ==================== 启动 ==================== */\n\n  function renderSplash() {\n    app().innerHTML = `<div class=\"auth-screen\">\n      <div style=\"display:grid;place-items:center;gap:14px\">\n        <span class=\"brand-mark\" style=\"width:48px;height:48px;border-radius:14px\">${icon('mail', 26)}</span>\n        <span class=\"spinner\" style=\"width:20px;height:20px;color:var(--muted)\"></span>\n      </div>\n    </div>`;\n  }\n\n  function renderFatal(message) {\n    app().innerHTML = `<div class=\"auth-screen\">\n      <div class=\"auth-card\" style=\"text-align:center\">\n        <div class=\"empty\" style=\"padding:10px 0 0\">\n          <div class=\"empty-icon\" style=\"background:var(--danger-soft);color:var(--danger)\">${icon('alert', 24)}</div>\n          <strong>无法连接到服务</strong>\n          <p>${esc(message || '请检查 Worker 是否正常部署')}</p>\n          <button class=\"btn\" style=\"margin-top:6px\" data-action=\"reload\">重新加载</button>\n        </div>\n      </div>\n    </div>`;\n  }\n\n  document.addEventListener('click', (event) => {\n    if (event.target.closest('[data-action=\"reload\"]')) location.reload();\n  });\n\n  async function showAuth() {\n    try {\n      const status = await api('/api/setup', { auth: false });\n      state.setup = {\n        needsSetup: Boolean(status.needsSetup),\n        userCount: status.userCount || 0,\n        defaultAdmin: status.defaultAdmin || '',\n      };\n      state.domain = status.domain || state.domain;\n    } catch (error) {\n      renderFatal(error.message);\n      return;\n    }\n    renderAuth();\n  }\n\n  async function bootApp(userHint) {\n    try {\n      const data = await api('/api/me');\n      state.user = data.user || userHint || null;\n      state.domain = data.domain || state.domain;\n      state.mailbox = data.mailbox || '';\n      state.canSendAs = Boolean(data.canSendAs);\n      state.trashTtlDays = Number(data.trashTtlDays) || 30;\n      state.mailRetention = Number(data.mailRetention) || 0;\n      state.counts = { ...state.counts, ...(data.counts || {}) };\n      state.view = 'inbox';\n      state.q = '';\n      state.page = 1;\n      state.items = [];\n      state.selectedId = null;\n      state.mail = null;\n      renderShell();\n      updateRail();\n      await loadList({ reset: true });\n      if (window.innerWidth > 900) {\n        // 桌面端自动打开第一封未读邮件\n        const firstUnread = state.items.find((item) => !item.isRead);\n        if (firstUnread) await openMail(firstUnread.id, false);\n      }\n    } catch (error) {\n      if (error.status === 401) {\n        await showAuth();\n        return;\n      }\n      renderFatal(error.message);\n    }\n  }\n\n  async function boot() {\n    applyTheme(state.theme);\n    renderSplash();\n    if (state.token) {\n      await bootApp();\n      return;\n    }\n    await showAuth();\n  }\n\n  boot();\n})();</script>\n</body>\n</html>\n";

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https: http:",
  "style-src 'self' 'unsafe-inline' https: http:",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data: https: http:",
  "frame-src 'self' data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function htmlResponse(html) {
  return new Response(html, {
    headers: securityHeaders({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
    }),
  });
}

const __workerEntry = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz') {
        return json({ ok: true, service: 'cloud-mail', ts: Date.now() });
      }
      if (url.pathname.startsWith('/api/')) {
        await ensureReady(env);
        return await routeApi(request, env, url);
      }
      if (url.pathname === '/favicon.ico') {
        return new Response(null, { status: 204, headers: securityHeaders() });
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return htmlResponse(request.method === 'HEAD' ? '' : APP_HTML);
      }
      return new Response('Method Not Allowed', { status: 405 });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.status, error.code, error.message);
      }
      const name = String(error?.name || '');
      const message = String(error?.message || '');
      console.error('unhandled error', name, message, error);
      // 运行时的加密能力限制（例如 PBKDF2 轮数超限）给出可操作的提示，而不是笼统的 500
      if (name === 'NotSupportedError' || /not supported/i.test(message)) {
        return fail(500, 'runtime_unsupported', `当前运行时限制：${message || name}。请检查 PBKDF2_ITERATIONS 等参数。`);
      }
      return fail(500, 'internal_error', '服务器开小差了，请稍后重试');
    }
  },

  async email(message, env, ctx) {
    await handleIncomingEmail(message, env, ctx);
  },
};

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ---- 公共接口 ----
  if (path === '/api/setup') {
    if (method === 'GET') return handleSetupStatus(env, request);
    if (method === 'POST') return handleSetup(request, env);
  }
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);

  // ---- 当前用户 ----
  if (path === '/api/me') {
    if (method === 'GET') return handleMe(request, env);
    if (method === 'PATCH') return handleUpdateProfile(request, env);
  }
  if (path === '/api/me/password' && method === 'POST') return handleChangePassword(request, env);

  // ---- API 密钥 ----
  if (path === '/api/keys') {
    if (method === 'GET') return handleKeyList(request, env);
    if (method === 'POST') return handleKeyCreate(request, env);
  }
  const keyRevokeMatch = path.match(/^\/api\/keys\/(\d+)\/revoke$/);
  if (keyRevokeMatch && method === 'POST') return handleKeyRevoke(request, env, Number(keyRevokeMatch[1]));
  const keyMatch = path.match(/^\/api\/keys\/(\d+)$/);
  if (keyMatch && method === 'DELETE') return handleKeyRevoke(request, env, Number(keyMatch[1]));

  // ---- 邮件 ----
  if (path === '/api/mails' && method === 'GET') return handleMailList(request, env);
  if (path === '/api/mails/send' && method === 'POST') return handleSend(request, env);
  if (path === '/api/mails/trash/empty' && method === 'POST') return handleEmptyTrash(request, env);

  const mailMatch = path.match(/^\/api\/mails\/(\d+)$/);
  if (mailMatch) {
    const id = Number(mailMatch[1]);
    if (method === 'GET') return handleMailGet(request, env, id);
    if (method === 'PATCH') return handleMailPatch(request, env, id);
    if (method === 'DELETE') return handleMailDelete(request, env, id);
  }

  const sentMatch = path.match(/^\/api\/sent\/(\d+)$/);
  if (sentMatch && method === 'GET') return handleSentGet(request, env, Number(sentMatch[1]));
  if (sentMatch && method === 'DELETE') return handleSentDelete(request, env, Number(sentMatch[1]));

  // ---- 管理员 ----
  if (path === '/api/users') {
    if (method === 'GET') return handleUserList(request, env);
    if (method === 'POST') return handleUserCreate(request, env);
  }
  const userMatch = path.match(/^\/api\/users\/(\d+)$/);
  if (userMatch) {
    const id = Number(userMatch[1]);
    if (method === 'PATCH') return handleUserUpdate(request, env, id);
    if (method === 'DELETE') return handleUserDelete(request, env, id);
  }
  const userPasswordMatch = path.match(/^\/api\/users\/(\d+)\/password$/);
  if (userPasswordMatch && method === 'POST') return handleUserResetPassword(request, env, Number(userPasswordMatch[1]));

  if (path === '/api/admin/overview' && method === 'GET') return handleAdminOverview(request, env);
  if (path === '/api/diagnostics' && method === 'GET') return handleDiagnostics(request, env);
  if (path === '/api/diagnostics/adopt' && method === 'POST') return handleAdoptOrphans(request, env);

  return json(
    { ok: false, error: { code: 'not_found', message: `接口不存在：${str(path, 80)}` } },
    { status: 404 },
  );
}

export default __workerEntry;
