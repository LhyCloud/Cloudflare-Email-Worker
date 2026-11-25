/**
 * 邮件接口用的 API 密钥。
 *
 * 令牌形如 `cm_<48 位十六进制>`，库里只存 SHA-256，创建时返回一次明文。
 * 用途：让脚本 / 第三方系统通过 HTTP 直接收发邮件，而不必模拟网页登录。
 */
import { dbFirst, dbRun, publicUser } from './db.js';
import { nowIso, randomHex, sha256Hex, str } from './util.js';

export const API_KEY_PREFIX = 'cm_';
const MAX_KEYS_PER_USER = 20;

function maskKey(key) {
  const body = key.slice(API_KEY_PREFIX.length);
  return `${API_KEY_PREFIX}${body.slice(0, 6)}…${body.slice(-4)}`;
}

export async function listApiKeys(env, userId) {
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

export async function createApiKey(env, userId, name) {
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
export async function revokeApiKey(env, userId, keyId) {
  const result = await dbRun(env, 'DELETE FROM api_keys WHERE id = ? AND user_id = ?', keyId, userId);
  return result.changes > 0;
}

/** 校验密钥；成功返回 { user }，并顺手记录最近使用时间。 */
export async function authenticateApiKey(env, key) {
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
