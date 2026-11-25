/**
 * 账号与会话：PBKDF2 密码哈希 + D1 会话表（令牌仅存哈希）。
 *
 * 注意 Workers 运行时的 WebCrypto 对 PBKDF2 有硬上限：
 *   超过 100000 轮会抛 NotSupportedError:
 *   "Pbkdf2 failed: iteration counts above 100000 are not supported (requested 120000)."
 * 所以默认轮数取上限值，且允许用 PBKDF2_ITERATIONS 往下调（越高越慢，别超过 10 万）。
 */
import { dbFirst, dbRun, publicUser } from './db.js';
import { bytesToHex, clientIp, nowIso, randomHex, safeEqual, sha256Hex, str } from './util.js';

export const PBKDF2_MAX_ITERATIONS = 100000;
export const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_BITS = 256;
const MIN_ITERATIONS = 10000;

/** 实际使用的迭代次数：可配置，但一定落在运行时可接受的区间里。 */
export function pbkdf2Iterations(env) {
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
export async function hashPassword(password, env) {
  const iterations = pbkdf2Iterations(env);
  const salt = randomHex(16);
  const bits = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt}$${bytesToHex(bits)}`;
}

/** 取出哈希里记录的迭代次数，用于判断是否需要顺手升级。 */
export function passwordIterations(stored) {
  const parts = String(stored || '').split('$');
  const iterations = Number(parts[1]);
  return parts[0] === 'pbkdf2' && Number.isFinite(iterations) ? iterations : 0;
}

/**
 * 校验密码。
 * 返回 'ok' | 'mismatch'，或者 { unsupported: 轮数 } —— 后者表示这条哈希的
 * 迭代次数高于当前运行时的上限（例如旧版本用 12 万轮写入的），需要重置密码。
 */
export async function checkPassword(password, stored) {
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

export async function verifyPassword(password, stored) {
  return (await checkPassword(password, stored)) === 'ok';
}

export function sessionTtlMs(env) {
  const days = Number(env?.SESSION_TTL_DAYS);
  const safeDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7;
  return safeDays * 24 * 60 * 60 * 1000;
}

export async function createSession(env, user, request) {
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

export async function authenticate(env, token) {
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

export async function destroySession(env, token) {
  if (!token) return;
  await dbRun(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
}

export async function destroyUserSessions(env, userId, exceptTokenHash = '') {
  if (exceptTokenHash) {
    await dbRun(env, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, exceptTokenHash);
    return;
  }
  await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', userId);
}

export async function markLogin(env, userId) {
  await dbRun(env, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
}

/** 登录失败次数过多时返回 true（同一邮箱 + IP，15 分钟内 8 次）。 */
export async function isLoginThrottled(env, email, ip) {
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

export async function recordLoginAttempt(env, email, ip, success) {
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
