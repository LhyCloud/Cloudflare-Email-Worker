/**
 * 邮箱域名的自动识别。
 *
 * 为什么需要它：Worker 部署完只知道「请求从哪来」，并不知道自己绑定的收发域名。
 * 因此按以下顺序推断，越靠前越可信：
 *   1. 环境变量 MAIL_DOMAIN —— 显式配置，永远优先；
 *   2. 数据库里 settings.mail_domain —— 从第一封收到的邮件（或首次初始化）里学到，之后一直复用；
 *   3. 访问域名 —— 例如 mail.example.com / email.example.com 去掉前缀；*.workers.dev 不推断。
 *
 * 拿到域名之后，界面里所有「邮箱地址」输入框都只需要填前缀（admin、chenzhou…），
 * 域名自动补齐；初始化向导的管理员默认就是 admin@<域名>。
 */
import { dbFirst, dbRun } from './db.js';
import { HttpError } from './http.js';
import { normalizeEmail, nowIso, str } from './util.js';

const SETTING_KEY = 'mail_domain';
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SUBDOMAIN_PREFIXES = ['mail', 'email', 'smtp', 'inbox', 'mx'];

/** 规范化域名：去空白、去前导 @、小写、校验形状；不合法返回 ''。 */
export function normalizeDomain(value) {
  const text = str(value, 200)
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[.\s]+$/, '');
  if (!text || text.length > 190) return '';
  return DOMAIN.test(text) ? text : '';
}

/** 取出地址里的域名部分。 */
export function domainOf(address) {
  const email = normalizeEmail(address);
  const at = email.lastIndexOf('@');
  return at > 0 ? normalizeDomain(email.slice(at + 1)) : '';
}

/** 取出地址里的本地部分（不带 @）。 */
export function localPartOf(address) {
  const email = normalizeEmail(address);
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * 从访问域名猜测收件域名：
 *   mail.example.com → example.com；example.com → example.com；xxx.workers.dev → ''（不猜）。
 */
export function domainFromHost(host) {
  const text = str(host, 200).trim().toLowerCase().split(':')[0];
  if (!text || !DOMAIN.test(text)) return '';
  if (text.endsWith('.workers.dev') || text.endsWith('.pages.dev')) return '';
  const labels = text.split('.');
  if (labels.length >= 3 && SUBDOMAIN_PREFIXES.includes(labels[0])) {
    return normalizeDomain(labels.slice(1).join('.'));
  }
  return labels.length === 2 ? text : '';
}

/** 读库里学到的域名。 */
export async function storedDomain(env) {
  const row = await dbFirst(env, 'SELECT value FROM settings WHERE key = ?', SETTING_KEY);
  return normalizeDomain(row?.value);
}

/** 学到一个域名（先到先得，已存在则不覆盖）。 */
export async function rememberDomain(env, value) {
  const domain = normalizeDomain(value);
  if (!domain) return '';
  const current = await storedDomain(env);
  if (current) return current;
  await dbRun(
    env,
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    SETTING_KEY,
    domain,
    nowIso(),
  );
  return domain;
}

/** 当前请求的访问域名：优先 Host 头，本地/测试环境回退到 URL。 */
function requestHost(request) {
  const header = request?.headers?.get?.('host');
  if (header) return header;
  try {
    return new URL(String(request?.url || '')).hostname;
  } catch {
    return '';
  }
}

/** 综合三个来源得出当前收件域名；拿不到返回 ''。 */
export async function resolveDomain(env, request) {
  const configured = normalizeDomain(env?.MAIL_DOMAIN);
  if (configured) return configured;
  const learned = await storedDomain(env);
  if (learned) return learned;
  return domainFromHost(requestHost(request));
}

/** 域名是从哪来的，用于界面提示。 */
export async function domainSource(env) {
  if (normalizeDomain(env?.MAIL_DOMAIN)) return 'env';
  if (await storedDomain(env)) return 'mail';
  return 'unknown';
}

/**
 * 把「只填前缀」的输入补全成完整地址。
 * 返回 { email, domain, local }：域名未知且输入里也没有 @ 时，email 是半成品，由调用方决定怎么报错。
 */
export async function expandAddress(env, raw, { request, local = '' } = {}) {
  const input = normalizeEmail(raw);
  if (input.includes('@')) {
    return { email: input, domain: domainOf(input), local: localPartOf(input) };
  }
  const domain = await resolveDomain(env, request);
  const prefix = (input || normalizeEmail(local)).trim();
  if (!prefix) return { email: '', domain, local: '' };
  return { email: domain ? `${prefix}@${domain}` : prefix, domain, local: prefix };
}

/** 同 expandAddress，但失败直接抛 400，消息按「域名能不能自动识别」分开提示。 */
export async function requireAddress(env, raw, { request, local = '', field = '邮箱地址' } = {}) {
  const expanded = await expandAddress(env, raw, { request, local });
  if (!expanded.email) throw new HttpError(400, 'invalid_email', `请填写${field}`);
  if (!expanded.email.includes('@')) {
    throw new HttpError(
      400,
      'need_domain',
      '暂时无法自动识别收件域名：请填写完整邮箱地址，或在 wrangler.toml 里设置 MAIL_DOMAIN',
    );
  }
  if (!LOCAL_PART.test(expanded.local) || expanded.local.length > 64 || !expanded.domain) {
    throw new HttpError(400, 'invalid_email', `${field}格式不正确`);
  }
  return expanded;
}

/** 默认管理员地址：admin@<域名>。 */
export async function defaultAdminAddress(env, request) {
  const domain = await resolveDomain(env, request);
  return domain ? `admin@${domain}` : '';
}
