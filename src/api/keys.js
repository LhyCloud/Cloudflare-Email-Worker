/**
 * API 密钥管理接口。
 *
 * 密钥用于让脚本 / 第三方系统直接调用收发邮件接口，不必模拟网页登录：
 *   curl -H "x-api-key: cm_xxx" https://mail.example.com/api/mails
 */
import { API_KEY_PREFIX, createApiKey, listApiKeys, revokeApiKey } from '../lib/apikeys.js';
import { HttpError, ok, readJson, requireUser } from '../lib/http.js';
import { str } from '../lib/util.js';

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
export async function handleKeyList(request, env) {
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
export async function handleKeyCreate(request, env) {
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
export async function handleKeyRevoke(request, env, id) {
  const { user } = await requireUser(request, env);
  const removed = await revokeApiKey(env, user.id, id);
  if (!removed) throw new HttpError(404, 'not_found', '密钥不存在');
  return ok({ revoked: id, deleted: true });
}
