/**
 * 零依赖集成测试：用 node:sqlite 模拟 D1，直接驱动构建产物 dist/worker.js。
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../dist/worker.js';

/* ---------------- D1 兼容层 ---------------- */

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  all() {
    const rows = this.database.prepare(this.sql).all(...this.params);
    return { results: rows, success: true, meta: { changes: 0 } };
  }
  first() {
    const rows = this.database.prepare(this.sql).all(...this.params);
    return rows.length ? rows[0] : null;
  }
  run() {
    const info = this.database.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) },
    };
  }
}

class D1Database {
  constructor() {
    this.database = new DatabaseSync(':memory:');
  }
  prepare(sql) {
    return new D1Statement(this.database, sql);
  }
  exec(sql) {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }
  query(sql, ...params) {
    return this.database.prepare(sql).all(...params);
  }
}

/* ---------------- 测试环境 ---------------- */

const sentMessages = [];
const env = {
  DB: new D1Database(),
  MAIL_DOMAIN: 'example.com',
  MAIL_RETENTION: '500',
  SESSION_TTL_DAYS: '7',
  EMAIL: {
    async send(payload) {
      if (payload.to === 'blocked@example.com') throw new Error('not a verified address');
      sentMessages.push(payload);
    },
  },
};

const BASE = 'https://mail.example.com';
let passed = 0;

function check(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function call(path, { method = 'GET', token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    {},
  );
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers, text };
}

function buildRaw({ from, to, subject, messageId, html, text, attachment }) {
  const boundary = 'bnd-1234567890';
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="alt-${boundary}"`,
    '',
    `--alt-${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    text,
    '',
    `--alt-${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    '',
    html,
    '',
    `--alt-${boundary}--`,
    '',
  ];
  if (attachment) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.type}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      Buffer.from(attachment.content).toString('base64'),
      '',
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

function makeMessage({ from, to, subject, messageId, html, text, attachment }) {
  const raw = buildRaw({ from, to, subject, messageId, html, text, attachment });
  return {
    from,
    to,
    headers: new Headers({
      from,
      to,
      subject: `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      'message-id': messageId,
    }),
    raw: new Response(raw).body,
    rawSize: Buffer.byteLength(raw),
  };
}

/* ---------------- 测试用例 ---------------- */

