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

export function ensureSchema(env) {
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
export async function adoptOrphanMail(env, userId, email) {
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

export async function dbAll(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...cleanParams(params)).all();
  return result?.results || [];
}

export async function dbFirst(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...cleanParams(params)).first();
  return row || null;
}

export async function dbRun(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...cleanParams(params)).run();
  const meta = result?.meta || {};
  return { changes: Number(meta.changes || 0), lastRowId: Number(meta.last_row_id || 0) };
}

export function publicUser(row) {
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

export async function findUserByEmail(env, email) {
  return dbFirst(env, 'SELECT * FROM users WHERE email = ?', email);
}

/** 第一个可用管理员：无主邮件的兜底归属账号。 */
export async function firstAdminUser(env) {
  return dbFirst(
    env,
    `SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`,
  );
}

/**
 * 还没有管理员时（初始化向导没走完、账号被临时停用等）的退路：
 * 取最早的一个可用账号，宁可先让某个普通账号收着，也不让邮件进黑洞。
 */
export async function orphanFallbackUser(env) {
  return dbFirst(
    env,
    `SELECT id, email FROM users WHERE status = 'active' ORDER BY id LIMIT 1`,
  );
}

/** 无主邮件（没有归属账号）的封数。 */
export async function countOrphanMail(env) {
  const row = await dbFirst(env, 'SELECT COUNT(*) AS total FROM emails WHERE user_id IS NULL');
  return Number(row?.total || 0);
}

/**
 * 把所有无主邮件（user_id 为空）一次性归到指定账号。
 * 收信时找不到账号、旧库升级留下的孤儿数据都靠这个兜底，避免邮件进「黑洞」。
 * 返回实际迁移的封数（没有孤儿数据时为 0，且不写库）。
 */
export async function adoptAllOrphanMail(env, userId) {
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

export async function countUsers(env) {
  const row = await dbFirst(env, 'SELECT COUNT(*) AS total FROM users');
  return Number(row?.total || 0);
}
