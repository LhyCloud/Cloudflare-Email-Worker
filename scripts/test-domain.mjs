/**
 * 域名自动识别 / 地址自动补全的专项测试。
 * 运行：node scripts/test-domain.mjs（由 npm test 串起来跑）
 *
 * 覆盖：
 *   1. MAIL_DOMAIN 已配置时，初始化向导默认 admin@<域名>，只填前缀也能建号 / 登录；
 *   2. 域名未知时给出可读的错误，填了完整地址后把域名学下来；
 *   3. 收到第一封邮件就自动学到收件域名；
 *   4. ADMIN_PASSWORD 引导管理员时默认 admin@<域名>（ADMIN_EMAIL 可只填前缀）；
 *   5. 访问域名是 mail.example.com 这类自定义域名时也能推断。
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

/* ---------------- 环境 ---------------- */

const ORIGIN = 'https://cloud-mail.demo-subdomain.workers.dev';

function makeEnv(overrides = {}) {
  return {
    DB: new D1Database(),
    MAIL_RETENTION: '500',
    SESSION_TTL_DAYS: '7',
    EMAIL: { async send() {} },
    ...overrides,
  };
}

let passed = 0;
function check(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function call(env, path, { method = 'GET', token, body, origin = ORIGIN } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(origin + path, init), env);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data, text };
}

async function deliver(env, to, subject = 'Domain probe') {
  const raw = [
    'From: "外部发件人" <sender@remote.test>',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@remote.test>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    '这是一封用来验证域名自动识别的邮件。',
  ].join('\r\n');
  await worker.email(
    {
      from: 'sender@remote.test',
      to,
      headers: new Headers({ from: 'sender@remote.test', to, subject }),
      raw: new Response(raw).body,
      rawSize: raw.length,
    },
    env,
    { waitUntil() {} },
  );
}

/* ---------------- 1. 配置了 MAIL_DOMAIN ---------------- */

