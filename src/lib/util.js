/**
 * 通用工具函数：不依赖 Cloudflare 专有 API，可在 Node 中直接测试。
 */

export function nowIso() {
  return new Date().toISOString();
}

/** 安全转字符串并截断长度（按字符计）。 */
export function str(value, max = 0) {
  if (value === null || value === undefined) return '';
  let out = typeof value === 'string' ? value : String(value);
  if (max > 0 && out.length > max) out = out.slice(0, max);
  return out;
}

/** 按 UTF-8 字节数截断，避免超过 D1 单行 1MB 限制。 */
export function trimToBytes(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const cut = bytes.slice(0, Math.max(0, maxBytes));
  return new TextDecoder('utf-8', { fatal: false }).decode(cut) + '\n\n…（内容过长已截断）';
}

export function normalizeEmail(value) {
  return str(value, 254).trim().toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]{2,}$/.test(String(value || ''));
}

export function localPart(email) {
  const text = String(email || '');
  const at = text.indexOf('@');
  return at > 0 ? text.slice(0, at) : text;
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return str(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export function bytesToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}

export function randomHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** 常量时间字符串比较，用于校验密码哈希与 token。 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 从 "Name <a@b.com>" 中拆出显示名与地址。 */
export function splitAddress(value) {
  const raw = str(value, 500).trim();
  const match = raw.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (match) {
    return { name: cleanDisplayName(match[1]), address: cleanDisplayName(match[2]).toLowerCase() };
  }
  return { name: '', address: cleanDisplayName(raw).toLowerCase() };
}

/**
 * 显示名清洗：去掉包裹用的引号（含全角）、反转义 \" 这类写法。
 * 必须先去空白再剥引号 —— `"星夜_Lhy" <a@b.com>` 里 .*? 会把空格一起吞进来，
 * 先剥引号就会漏掉结尾那个，界面上就出现「星夜_Lhy"」这种残引号。
 */
export function cleanDisplayName(value) {
  let out = str(value, 500).replace(/\\(["'\\])/g, '$1').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export function initialsOf(name, email) {
  const source = str(name).trim() || localPart(email) || '?';
  const cleaned = source.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) return '?';
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return Array.from(cleaned).slice(0, 2).join('').toUpperCase();
}

/** 列表预览：压缩空白、去掉过长的引用链。 */
export function previewOf(text, max = 150) {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

export function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function clientIp(request) {
  const raw = str(request?.headers?.get('cf-connecting-ip') || request?.headers?.get('x-forwarded-for') || 'local', 64);
  return raw.split(',')[0].trim() || 'local';
}

export function dayString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
