/**
 * 邮件接口：列表、详情、标记、删除、发送。
 */
import { dbAll, dbFirst, dbRun } from '../lib/db.js';
import { expandAddress } from '../lib/domain.js';
import { HttpError, ok, readJson, requireUser } from '../lib/http.js';
import { looksLikeHtml } from '../lib/mime.js';
import { cleanDisplayName, intParam, isValidEmail, normalizeEmail, nowIso, previewOf, str, trimToBytes } from '../lib/util.js';

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;
export const MAX_BODY_BYTES = 900 * 1024;

/**
 * 全站保留上限：整库最多留这么多封（收件 + 发件各自按这个上限算）。
 * 默认 500 封；配 MAIL_RETENTION=0 可以关掉清理（等于不限）。
 */
export function retentionLimit(env) {
  const raw = env?.MAIL_RETENTION;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 500;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 500;
  if (value === 0) return 0;
  return Math.min(Math.max(Math.floor(value), 20), 5000);
}

/** 按全站上限砍掉最旧的邮件：超出部分不分账号，一律删除。 */
export async function trimStore(env) {
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
export function trashTtlDays(env) {
  const value = Number(env?.TRASH_RETENTION_DAYS);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(Math.max(Math.floor(value), 1), 365);
}

/** 清掉垃圾箱里超过保留期的邮件，返回删除条数。 */
export async function purgeExpiredTrash(env, userId) {
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
export async function handleMailList(request, env) {
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
export async function handleMailGet(request, env, id) {
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
export async function handleMailPatch(request, env, id) {
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
export async function handleMailDelete(request, env, id) {
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
export async function handleEmptyTrash(request, env) {
  const { user } = await requireUser(request, env);
  const result = await dbRun(env, 'DELETE FROM emails WHERE user_id = ? AND deleted_at IS NOT NULL', user.id);
  return ok({ removed: result.changes });
}

/** GET /api/sent/:id */
export async function handleSentGet(request, env, id) {
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
export async function handleSentDelete(request, env, id) {
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
export async function handleSend(request, env) {
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
