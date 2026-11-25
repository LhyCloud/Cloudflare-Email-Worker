/**
 * 启动自检：建表 + 可选的引导管理员。
 * 每个 isolate 只执行一次，失败会重置以便下一次请求重试。
 */
import { PBKDF2_MAX_ITERATIONS, hashPassword, passwordIterations } from './lib/auth.js';
import { adoptAllOrphanMail, countUsers, dbAll, dbFirst, dbRun, ensureSchema, firstAdminUser } from './lib/db.js';
import { normalizeDomain, rememberDomain, resolveDomain } from './lib/domain.js';
import { isValidEmail, normalizeEmail, nowIso, str } from './lib/util.js';

/** 按 D1 绑定缓存；同一 isolate 内每个库只跑一次自检。 */
const readyPromises = new WeakMap();

export function ensureReady(env) {
  const key = env?.DB;
  if (!key) return ensureSchema(env);
  let promise = readyPromises.get(key);
  if (!promise) {
    promise = (async () => {
      await ensureSchema(env);
      await bootstrapAdmin(env);
      await recoverAdminPasswords(env);
      await adoptOrphansToAdmin(env);
    })().catch((error) => {
      readyPromises.delete(key);
      throw error;
    });
    readyPromises.set(key, promise);
  }
  return promise;
}

/**
 * 旧版本用 12 万轮 PBKDF2 写哈希，而 Workers 运行时的上限是 10 万轮，这类密码无法校验。
 * 只要还配置着 ADMIN_PASSWORD，就顺手把这类管理员账号救回来，避免把自己锁在门外。
 */
async function recoverAdminPasswords(env) {
  const password = str(env?.ADMIN_PASSWORD, 200);
  if (!password || password.length < 8) return;
  let rows = [];
  try {
    rows = await dbAll(env, "SELECT id, email, password_hash FROM users WHERE role = 'admin'");
  } catch {
    return;
  }
  const broken = rows.filter((row) => passwordIterations(row.password_hash) > PBKDF2_MAX_ITERATIONS);
  if (!broken.length) return;
  const hash = await hashPassword(password, env);
  for (const row of broken) {
    await dbRun(env, 'UPDATE users SET password_hash = ? WHERE id = ?', hash, row.id);
    await dbRun(env, 'DELETE FROM sessions WHERE user_id = ?', row.id);
    console.log(`管理员 ${row.email} 的密码哈希绕过了运行时上限，已按 ADMIN_PASSWORD 重置`);
  }
}

/**
 * 启动时把历史遗留的无主邮件（user_id 为空）统归到管理员，
 * 兼容旧库升级、以及「先收到信、后建账号」的时序。
 */
async function adoptOrphansToAdmin(env) {
  try {
    const admin = await firstAdminUser(env);
    if (!admin) return;
    const moved = await adoptAllOrphanMail(env, Number(admin.id));
    if (moved) console.log(`已把 ${moved} 封无主邮件归到管理员 ${admin.email}`);
  } catch {
    // 归属失败不影响服务启动
  }
}

/**
 * ADMIN_PASSWORD 是必填项，ADMIN_EMAIL 可以只填前缀。
 * 一个都不填时默认 admin@<域名>，域名能自动识别就自动建号，识别不到就留给网页初始化向导。
 */
async function bootstrapAdmin(env) {
  const password = str(env?.ADMIN_PASSWORD, 200);
  if (!password) return;
  if (password.length < 8) {
    console.warn('ADMIN_PASSWORD 少于 8 位，已跳过自动创建管理员');
    return;
  }

  const raw = normalizeEmail(env?.ADMIN_EMAIL);
  const domain = await resolveDomain(env);
  const prefix = raw.includes('@') ? '' : raw || 'admin';
  const email = raw.includes('@') ? raw : prefix && domain ? `${prefix}@${domain}` : '';

  if (!email) {
    console.warn('已设置 ADMIN_PASSWORD，但无法确定收件域名（MAIL_DOMAIN 未配置且尚无历史邮件），已跳过自动建号');
    return;
  }
  if (!isValidEmail(email)) {
    console.warn(`ADMIN_EMAIL（${email}）格式不正确，已跳过自动创建管理员`);
    return;
  }
  if ((await countUsers(env)) > 0) return;

  const exists = await dbFirst(env, 'SELECT id FROM users WHERE email = ?', email);
  if (exists) return;

  await dbRun(
    env,
    'INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    email,
    '管理员',
    await hashPassword(password, env),
    'admin',
    'active',
    nowIso(),
  );
  await rememberDomain(env, normalizeDomain(email.slice(email.lastIndexOf('@') + 1)));
  console.log(`已根据环境变量创建管理员 ${email}`);
}