async function scenarioConfigured() {
  console.log('\n[1] 配置了 MAIL_DOMAIN：管理员默认 admin@<域名>');
  const env = makeEnv({ MAIL_DOMAIN: 'example.com' });

  let res = await call(env, '/api/setup');
  assert.equal(res.data.domain, 'example.com');
  assert.equal(res.data.defaultAdmin, 'admin@example.com');
  assert.equal(res.data.needsSetup, true);
  check('GET /api/setup 返回自动识别的域名与默认管理员地址');

  res = await call(env, '/api/setup', { method: 'POST', body: { password: 'admin-password-1' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.email, 'admin@example.com');
  assert.equal(res.data.user.role, 'admin');
  check('不填邮箱即可初始化，账号自动为 admin@example.com');

  res = await call(env, '/api/setup');
  assert.equal(res.data.needsSetup, false);
  assert.equal(res.data.userCount, 1);
  check('初始化后 needsSetup 变为 false');

  res = await call(env, '/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'admin-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.token);
  const token = res.data.token;
  check('登录只填前缀 admin 也能通过');

  res = await call(env, '/api/users', {
    method: 'POST',
    token,
    body: { email: 'chenzhou', password: 'member-password-1', name: '陈舟' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.email, 'chenzhou@example.com');
  check('新建账号只填前缀，自动补成 chenzhou@example.com');

  res = await call(env, '/api/users', { method: 'POST', token, body: { email: 'chenzhou', password: 'member-password-1' } });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, 'email_taken');
  check('前缀重复时返回 409 email_taken');

  res = await call(env, '/api/users', { method: 'POST', token, body: { email: 'bad@@x', password: 'member-password-1' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'invalid_email');
  check('非法地址返回 400 invalid_email');

  res = await call(env, '/api/users', { method: 'POST', token, body: { password: 'member-password-1' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'invalid_email');
  check('不填地址返回 400 invalid_email');

  res = await call(env, '/api/auth/login', { method: 'POST', body: { email: 'chenzhou', password: 'member-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.email, 'chenzhou@example.com');
  check('普通账号也可用前缀登录');

  res = await call(env, '/api/me', { token: res.data.token });
  assert.equal(res.data.domain, 'example.com');
  assert.equal(res.data.mailbox, 'chenzhou');
  check('/api/me 返回 mailbox 前缀与 domain');

  const freeEnv = makeEnv({ MAIL_DOMAIN: 'example.com', MAIL_RETENTION: '' });
  await call(freeEnv, '/api/setup', { method: 'POST', body: { password: 'admin-password-1' } });
  res = await call(freeEnv, '/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'admin-password-1' } });
  res = await call(freeEnv, '/api/me', { token: res.data.token });
  assert.equal(res.data.mailRetention, 500);
  assert.equal(res.data.trashTtlDays, 30);
  check('默认全站保留 500 封、垃圾箱 30 天');

  const unlimitedEnv = makeEnv({ MAIL_DOMAIN: 'example.com', MAIL_RETENTION: '0' });
  await call(unlimitedEnv, '/api/setup', { method: 'POST', body: { password: 'admin-password-1' } });
  res = await call(unlimitedEnv, '/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'admin-password-1' } });
  res = await call(unlimitedEnv, '/api/me', { token: res.data.token });
  assert.equal(res.data.mailRetention, 0);
  check('MAIL_RETENTION=0 时关闭清理');
}

/* ---------------- 2. 域名未知：报错 + 从地址里学 ---------------- */

async function scenarioUnknown() {
  console.log('\n[2] 域名未知：先报可读错误，填了完整地址后自动学会');
  const env = makeEnv();

  let res = await call(env, '/api/setup');
  assert.equal(res.data.domain, '');
  assert.equal(res.data.defaultAdmin, '');
  check('workers.dev 访问域名不会被误判成收件域名');

  res = await call(env, '/api/setup', { method: 'POST', body: { password: 'admin-password-1' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'need_domain');
  assert.match(res.data.error.message, /MAIL_DOMAIN/);
  check('域名未知且不填地址时提示配置 MAIL_DOMAIN');

  res = await call(env, '/api/setup', { method: 'POST', body: { email: 'admin@acme.test', password: 'admin-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.email, 'admin@acme.test');
  check('填完整地址可正常初始化');

  res = await call(env, '/api/setup');
  assert.equal(res.data.domain, 'acme.test');
  assert.equal(res.data.defaultAdmin, 'admin@acme.test');
  check('初始化时填的域名被学下来，后续地址只需前缀');
}

/* ---------------- 3. 从收到的邮件里学域名 ---------------- */

async function scenarioLearnFromMail() {
  console.log('\n[3] 收到第一封邮件即学会收件域名');
  const env = makeEnv();

  await deliver(env, 'welcome@learned.test');
  const stored = env.DB.query("SELECT value FROM settings WHERE key = 'mail_domain'");
  assert.equal(stored[0]?.value, 'learned.test');
  check('收信后把域写进 settings.mail_domain');

  let res = await call(env, '/api/setup');
  assert.equal(res.data.domain, 'learned.test');
  assert.equal(res.data.defaultAdmin, 'admin@learned.test');
  check('GET /api/setup 立刻返回学到的域名');

  res = await call(env, '/api/setup', { method: 'POST', body: { password: 'admin-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.email, 'admin@learned.test');
  check('管理员默认注册为 admin@learned.test');

  res = await call(env, '/api/mails', { token: res.data.token });
  assert.equal(res.status, 200);
  check('初始化后可以正常读信');
}

/* ---------------- 4. 环境变量引导管理员 ---------------- */

async function scenarioBootstrapEnv() {
  console.log('\n[4] ADMIN_PASSWORD 引导管理员，默认 admin@<域名>');
  const env = makeEnv({ MAIL_DOMAIN: 'example.com', ADMIN_PASSWORD: 'bootstrap-password-1' });

  let res = await call(env, '/api/setup');
  assert.equal(res.data.needsSetup, false);
  assert.equal(res.data.userCount, 1);
  check('首个请求就自动建好管理员（ADMIN_EMAIL 未填）');

  res = await call(env, '/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'bootstrap-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.email, 'admin@example.com');
  check('自动建号的地址是 admin@example.com');

  const env2 = makeEnv({ MAIL_DOMAIN: 'example.com', ADMIN_PASSWORD: 'bootstrap-password-2', ADMIN_EMAIL: 'boss' });
  res = await call(env2, '/api/auth/login', { method: 'POST', body: { email: 'boss', password: 'bootstrap-password-2' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.user.email, 'boss@example.com');
  check('ADMIN_EMAIL 只填前缀时也能补全');

  const env3 = makeEnv({ ADMIN_PASSWORD: 'bootstrap-password-3' });
  res = await call(env3, '/api/setup');
  assert.equal(res.data.needsSetup, true);
  check('域名未知时不硬造管理员，留给网页向导');
}

/* ---------------- 5. 从访问域名推断 ---------------- */

async function scenarioFromHost() {
  console.log('\n[5] 自定义访问域名推断收件域名');
  const env = makeEnv();
  let res = await call(env, '/api/setup', { origin: 'https://mail.corp.test' });
  assert.equal(res.data.domain, 'corp.test');
  assert.equal(res.data.defaultAdmin, 'admin@corp.test');
  check('mail.corp.test 推断为 corp.test');

  const env2 = makeEnv();
  res = await call(env2, '/api/setup', { origin: 'https://corp.test' });
  assert.equal(res.data.domain, 'corp.test');
  check('裸域名 corp.test 直接采用');

  const env3 = makeEnv();
  res = await call(env3, '/api/setup', { origin: 'https://mail.example.workers.dev' });
  assert.equal(res.data.domain, '');
  check('*.workers.dev 不推断');
}

/* ---------------- 6. PBKDF2 轮数上限（Workers 硬限制） ---------------- */

async function makeHash(password, iterations, salt = 'legacysalt0123456789abcdef0123') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations },
    key,
    256,
  );
  const hex = [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${salt}$${hex}`;
}

async function scenarioIterations() {
  console.log('\n[6] PBKDF2 轮数不超过运行时上限（10 万）');
  const env = makeEnv({ MAIL_DOMAIN: 'example.com' });
  let res = await call(env, '/api/setup', { method: 'POST', body: { password: 'admin-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const stored = env.DB.query("SELECT password_hash FROM users WHERE email = 'admin@example.com'")[0].password_hash;
  assert.match(stored, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  check('新密码以 10 万轮 PBKDF2 写入（Workers 允许的上限）');

  const env2 = makeEnv({ MAIL_DOMAIN: 'example.com', PBKDF2_ITERATIONS: '120000' });
  res = await call(env2, '/api/setup', { method: 'POST', body: { password: 'admin-password-2' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const stored2 = env2.DB.query("SELECT password_hash FROM users WHERE email = 'admin@example.com'")[0].password_hash;
  assert.ok(stored2.startsWith('pbkdf2$100000$'), stored2);
  check('PBKDF2_ITERATIONS 配成 12 万时自动压到 10 万，避免 NotSupportedError');

  // 旧版本写入的 12 万轮哈希：运行时若支持则照常登录（向后兼容）
  const legacy = await makeHash('legacy-password-1', 120000);
  env2.DB.database.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(legacy, 'admin@example.com');
  res = await call(env2, '/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'legacy-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const adminToken = res.data.token;
  check('运行时可算 12 万轮时，旧哈希仍能登录');

  res = await call(env2, '/api/users', {
    method: 'POST',
    token: adminToken,
    body: { email: 'normal', password: 'member-password-1' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));

  // 模拟 Workers：轮数超过 10 万直接抛 NotSupportedError
  const original = crypto.subtle.deriveBits;
  crypto.subtle.deriveBits = function patched(algorithm, key, length) {
    if (algorithm && algorithm.iterations > 100000) {
      const error = new Error(
        `Pbkdf2 failed: iteration counts above 100000 are not supported (requested ${algorithm.iterations}).`,
      );
      error.name = 'NotSupportedError';
      return Promise.reject(error);
    }
    return original.call(this, algorithm, key, length);
  };
  try {
    env2.DB.database.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(legacy, 'admin@example.com');
    res = await call(env2, '/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'legacy-password-1' } });
    assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'password_reset_required');
    assert.match(res.data.error.message, /100000/);
    check('运行时不支持时返回 password_reset_required，而不是含糊的「密码不正确」');

    // 同样的限制下，用 10 万轮的新账号照常登录
    res = await call(env2, '/api/auth/login', { method: 'POST', body: { email: 'normal', password: 'member-password-1' } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    check('上限之下正常账号不受影响');
  } finally {
    crypto.subtle.deriveBits = original;
  }
}

/* ---------------- 运行 ---------------- */

async function main() {
  await scenarioConfigured();
  await scenarioUnknown();
  await scenarioLearnFromMail();
  await scenarioBootstrapEnv();
  await scenarioFromHost();
  await scenarioIterations();
  console.log(`\n域名识别检查通过：${passed} 项 ✅`);
}

main().catch((error) => {
  console.error('\n域名识别检查失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