async function main() {
  console.log('\n[1] 自动建表与初始化');
  let res = await call('/api/setup');
  assert.equal(res.status, 200);
  assert.equal(res.data.needsSetup, true);
  assert.equal(res.data.domain, 'example.com');
  check('首次访问提示需要初始化，域名来自环境变量');

  res = await call('/api/setup', { method: 'POST', body: { email: 'admin@example.com', password: 'short' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'weak_password');
  check('拒绝弱密码');

  res = await call('/api/setup', {
    method: 'POST',
    body: { name: '站长', email: 'Admin@Example.com', password: 'admin-password-1' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const adminToken = res.data.token;
  assert.equal(res.data.user.role, 'admin');
  assert.equal(res.data.user.email, 'admin@example.com');
  check('初始化管理员（邮箱自动规范化）');

  const tables = env.DB.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  for (const table of ['users', 'sessions', 'emails', 'sends', 'login_attempts', 'api_keys']) {
    assert.ok(tables.includes(table), `缺少表 ${table}`);
  }
  check(`自动创建数据表：${tables.join(', ')}`);

  res = await call('/api/setup', { method: 'POST', body: { email: 'x@example.com', password: 'whatever-123' } });
  assert.equal(res.status, 403);
  check('初始化接口在已有账号后关闭');

  console.log('\n[2] 登录与权限');
  res = await call('/api/me', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.mailbox, 'admin');
  assert.deepEqual(res.data.counts, { unread: 0, starred: 0, trash: 0, inbox: 0, sent: 0 });
  check('管理员会话可用，计数从 0 开始');
  assert.equal(res.data.mailRetention, 500);
  assert.equal(res.data.trashTtlDays, 30);
  check('保留策略随环境变量下发给前端');

  res = await call('/api/me', { token: 'not-a-token' });
  assert.equal(res.status, 401);
  check('无效令牌被拒绝');

  res = await call('/api/users', {
    method: 'POST',
    token: adminToken,
    body: { email: 'lin@example.com', name: '林可', password: 'member-password-1', role: 'user' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const memberId = res.data.user.id;
  assert.equal(res.data.user.role, 'user');
  check('管理员创建普通账号');

  res = await call('/api/users', {
    method: 'POST',
    token: adminToken,
    body: { email: 'lin@example.com', password: 'member-password-2' },
  });
  assert.equal(res.status, 409);
  check('重复邮箱被拒绝');

  res = await call('/api/auth/login', { method: 'POST', body: { email: 'lin@example.com', password: 'wrong-password' } });
  assert.equal(res.status, 401);
  check('错误密码登录失败');

  res = await call('/api/auth/login', { method: 'POST', body: { email: 'lin@example.com', password: 'member-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  let memberToken = res.data.token;
  check('普通账号可以登录');

  res = await call('/api/users', { token: memberToken });
  assert.equal(res.status, 403);
  check('普通账号无法访问用户管理接口');

  console.log('\n[3] 收信');
  await worker.email(
    makeMessage({
      from: 'GitHub <noreply@github.com>',
      to: 'lin@example.com',
      subject: '新的登录提醒',
      messageId: 'mail-1@github.com',
      text: '纯文本版本',
      html: '<p>你好，这是 <b>HTML</b> 正文。</p><img src="https://tracker.example.com/pixel.png">',
      attachment: { filename: 'report.pdf', type: 'application/pdf', content: 'pdf-binary-data' },
    }),
    env,
    {},
  );
  check('收信处理器正常解析 MIME');

  res = await call('/api/mails?box=inbox', { token: memberToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 1);
  const mail = res.data.items[0];
  assert.equal(mail.subject, '新的登录提醒');
  assert.equal(mail.isRead, false);
  assert.equal(mail.hasAttachments, true);
  assert.equal(mail.fromName, 'GitHub');
  const mailId = mail.id;
  check('邮件归入对应账号的收件箱（含附件标记）');

  res = await call(`/api/mails/${mailId}`, { token: memberToken });
  assert.equal(res.data.mail.bodyType, 'html');
  assert.equal(res.data.mail.attachments.length, 1);
  assert.equal(res.data.mail.attachments[0].filename, 'report.pdf');
  check('详情返回 HTML 正文与附件元信息');

  await worker.email(
    makeMessage({
      from: 'noreply@github.com',
      to: 'lin@example.com',
      subject: '新的登录提醒',
      messageId: 'mail-1@github.com',
      text: '重复投递',
      html: '<p>重复</p>',
    }),
    env,
    {},
  );
  res = await call('/api/mails?box=inbox', { token: memberToken });
  assert.equal(res.data.total, 1);
  check('Message-ID 去重生效');

  await worker.email(
    makeMessage({
      from: 'spam@unknown.tld',
      to: 'nobody@example.com',
      subject: '未分配邮件',
      messageId: 'mail-2@unknown.tld',
      text: 'hi',
      html: '<p>hi</p>',
    }),
    env,
    {},
  );
  const adminRow = env.DB.query('SELECT id FROM users WHERE role = ?', 'admin')[0];
  const orphan = env.DB.query('SELECT user_id, receiver FROM emails WHERE message_id = ?', 'mail-2@unknown.tld');
  assert.equal(orphan.length, 1);
  assert.equal(Number(orphan[0].user_id), Number(adminRow.id));
  assert.equal(orphan[0].receiver, 'nobody@example.com');
  res = await call('/api/mails?box=inbox&q=未分配', { token: adminToken });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].to, 'nobody@example.com');
  check('无主邮件自动归到管理员（收件地址原样保留）');

  console.log('\n[4] 邮件操作');
  res = await call(`/api/mails/${mailId}`, { method: 'PATCH', token: memberToken, body: { isRead: true } });
  assert.equal(res.data.mail.isRead, true);
  res = await call('/api/me', { token: memberToken });
  assert.equal(res.data.counts.unread, 0);
  check('标记已读并同步未读数');

  res = await call(`/api/mails/${mailId}`, { method: 'PATCH', token: memberToken, body: { isStarred: true } });
  assert.equal(res.data.mail.isStarred, true);
  res = await call('/api/mails?box=starred', { token: memberToken });
  assert.equal(res.data.total, 1);
  check('星标筛选可用');

  res = await call('/api/mails?box=inbox&q=登录', { token: memberToken });
  assert.equal(res.data.total, 1);
  res = await call('/api/mails?box=inbox&q=不存在的关键词', { token: memberToken });
  assert.equal(res.data.total, 0);
  check('关键词搜索生效');

  res = await call(`/api/mails/${mailId}`, { method: 'DELETE', token: memberToken });
  assert.equal(res.data.permanent, false);
  res = await call('/api/mails?box=trash', { token: memberToken });
  assert.equal(res.data.total, 1);
  check('删除先进入垃圾箱');

  res = await call(`/api/mails/${mailId}`, { token: adminToken });
  assert.equal(res.status, 404);
  check('无法读取他人邮件');

  res = await call('/api/mails/trash/empty', { method: 'POST', token: memberToken });
  assert.equal(res.data.removed, 1);
  res = await call('/api/mails?box=trash', { token: memberToken });
  assert.equal(res.data.total, 0);
  check('清空垃圾箱');

  console.log('\n[5] 发信');
  res = await call('/api/mails/send', {
    method: 'POST',
    token: memberToken,
    body: { to: 'friend@example.net', subject: '你好', body: '这是一封测试邮件' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.from, 'lin@example.com');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].from.email, 'lin@example.com');
  check('发件人固定为登录账号');

  res = await call('/api/mails?box=sent', { token: memberToken });
  assert.equal(res.data.total, 1);
  const sentId = res.data.items[0].id;
  res = await call(`/api/sent/${sentId}`, { token: memberToken });
  assert.equal(res.data.mail.subject, '你好');
  check('已发送列表与详情');

  res = await call('/api/mails/send', {
    method: 'POST',
    token: memberToken,
    body: { to: 'blocked@example.com', subject: '失败', body: '内容' },
  });
  assert.equal(res.status, 502);
  assert.equal(res.data.error.code, 'recipient_unverified');
  check('发信失败时给出可读提示');

  res = await call('/api/mails/send', { method: 'POST', token: memberToken, body: { to: 'bad-address', body: 'x' } });
  assert.equal(res.status, 400);
  check('非法收件人地址被拒绝');

  res = await call('/api/mails/send', { method: 'POST', token: memberToken, body: { to: 'a@b.com', body: '   ' } });
  assert.equal(res.status, 400);
  check('空正文被拒绝');

  res = await call('/api/mails/send', {
    method: 'POST',
    token: memberToken,
    body: { to: 'friend@example.net', subject: '待删除', body: '这封会被删掉' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const doomedId = res.data.id;
  res = await call(`/api/sent/${doomedId}`, { token: memberToken });
  assert.equal(res.status, 200);
  res = await call(`/api/sent/${doomedId}`, { method: 'DELETE', token: adminToken });
  assert.equal(res.status, 404);
  check('无法删除他人的发件记录');
  res = await call(`/api/sent/${doomedId}`, { method: 'DELETE', token: memberToken });
  assert.equal(res.data.deleted, true);
  res = await call(`/api/sent/${doomedId}`, { token: memberToken });
  assert.equal(res.status, 404);
  res = await call('/api/mails?box=sent', { token: memberToken });
  assert.ok(!res.data.items.some((item) => item.id === doomedId));
  check('已发送邮件可删除');

  console.log('\n[6] 账号安全');
  res = await call('/api/me/password', {
    method: 'POST',
    token: memberToken,
    body: { currentPassword: 'wrong', newPassword: 'member-password-2' },
  });
  assert.equal(res.status, 400);
  check('修改密码需校验当前密码');

  res = await call('/api/me/password', {
    method: 'POST',
    token: memberToken,
    body: { currentPassword: 'member-password-1', newPassword: 'member-password-2' },
  });
  assert.equal(res.status, 200);
  res = await call('/api/me', { token: memberToken });
  assert.equal(res.status, 200);
  check('改密后当前会话保留');

  res = await call('/api/auth/login', { method: 'POST', body: { email: 'lin@example.com', password: 'member-password-1' } });
  assert.equal(res.status, 401);
  res = await call('/api/auth/login', { method: 'POST', body: { email: 'lin@example.com', password: 'member-password-2' } });
  assert.equal(res.status, 200);
  memberToken = res.data.token;
  check('新密码可登录，旧密码失效');

  res = await call(`/api/users/${memberId}/password`, {
    method: 'POST',
    token: adminToken,
    body: { password: 'reset-password-9' },
  });
  assert.equal(res.status, 200);
  res = await call('/api/me', { token: memberToken });
  assert.equal(res.status, 401);
  check('管理员重置密码后旧会话立即失效');

  res = await call(`/api/users/${memberId}`, { method: 'PATCH', token: adminToken, body: { status: 'disabled' } });
  assert.equal(res.status, 200);
  res = await call('/api/auth/login', { method: 'POST', body: { email: 'lin@example.com', password: 'reset-password-9' } });
  assert.equal(res.status, 403);
  check('停用账号无法登录');

  res = await call(`/api/users/${memberId}`, { method: 'PATCH', token: adminToken, body: { status: 'active' } });
  assert.equal(res.status, 200);
  check('可重新启用账号');

  const adminId = (await call('/api/me', { token: adminToken })).data.user.id;
  res = await call(`/api/users/${adminId}`, { method: 'PATCH', token: adminToken, body: { role: 'user' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'self_lockout');
  check('禁止把自己降级');

  res = await call(`/api/users/${adminId}`, { method: 'DELETE', token: adminToken });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'self_delete');
  check('禁止删除自己');

  console.log('\n[7] 用户删除与级联');
  res = await call('/api/users', { method: 'POST', token: adminToken, body: { email: 'temp@example.com', password: 'temp-password-1' } });
  const tempId = res.data.user.id;
  await worker.email(
    makeMessage({
      from: 'x@y.z',
      to: 'temp@example.com',
      subject: '临时',
      messageId: 'temp-1@y.z',
      text: 't',
      html: '<p>t</p>',
    }),
    env,
    {},
  );
  res = await call(`/api/users/${tempId}`, { method: 'DELETE', token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', tempId)[0].n, 0);
  check('删除账号时清理其邮件');

  res = await call('/api/admin/overview', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.data.stats.users >= 2);
  assert.ok(res.data.stats.sent >= 1);
  check('管理概览统计');

  console.log('\n[8] 静态页面与错误处理');
  res = await worker.fetch(new Request(`${BASE}/`), env, {});
  const page = await res.text();
  assert.equal(res.status, 200);
  assert.ok(page.includes('Cloud Mail'));
  assert.ok(page.includes('初始化 Cloud Mail') || page.includes('auth-form'));
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
  check('首页返回内联界面并带 CSP');

  res = await worker.fetch(new Request(`${BASE}/?utm=1&x=%E4%BD%A0%E5%A5%BD`), env, {});
  assert.equal(res.status, 200);
  check('任意路径参数都返回界面（不再出现“外部链接”）');

  res = await call('/api/does-not-exist');
  assert.equal(res.status, 404);
  check('未知接口返回 404 JSON');

  res = await call('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  check('健康检查');

  res = await call('/api/mails');
  assert.equal(res.status, 401);
  check('未登录访问邮件接口返回 401');

  console.log('\n[9] 代发 / 垃圾箱清理 / 接口密钥');
  res = await call('/api/auth/login', { method: 'POST', body: { email: 'lin@example.com', password: 'reset-password-9' } });
  assert.equal(res.status, 200);
  memberToken = res.data.token;

  res = await call('/api/me', { token: memberToken });
  assert.equal(res.data.canSendAs, false);
  assert.equal(res.data.trashTtlDays, 30);
  check('普通账号不可代发，垃圾箱保留 30 天');

  res = await call('/api/me', { token: adminToken });
  assert.equal(res.data.canSendAs, true);
  check('管理员 canSendAs = true');

  res = await call('/api/mails/send', {
    method: 'POST',
    token: memberToken,
    body: { to: 'friend@example.net', from: 'boss@example.com', subject: '代发', body: 'x' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.data.error.code, 'forbidden_from');
  check('普通账号指定发件人被拒绝');

  res = await call('/api/mails/send', {
    method: 'POST',
    token: adminToken,
    body: { to: 'friend@example.net', from: 'Notice@Example.com', subject: '系统通知', body: '维护公告' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.from, 'notice@example.com');
  assert.equal(sentMessages[sentMessages.length - 1].from.email, 'notice@example.com');
  check('管理员可指定发件人，实际投递使用该地址');

  res = await call('/api/mails/send', {
    method: 'POST',
    token: adminToken,
    body: { to: 'friend@example.net', from: 'billing', subject: '前缀代发', body: 'y' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.from, 'billing@example.com');
  check('代发地址只填前缀时自动补域名');

  res = await call('/api/mails/send', {
    method: 'POST',
    token: adminToken,
    body: { to: 'friend@example.net', from: 'bad@@evil', subject: 'x', body: 'y' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'invalid_sender');
  check('非法发件人地址被拒绝');

  await worker.email(
    makeMessage({ from: 'a@b.c', to: 'lin@example.com', subject: '待删除', messageId: 'trash-1@b.c', text: 'x', html: '<p>x</p>' }),
    env,
    {},
  );
  let list = await call('/api/mails?box=inbox&q=待删除', { token: memberToken });
  const trashId = list.data.items[0].id;
  res = await call(`/api/mails/${trashId}`, { method: 'DELETE', token: memberToken });
  assert.equal(res.data.permanent, false);
  list = await call('/api/mails?box=trash', { token: memberToken });
  assert.equal(list.data.trashTtlDays, 30);
  assert.ok(list.data.items.some((row) => row.id === trashId));
  check('删除进垃圾箱，接口返回保留天数');

  env.DB.query(
    'UPDATE emails SET deleted_at = ? WHERE id = ?',
    new Date(Date.now() - 31 * 86400000).toISOString(),
    trashId,
  );
  list = await call('/api/mails?box=trash', { token: memberToken });
  assert.ok(!list.data.items.some((row) => row.id === trashId));
  assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM emails WHERE id = ?', trashId)[0].n, 0);
  check('超过 30 天的垃圾箱邮件自动清除');

  await worker.email(
    makeMessage({ from: 'a@b.c', to: 'lin@example.com', subject: '恢复我', messageId: 'restore-1@b.c', text: 'x', html: '<p>x</p>' }),
    env,
    {},
  );
  list = await call('/api/mails?box=inbox&q=恢复我', { token: memberToken });
  const restoreId = list.data.items[0].id;
  await call(`/api/mails/${restoreId}`, { method: 'DELETE', token: memberToken });
  res = await call(`/api/mails/${restoreId}`, { method: 'PATCH', token: memberToken, body: { restore: true } });
  assert.equal(res.status, 200);
  assert.equal(res.data.mail.deleted, false);
  list = await call('/api/mails?box=inbox&q=恢复我', { token: memberToken });
  assert.equal(list.data.total, 1);
  check('垃圾箱邮件可恢复');

  res = await call('/api/keys', { token: memberToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.keys.length, 0);
  check('初始没有接口密钥');

  res = await call('/api/keys', { method: 'POST', token: memberToken, body: { name: '监控机器人' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const apiKey = res.data.key;
  assert.ok(apiKey.startsWith('cm_'));
  assert.equal(apiKey.length, 3 + 48);
  assert.ok(res.data.masked.includes('…'));
  assert.ok(Number.isInteger(res.data.id) && res.data.id > 0, '创建响应应带密钥 id');
  check(`创建密钥，明文只返回一次（${res.data.masked}）`);

  res = await call('/api/mails', { apiKey });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  check('用 x-api-key 读取邮件列表');

  res = await call('/api/mails/send', {
    method: 'POST',
    apiKey,
    body: { to: 'api@example.net', subject: '来自接口', body: 'hello' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.from, 'lin@example.com');
  check('用 x-api-key 发信');

  res = await call('/api/users', { apiKey });
  assert.equal(res.status, 403);
  check('普通账号的密钥没有管理权限');

  res = await call('/api/keys', { method: 'POST', token: adminToken, body: { name: '管理员机器人' } });
  const adminKey = res.data.key;
  res = await call('/api/mails/send', {
    method: 'POST',
    apiKey: adminKey,
    body: { to: 'api@example.net', from: 'billing@example.com', subject: '账单', body: 'hi' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.from, 'billing@example.com');
  check('管理员密钥同样可以代发');

  const keyList = await call('/api/keys', { token: memberToken });
  const keyId = keyList.data.keys[0].id;
  res = await call(`/api/keys/${keyId}/revoke`, { method: 'POST', token: memberToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.deleted, true);
  res = await call('/api/mails', { apiKey });
  assert.equal(res.status, 401);
  assert.equal(res.data.error.code, 'invalid_api_key');
  check('撤销后密钥立即失效');

  res = await call('/api/keys', { token: memberToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.keys.some((k) => k.id === keyId), false, JSON.stringify(res.data.keys));
  check('撤销的密钥记录被彻底删除（列表里不再出现）');

  res = await call(`/api/keys/${keyId}/revoke`, { method: 'POST', token: memberToken });
  assert.equal(res.status, 404);
  check('重复撤销返回 404');

  // 旧版本用 revoked_at 标记撤销，读取列表时应被顺手清掉
  const meRes = await call('/api/me', { token: memberToken });
  const legacyOwnerId = String(meRes.data.user.id);
  env.DB.query(
    'INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
    legacyOwnerId,
    '历史残留',
    'legacy-hash',
    'cm_legacy…0000',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  res = await call('/api/keys', { token: memberToken });
  assert.equal(res.data.keys.some((k) => k.name === '历史残留'), false, JSON.stringify(res.data.keys));
  assert.equal(env.DB.query('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NOT NULL')[0].n, 0);
  check('旧版「已撤销」密钥在读取列表时被清理');

  res = await call('/api/mails', { apiKey: 'cm_deadbeefdeadbeef' });
  assert.equal(res.status, 401);
  check('伪造密钥被拒绝');

  console.log('\n[10] HTML 正文识别（含只发 HTML 与旧版遗留数据）');
  // 情况一：只带 HTML、连 Content-Type 都没写（按 RFC 会退回 text/plain）
  const htmlOnly = [
    'From: Trae <account@system.trae.ai>',
    'To: lin@example.com',
    'Subject: =?UTF-8?B?' + Buffer.from('Email Verification', 'utf8').toString('base64') + '?=',
    'Message-ID: <trae-html-1@system.trae.ai>',
    'MIME-Version: 1.0',
    '',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html dir="ltr" lang="en"><head><title>Verification Code</title></head>',
    '<body><table><tr><td><p>Your code is <b>123456</b></p></td></tr></table></body></html>',
  ].join('\r\n');
  await worker.email(
    {
      from: 'account@system.trae.ai',
      to: 'lin@example.com',
      headers: new Headers({ from: 'account@system.trae.ai', to: 'lin@example.com', subject: 'Email Verification' }),
      raw: new Response(htmlOnly).body,
      rawSize: Buffer.byteLength(htmlOnly),
    },
    env,
    {},
  );
  const htmlRow = env.DB.query("SELECT id, body_type FROM emails WHERE message_id = ?", '<trae-html-1@system.trae.ai>')[0];
  assert.equal(htmlRow.body_type, 'html');
  res = await call(`/api/mails/${htmlRow.id}`, { token: memberToken });
  assert.equal(res.data.mail.bodyType, 'html');
  assert.match(res.data.mail.body, /<!DOCTYPE html/i);
  check('没写 Content-Type 的纯 HTML 邮件按 HTML 存储与返回');

  // 情况二：旧 Worker / 旧版本写进去的正文，body_type 记成了 text
  const memberRow = env.DB.query("SELECT id FROM users WHERE email = 'lin@example.com'")[0];
  env.DB.query(
    "INSERT INTO emails (message_id, user_id, sender, receiver, subject, body, body_type, preview, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    'legacy-html@old.worker',
    memberRow.id,
    'noreply@old.worker',
    'lin@example.com',
    '旧版遗留的 HTML',
    '<!DOCTYPE html><html><body><p>旧的 HTML 正文</p><img src="https://cdn.example.com/a.png"></body></html>',
    'text',
    '旧的 HTML 正文',
    new Date().toISOString(),
  );
  const legacyRow = env.DB.query("SELECT id FROM emails WHERE message_id = 'legacy-html@old.worker'")[0];
  res = await call(`/api/mails/${legacyRow.id}`, { token: memberToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.mail.bodyType, 'html');
  check('旧版存成 text 的 HTML 正文在读取时被纠正为 html');

  console.log('\n[11] 发件人显示名清洗 + 收信诊断');
  // QQ 邮箱常见写法：From: "=?UTF-8?B?...?=" <x@qq.com>，引号包着编码串
  const qqName = '星夜_Lhy';
  await worker.email(
    makeMessage({
      from: `"=?UTF-8?B?${Buffer.from(qqName, 'utf8').toString('base64')}?=" <rain@qq.com>`,
      to: 'lin@example.com',
      subject: 'QQ 来信',
      messageId: 'qq-quoted-1@qq.com',
      text: 'hello',
    }),
    env,
    {},
  );
  const qqRow = env.DB.query("SELECT id FROM emails WHERE message_id = 'qq-quoted-1@qq.com'")[0];
  res = await call(`/api/mails/${qqRow.id}`, { token: memberToken });
  assert.equal(res.data.mail.fromName, qqName, JSON.stringify(res.data.mail.fromName));
  check('被引号包裹的显示名不会残留引号');

  // 已经写进库的脏数据也要在读取时修正（不改库）
  env.DB.query("UPDATE emails SET sender_name = ? WHERE id = ?", `${qqName}"`, qqRow.id);
  res = await call(`/api/mails/${qqRow.id}`, { token: memberToken });
  assert.equal(res.data.mail.fromName, qqName);
  res = await call('/api/mails?box=inbox&q=QQ', { token: memberToken });
  assert.equal(res.data.items[0].fromName, qqName);
  check('旧数据里的残留引号在读取时被清洗');

  res = await call('/api/diagnostics', { token: memberToken });
  assert.equal(res.status, 403);
  check('诊断接口仅管理员可用');

  res = await call('/api/diagnostics', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.admin.email, 'admin@example.com');
  assert.equal(Number.isInteger(res.data.stats.emails), true);
  assert.equal(Array.isArray(res.data.users) && res.data.users.length >= 2, true);
  check('管理员可以拿到诊断信息（域名/账号/统计）');

  // 模拟旧版本留下的滞留邮件
  env.DB.query(
    `INSERT INTO emails (message_id, user_id, sender, receiver, subject, body, body_type, preview, attachments, is_read, is_starred, received_at, size)
     VALUES (?, NULL, ?, ?, ?, ?, 'text', ?, '[]', 0, 0, ?, ?)`,
    'stranded-1@old.worker',
    'old@old.worker',
    'ghost@example.com',
    '滞留邮件',
    'x',
    'x',
    new Date().toISOString(),
    100,
  );
  res = await call('/api/diagnostics', { token: adminToken });
  assert.equal(res.data.stats.orphans, 1);
  assert.equal(res.data.stranded[0].receiver, 'ghost@example.com');
  check('诊断能列出滞留的无主邮件');

  res = await call('/api/diagnostics/adopt', { method: 'POST', token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.moved, 1);
  const adopted = env.DB.query("SELECT user_id FROM emails WHERE message_id = 'stranded-1@old.worker'")[0];
  assert.equal(Number(adopted.user_id), Number(env.DB.query("SELECT id FROM users WHERE email = 'admin@example.com'")[0].id));
  res = await call('/api/diagnostics', { token: adminToken });
  assert.equal(res.data.stats.orphans, 0);
  check('一键把滞留邮件归到管理员');

  console.log('\n[12] 全站保留上限');
  env.MAIL_RETENTION = '20';
  const bulkMemberId = Number(env.DB.query("SELECT id FROM users WHERE email = 'lin@example.com'")[0].id);
  for (let i = 0; i < 24; i += 1) {
    await worker.email(
      makeMessage({
        from: 'bulk@example.org',
        to: i % 2 === 0 ? 'lin@example.com' : 'admin@example.com',
        subject: `批量 ${i}`,
        messageId: `bulk-${i}@example.org`,
        text: `第 ${i} 封`,
      }),
      env,
      {},
    );
  }
  const totalLeft = Number(env.DB.query('SELECT COUNT(*) AS n FROM emails')[0].n);
  assert.equal(totalLeft, 20);
  const newestSubject = env.DB.query('SELECT subject FROM emails ORDER BY id DESC LIMIT 1')[0].subject;
  assert.equal(newestSubject, '批量 23');
  const remaining = env.DB.query('SELECT COUNT(*) AS n FROM emails WHERE subject LIKE ?', '批量%')[0].n;
  assert.equal(Number(remaining), 20);
  const memberLeft = Number(env.DB.query('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', bulkMemberId)[0].n);
  assert.ok(memberLeft < 20 && memberLeft > 0);
  check('全站最多留 20 封，超出后清理最旧的（跨账号一起算）');

  env.MAIL_RETENTION = '0';
  const beforeUnlimited = Number(env.DB.query('SELECT COUNT(*) AS n FROM emails')[0].n);
  for (let i = 0; i < 3; i += 1) {
    await worker.email(
      makeMessage({
        from: 'bulk@example.org',
        to: 'lin@example.com',
        subject: `不限 ${i}`,
        messageId: `nolimit-${i}@example.org`,
        text: `第 ${i} 封`,
      }),
      env,
      {},
    );
  }
  assert.equal(Number(env.DB.query('SELECT COUNT(*) AS n FROM emails')[0].n), beforeUnlimited + 3);
  check('MAIL_RETENTION=0 表示不限，不清理');
  env.MAIL_RETENTION = '500';

  console.log(`\n全部通过：${passed} 项检查 ✅\n`);
}

main().catch((error) => {
  console.error('\n测试失败：', error.message);
  if (error.actual !== undefined) console.error('  actual:', error.actual, '\n  expected:', error.expected);
  process.exitCode = 1;
});
