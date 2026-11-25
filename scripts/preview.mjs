/**
 * 本地预览服务（仅开发用，不进入构建产物）。
 *
 * 用 node:sqlite 模拟 D1，把 dist/worker.js 挂到本地 HTTP 端口，
 * 并写入一批演示邮件，方便肉眼检查界面。
 *
 * 用法：node scripts/preview.mjs [端口]
 * 打开：http://127.0.0.1:8787/__preview  （自动注入会话后跳转到应用）
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from '../dist/worker.js';

const PORT = Number(process.argv[2] || 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
    return { results: this.database.prepare(this.sql).all(...this.params), success: true, meta: { changes: 0 } };
  }
  first() {
    const rows = this.database.prepare(this.sql).all(...this.params);
    return rows.length ? rows[0] : null;
  }
  run() {
    const info = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
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

/* ---------------- 环境与演示数据 ---------------- */

const env = {
  DB: new D1Database(),
  MAIL_DOMAIN: 'example.com',
  MAIL_RETENTION: '800',
  SESSION_TTL_DAYS: '7',
  EMAIL: { async send(payload) { console.log('[send]', payload.to, payload.subject); } },
};

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    {},
  );
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function seed() {
  await api('/api/setup', {
    method: 'POST',
    body: { name: '林可', email: 'admin@example.com', password: 'admin-password-1' },
  });

  const people = [
    { name: '陈舟', email: 'chenzhou@example.com' },
    { name: '王雨桐', email: 'wangyutong@example.com' },
    { name: '赵一帆', email: 'zhaoyifan@example.com' },
  ];
  for (const person of people) {
    await api('/api/users', {
      method: 'POST',
      token: (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'admin-password-1' } })).data.token,
      body: { email: person.email, name: person.name, password: 'member-password-1', role: 'user' },
    });
  }

  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  const rows = [
    {
      sender: 'notify@github.com',
      sender_name: 'GitHub',
      subject: '你在 cf-email-worker 的构建已通过',
      preview: 'workflow run #128 已完成，所有 43 项检查全部通过。',
      body: '<h2 style="margin:0 0 12px">构建成功</h2><p>你的仓库 <b>cf-email-worker</b> 最新提交已经通过全部检查。</p><ul><li>自动建表 ✔</li><li>多账号权限 ✔</li><li>界面回归 ✔</li></ul><p style="color:#666">这是一封自动发送的邮件，请勿直接回复。</p>',
      body_type: 'html',
      is_read: 0,
      is_starred: 1,
      minutes: 24,
    },
    {
      sender: 'chenzhou@example.com',
      sender_name: '陈舟',
      subject: '关于新版收件箱的几点想法',
      preview: '整体很干净，尤其是三栏布局。想确认一下附件预览后面会做吗？',
      body: '整体很干净，尤其是三栏布局和暗色模式。\n\n想确认两件事：\n1. 附件预览后面会做吗？\n2. 普通账号能不能也建账号，还是只能管理员建？\n\n陈舟',
      body_type: 'text',
      is_read: 0,
      is_starred: 0,
      minutes: 96,
    },
    {
      sender: 'billing@cloudflare.com',
      sender_name: 'Cloudflare',
      subject: '本月 Workers 用量报告',
      preview: '请求数 12.4 万，CPU 时间 38 秒，均在免费额度内。',
      body: '<p>你好，本月你的 Workers 用量如下：</p><table style="border-collapse:collapse"><tr><td style="padding:4px 12px;border-bottom:1px solid #eee">请求数</td><td style="padding:4px 12px;border-bottom:1px solid #eee"><b>124,832</b></td></tr><tr><td style="padding:4px 12px">CPU 时间</td><td style="padding:4px 12px"><b>38.2 s</b></td></tr></table><p>无需任何操作。</p>',
      body_type: 'html',
      is_read: 1,
      is_starred: 0,
      minutes: 260,
    },
    {
      sender: 'wangyutong@example.com',
      sender_name: '王雨桐',
      subject: '设计稿 v3（附 PDF）',
      preview: '按上次反馈调整了列表密度和阅读区留白，麻烦看一下。',
      body: '<p>按上次反馈调整了列表密度和阅读区留白。</p><p>主要变化：列表行高从 76 降到 68，阅读区左右留白加大，未读圆点改为强调色。</p><p>详见附件。</p>',
      body_type: 'html',
      is_read: 1,
      is_starred: 0,
      minutes: 420,
      attachments: [{ filename: 'mail-ui-v3.pdf', type: 'application/pdf', size: 284133 }],
    },
    {
      sender: 'noreply@vercel.com',
      sender_name: 'Vercel',
      subject: '你本周的项目动态',
      preview: '3 个项目有新部署，1 个域名即将到期。',
      body: '3 个项目有新部署，1 个域名即将到期。',
      body_type: 'text',
      is_read: 1,
      is_starred: 0,
      minutes: 1500,
    },
    {
      sender: 'zhaoyifan@example.com',
      sender_name: '赵一帆',
      subject: 'Re: 邮件正文里的外链图片要不要默认加载',
      preview: '建议默认不加载，点一下再放行，这样最稳妥。',
      body: '<p>建议默认不加载，点一下再放行，这样最稳妥。</p><blockquote style="border-left:3px solid #ddd;margin:0;padding-left:12px;color:#666">原来的做法是 innerHTML 直接塞进去，风险有点大。</blockquote>',
      body_type: 'html',
      is_read: 1,
      is_starred: 1,
      minutes: 2900,
    },
    {
      sender: 'security@example.com',
      sender_name: '安全中心',
      subject: '新设备登录提醒',
      preview: '检测到来自上海的登录，若非本人操作请立即修改密码。',
      body: '检测到来自上海的新设备登录。\n\n时间：今天 09:12\n设备：Windows · Edge\n\n若非本人操作，请立即在「设置」中修改密码。',
      body_type: 'text',
      is_read: 0,
      is_starred: 0,
      minutes: 4300,
    },
    {
      sender: 'account@system.trae.ai',
      sender_name: 'Trae',
      subject: 'Email Verification',
      preview: 'Your verification code is 613204.',
      // 故意按旧 Worker 的存法记成 text：用来验证读取时会自动纠正成 HTML
      body: '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<html dir="ltr" lang="en"><head><title>Verification Code</title></head><body style="margin:0;padding:32px;background:#f6f7fb">\n<table role="presentation" style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:32px"><tr><td>\n<h2 style="margin:0 0 16px;font:600 20px/1.4 sans-serif;color:#1b1e28">Verify your email</h2>\n<p style="margin:0 0 20px;font:14px/1.7 sans-serif;color:#5b6172">Use the code below to finish signing in to Trae.</p>\n<p style="margin:0 0 24px;font:600 30px/1 monospace;letter-spacing:6px;color:#4f46e5">613204</p>\n<p style="margin:0;font:12px/1.6 sans-serif;color:#9aa1b1">This code expires in 10 minutes.</p>\n</td></tr></table></body></html>',
      body_type: 'text',
      is_read: 0,
      is_starred: 0,
      minutes: 6100,
    },
  ];

  const insert = env.DB.prepare(
    `INSERT INTO emails (message_id, user_id, sender, sender_name, real_sender, receiver, subject, body, body_type, preview, attachments, is_read, is_starred, received_at, size)
     VALUES (?, 1, ?, ?, ?, 'admin@example.com', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((row, index) => {
    insert
      .bind(
        `demo-${index}@example.com`,
        row.sender,
        row.sender_name,
        row.sender,
        row.subject,
        row.body,
        row.body_type,
        row.preview,
        JSON.stringify(row.attachments || []),
        row.is_read,
        row.is_starred,
        ago(row.minutes),
        row.body.length + 512,
      )
      .run();
  });

  // 垃圾箱演示：7 天前删除的推广邮件
  env.DB.prepare(
    `INSERT INTO emails (message_id, user_id, sender, sender_name, real_sender, receiver, subject, body, body_type, preview, attachments, is_read, is_starred, deleted_at, received_at, size)
     VALUES ('demo-trash@example.com', 1, 'promo@shop-mail.example', '限时优惠', 'promo@shop-mail.example', 'admin@example.com', '双十一预热：全场 5 折起', '错过再等一年，点击查看详情。', 'text', '错过再等一年，点击查看详情。', '[]', 1, 0, ?, ?, 1024)`,
  )
    .bind(ago(60 * 24 * 7), ago(60 * 24 * 8))
    .run();

  const sent = env.DB.prepare(
    `INSERT INTO sends (user_id, sender, receiver, subject, body, status, sent_at)
     VALUES (1, 'admin@example.com', ?, ?, ?, 'sent', ?)`,
  );
  sent.bind('chenzhou@example.com', 'Re: 关于新版收件箱的几点想法', '附件预览排在下一版，普通账号由管理员统一创建，后面会开放邀请链接。', ago(60)).run();
  sent.bind('client@acme.co', '报价单与排期', '附件是本季度排期，麻烦确认。', ago(1800)).run();

  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'admin-password-1' } });
  return login.data.token;
}

/* ---------------- HTTP 服务 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const token = await seed();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);

  // 开发辅助：注入会话后跳转，方便截图和本地体验
  if (url.pathname === '/__preview') {
    const logout = url.searchParams.get('logout') === '1';
    const theme = url.searchParams.get('theme') || 'light';
    const html = `<!doctype html><meta charset="utf-8"><title>预览</title>
<script>
  ${logout ? "localStorage.removeItem('cm.token');" : `localStorage.setItem('cm.token', ${JSON.stringify(token)});`}
  localStorage.setItem('cm.theme', ${JSON.stringify(theme)});
  location.replace('/');
</script>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 开发辅助：模拟一封入站邮件，用来验证「无主邮件归管理员」
  if (url.pathname === '/__deliver') {
    const to = url.searchParams.get('to') || 'stranger@example.com';
    const from = url.searchParams.get('from') || 'robot@notice.example';
    const subject = url.searchParams.get('subject') || 'Orphan probe';
    const messageId = `<${Date.now()}@preview>`;
    const raw = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      '这封邮件的收件地址没有对应账号，应当自动归到管理员。',
    ].join('\r\n');
    await worker.email(
      { to, from, headers: new Headers({ to, from, subject, 'message-id': messageId }), raw },
      env,
      {},
    );
    const row = env.DB.query('SELECT id, user_id, receiver FROM emails WHERE message_id = ?', messageId)[0];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, mail: row || null }));
    return;
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const request = new Request(`${ORIGIN}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: body && body.length ? body : undefined,
  });

  try {
    const response = await worker.fetch(request, env, {});
    const buffer = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(buffer);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error && error.stack ? error.stack : error));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`预览地址：${ORIGIN}/__preview`);
  console.log(`登录页：  ${ORIGIN}/__preview?logout=1`);
});
