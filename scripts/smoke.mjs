/**
 * 冒烟检查：对一个正在运行的实例跑一遍关键流程。
 * 用法：npm run dev（另开终端）→ node scripts/smoke.mjs http://127.0.0.1:8787
 * 注意：会真的发信、新建并撤销接口密钥，只适合本地预览环境。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

async function call(path, { method = 'GET', body, token, apiKey } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

const out = [];
const ok = (label, cond, extra = '') => out.push(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);

const login = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'admin-password-1' } });
ok('管理员登录', login.data.ok === true && typeof login.data.token === 'string', `status ${login.status}`);
const token = login.data.token;

const me = await call('/api/me', { token });
ok('canSendAs=true', me.data.canSendAs === true);
ok('trashTtlDays=30', me.data.trashTtlDays === 30, String(me.data.trashTtlDays));

const inbox = await call('/api/mails?box=inbox', { token });
ok('收件箱有邮件', (inbox.data.items || []).length > 0, `${inbox.data.total} 封`);
const first = inbox.data.items[0];

const detail = await call(`/api/mails/${first.id}`, { token });
ok('详情返回正文', detail.data.ok === true && typeof detail.data.mail?.body === 'string');

// 右键菜单里的「移入垃圾箱」→「移回收件箱」
const toTrash = await call(`/api/mails/${first.id}`, { method: 'DELETE', token });
ok('移入垃圾箱', toTrash.data.ok === true && toTrash.data.deleted === true);

const trash = await call('/api/mails?box=trash', { token });
ok('垃圾箱响应带保留天数', trash.data.trashTtlDays === 30, String(trash.data.trashTtlDays));
const trashItem = (trash.data.items || []).find((item) => item.id === first.id);
ok('垃圾箱能看到该邮件', Boolean(trashItem), trashItem?.subject);
ok('垃圾箱项带删除时间', Boolean(trashItem?.deletedAt), trashItem?.deletedAt);

const restore = await call(`/api/mails/${first.id}`, { method: 'PATCH', token, body: { restore: true } });
ok('移回收件箱', restore.data.ok === true && restore.data.mail?.deleted === false, `deleted=${restore.data.mail?.deleted}`);

const created = await call('/api/keys', { method: 'POST', token, body: { name: '自动化脚本' } });
const key = created.data.key;
ok('新建接口密钥', typeof key === 'string' && key.startsWith('cm_') && key.length === 51, key ? key.slice(0, 12) + '…' : JSON.stringify(created.data));
ok('新建响应带密钥 id', Number.isInteger(created.data.id) && created.data.id > 0, String(created.data.id));

const viaKey = await call('/api/mails?box=inbox&pageSize=3', { apiKey: key });
ok('x-api-key 读取列表', viaKey.data.ok === true && (viaKey.data.items || []).length === 3);

const keyDetail = await call(`/api/mails/${first.id}`, { apiKey: key });
ok('x-api-key 读详情', keyDetail.data.ok === true && typeof keyDetail.data.mail?.subject === 'string', keyDetail.data.mail?.subject);

const sent = await call('/api/mails/send', {
  method: 'POST',
  token,
  body: { from: 'notice@example.com', to: 'chenzhou@example.com', subject: '系统公告：接口已开放', body: '现在可以用接口密钥收发邮件了。' },
});
ok('管理员代发', sent.data.ok === true && sent.data.from === 'notice@example.com', `status ${sent.status} from=${sent.data.from}`);

const badFrom = await call('/api/mails/send', {
  method: 'POST',
  token,
  body: { from: 'bad@@evil', to: 'chenzhou@example.com', subject: 'x', body: 'y' },
});
ok('非法发件人被拒绝', badFrom.status === 400 && badFrom.data.error.code === 'invalid_sender', badFrom.data.error?.code);

const prefixFrom = await call('/api/mails/send', {
  method: 'POST',
  token,
  body: { from: 'billing', to: 'chenzhou@example.com', subject: '账单通知', body: '只填前缀的代发。' },
});
ok('代发只填前缀自动补域名', prefixFrom.status === 200 && prefixFrom.data.from === 'billing@example.com', prefixFrom.data.from);

const keySend = await call('/api/mails/send', {
  method: 'POST',
  apiKey: key,
  body: { to: 'wangyutong@example.com', subject: '脚本发信', body: '来自接口密钥的测试邮件。' },
});
ok('x-api-key 发信', keySend.data.ok === true, `status ${keySend.status}`);

const sentList = await call('/api/mails?box=sent&pageSize=5', { token });
const sentHit = (sentList.data.items || []).find((item) => item.id === keySend.data.id);
ok('已发送列表能看到刚才的发件', Boolean(sentHit), `sent total=${sentList.data.total}`);

const dropSent = await call(`/api/sent/${keySend.data.id}`, { method: 'DELETE', token });
ok('已发送邮件可删除', dropSent.data.deleted === true, `status ${dropSent.status}`);
const dropAgain = await call(`/api/sent/${keySend.data.id}`, { token });
ok('删除后的发件记录查不到', dropAgain.status === 404, `status ${dropAgain.status}`);

const keys = await call('/api/keys', { token });
ok('密钥列表含新建项', (keys.data.keys || []).some((k) => k.id === created.data.id));
ok('示例文档随接口返回', Array.isArray(keys.data.docs) && keys.data.docs.length >= 6, `${keys.data.docs?.length} 条`);

const revoke = await call(`/api/keys/${created.data.id}/revoke`, { method: 'POST', token });
ok('撤销密钥', revoke.data.ok === true && revoke.data.revoked === created.data.id, JSON.stringify(revoke.data));

const keysAfter = await call('/api/keys', { token });
ok('撤销的密钥记录已彻底删除', !(keysAfter.data.keys || []).some((k) => k.id === created.data.id));

const afterRevoke = await call('/api/mails?box=inbox', { apiKey: key });
ok('撤销后接口密钥失效', afterRevoke.status === 401 && afterRevoke.data.error.code === 'invalid_api_key', afterRevoke.data.error?.code);

const page = await fetch(BASE + '/').then((res) => res.text());
ok('静态页含密钥面板', page.includes('邮件接口密钥') && page.includes('x-api-key'));

const diag = await call('/api/diagnostics', { token });
ok('收信诊断可用', diag.status === 200 && typeof diag.data.stats?.emails === 'number', JSON.stringify(diag.data.stats));
ok('诊断显示管理员与域名', Boolean(diag.data.admin?.email) && Boolean(diag.data.domain));

console.log(out.join('\n'));
console.log('\n' + (out.every((line) => line.startsWith('✓')) ? '现场检查全部通过 ✅' : '存在失败项 ❌'));
