/**
 * 管理员接口：账号管理（普通用户 + 管理员）。
 */
import { assertPassword, hashPassword } from './auth.js';
import { adoptAllOrphanMail, adoptOrphanMail, dbAll, dbFirst, dbRun, firstAdminUser, publicUser } from '../lib/db.js';
import { domainOf, domainSource, rememberDomain, requireAddress, resolveDomain } from '../lib/domain.js';
import { HttpError, ok, readJson, requireAdmin } from '../lib/http.js';
import { normalizeEmail, nowIso, str } from '../lib/util.js';

async function activeAdminCount(env, excludeId = 0) {
  const row = await dbFirst(
    env,
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
    excludeId,
  );
  return Number(row?.total || 0);
}

/** GET /api/users */
export async function handleUserList(request, env) {
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
export async function handleUserCreate(request, env) {
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
export async function handleUserUpdate(request, env, id) {
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
export async function handleUserResetPassword(request, env, id) {
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
export async function handleUserDelete(request, env, id) {
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
export async function handleAdminOverview(request, env) {
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
export async function handleDiagnostics(request, env) {
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
export async function handleAdoptOrphans(request, env) {
  const { user } = await requireAdmin(request, env);
  const admin = await firstAdminUser(env);
  const target = admin ? Number(admin.id) : Number(user.id);
  const moved = await adoptAllOrphanMail(env, target);
  return ok({ moved, owner: admin ? admin.email : user.email });
}
