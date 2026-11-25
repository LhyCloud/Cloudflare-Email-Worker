/**
 * 登录 / 初始化 / 个人资料接口。
 */
import {
  checkPassword,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  isLoginThrottled,
  markLogin,
  passwordIterations,
  pbkdf2Iterations,
  recordLoginAttempt,
} from '../lib/auth.js';
import { adoptAllOrphanMail, adoptOrphanMail, countUsers, dbFirst, dbRun, findUserByEmail, publicUser } from '../lib/db.js';
import { expandAddress, requireAddress, resolveDomain, domainOf, rememberDomain } from '../lib/domain.js';
import { purgeExpiredTrash, retentionLimit, trashTtlDays } from './mails.js';
import { HttpError, json, ok, readJson, requireUser } from '../lib/http.js';
import { clientIp, isValidEmail, localPart, normalizeEmail, nowIso, sha256Hex, str } from '../lib/util.js';

const MIN_PASSWORD = 8;

export function assertPassword(password) {
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
export async function handleSetupStatus(env, request) {
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
export async function handleSetup(request, env) {
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
export async function handleLogin(request, env) {
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
export async function handleLogout(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) await destroySession(env, match[1].trim());
  return ok();
}

/** GET /api/me */
export async function handleMe(request, env) {
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
export async function handleUpdateProfile(request, env) {
  const { user } = await requireUser(request, env);
  const body = await readJson(request);
  const name = str(body.name, 60).trim();
  if (!name) throw new HttpError(400, 'invalid_name', '昵称不能为空');
  await dbRun(env, 'UPDATE users SET name = ? WHERE id = ?', name, user.id);
  const fresh = await dbFirst(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return ok({ user: publicUser(fresh) });
}

/** POST /api/me/password */
export async function handleChangePassword(request, env) {
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
