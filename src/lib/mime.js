/**
 * 极简 MIME 解析器：
 * - RFC 2047 编码字（=?utf-8?B?...?=）解码，含多段拼接
 * - multipart 递归拆分（alternative / mixed / related）
 * - base64 / quoted-printable 正文解码
 * - 附件仅记录元信息（名称、类型、大小），正文不入库
 */
import { previewOf, str } from './util.js';

const MAX_DEPTH = 6;

function splitHeaderBody(input) {
  const text = String(input || '');
  const crlf = text.indexOf('\r\n\r\n');
  if (crlf >= 0) return { headerText: text.slice(0, crlf), bodyText: text.slice(crlf + 4) };
  const lf = text.indexOf('\n\n');
  if (lf >= 0) return { headerText: text.slice(0, lf), bodyText: text.slice(lf + 2) };
  return { headerText: text, bodyText: '' };
}

function parseHeaders(block) {
  const headers = Object.create(null);
  const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
  let current = '';
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ' ' + line.trim();
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) continue;
    current = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[current] = headers[current] ? `${headers[current]}, ${value}` : value;
  }
  return headers;
}

function parseParams(value) {
  const params = Object.create(null);
  const pattern = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let match;
  while ((match = pattern.exec(String(value || ''))) !== null) {
    const key = match[1].toLowerCase();
    let raw = match[2].trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    params[key] = raw;
  }
  return params;
}

export function parseContentType(value) {
  const text = String(value || 'text/plain');
  const semi = text.indexOf(';');
  const type = (semi >= 0 ? text.slice(0, semi) : text).trim().toLowerCase() || 'text/plain';
  const params = semi >= 0 ? parseParams(text.slice(semi)) : Object.create(null);
  return { type, params };
}

function decodeBytes(bytes, charset) {
  const label = String(charset || 'utf-8')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
  const candidates = [label, 'utf-8', 'gb18030'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      // 不支持的 charset 标签，继续尝试下一个
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function base64ToBytes(text) {
  const cleaned = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeQuotedPrintable(text) {
  const source = String(text || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = source.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else {
        // 非 ASCII 字符（邮件头里可能出现）按 UTF-8 编码
        for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
      }
    }
  }
  return new Uint8Array(bytes);
}

function decodeTransfer(body, encoding, charset) {
  const mode = String(encoding || '7bit').trim().toLowerCase();
  if (mode === 'base64') return decodeBytes(base64ToBytes(body), charset);
  if (mode === 'quoted-printable') return decodeBytes(decodeQuotedPrintable(body), charset);
  return decodeBytes(new TextEncoder().encode(body), charset);
}

function decodeEncodedWord(word) {
  const match = String(word).match(/^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/);
  if (!match) return null;
  const charset = match[1].split('*')[0];
  const encoding = match[2].toUpperCase();
  const payload = match[3];
  if (encoding === 'B') {
    return decodeBytes(base64ToBytes(payload), charset);
  }
  return decodeBytes(decodeQuotedPrintable(payload.replace(/_/g, ' ')), charset);
}

/** 解码邮件头中的 RFC 2047 编码字。 */
export function decodeWords(value) {
  let text = str(value, 20000);
  if (!text.includes('=?')) return text;
  // 相邻编码字之间的空白应被忽略
  text = text.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1');
  return text.replace(/=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=/g, (word) => decodeEncodedWord(word) ?? word);
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const chunks = String(body).split(marker);
  const parts = [];
  for (let index = 1; index < chunks.length; index += 1) {
    let chunk = chunks[index];
    if (chunk.startsWith('--')) break; // 结束标记
    chunk = chunk.replace(/^\r?\n/, '');
    if (chunk.trim()) parts.push(chunk);
  }
  return parts;
}

function attachmentName(headers) {
  const disposition = parseParams(headers['content-disposition'] || '');
  const continuation = Object.keys(disposition).find((key) => key.startsWith('filename*'));
  if (continuation) {
    const raw = disposition[continuation];
    const match = raw.match(/^([\w-]+)'[^']*'(.+)$/);
    if (match) {
      try {
        return decodeURIComponent(match[2]);
      } catch {
        return match[2];
      }
    }
    return raw;
  }
  return disposition.filename || disposition.name || '';
}

function walkPart(partText, depth, state) {
  if (depth > MAX_DEPTH) return;
  const { headerText, bodyText } = splitHeaderBody(partText);
  const headers = parseHeaders(headerText);
  const { type, params } = parseContentType(headers['content-type']);
  const charset = params.charset || 'utf-8';
  const encoding = headers['content-transfer-encoding'] || '7bit';

  if (type.startsWith('multipart/') && params.boundary) {
    for (const child of splitMultipart(bodyText, params.boundary)) {
      walkPart(child, depth + 1, state);
    }
    return;
  }

  if (type === 'message/rfc822') {
    walkPart(bodyText, depth + 1, state);
    return;
  }

  const disposition = String(headers['content-disposition'] || '').toLowerCase();
  const isAttachment = disposition.startsWith('attachment') || Boolean(params.name);

  if (!isAttachment && type === 'text/html') {
    if (!state.html) state.html = decodeTransfer(bodyText, encoding, charset);
    return;
  }
  if (!isAttachment && type === 'text/plain') {
    if (!state.text) state.text = decodeTransfer(bodyText, encoding, charset);
    return;
  }

  const filename = attachmentName(headers) || params.name || '';
  if (filename) {
    state.attachments.push({
      filename: str(filename, 200),
      type: type || 'application/octet-stream',
      size: bodyText.length,
    });
  }
}

const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/**
 * 判断一段正文是不是 HTML。
 * 有些发信方只发 HTML（甚至不带 Content-Type，按 RFC 会退回 text/plain），
 * 旧版本还会把整篇 HTML 当纯文本存下来 —— 都靠这个函数兜住，避免显示成一堆源码。
 */
export function looksLikeHtml(value) {
  const source = str(value, 400000);
  const head = source.trimStart().slice(0, 200).toLowerCase();
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]|^<body[\s>]/.test(head)) return true;
  if (/<\/html>|<\/body>/i.test(source)) return true;
  const opens = (source.match(/<(table|tr|td|div|p|span|a|img|br|h[1-6])\b[^>]*>/gi) || []).length;
  const closes = (source.match(/<\/(table|tr|td|div|p|span|a|h[1-6])>/gi) || []).length;
  return opens >= 8 && closes >= 3;
}

export function htmlToText(html) {
  return str(html, 400000)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z#0-9]+);/g, (full, name) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      if (key.startsWith('#x')) {
        const code = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      if (key.startsWith('#')) {
        const code = Number.parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : full;
      }
      return full;
    })
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析原始邮件。
 * @returns {{subject: string, from: string, text: string, html: string, attachments: Array, preview: string}}
 */
export function parseMail(raw) {
  const source = String(raw || '');
  const { headerText } = splitHeaderBody(source);
  const headers = parseHeaders(headerText);
  const state = { text: '', html: '', attachments: [] };
  walkPart(source, 0, state);

  const subject = decodeWords(headers.subject || '').replace(/\s+/g, ' ').trim() || '(无主题)';
  const from = decodeWords(headers.from || '').trim();
  const text = state.text.replace(/\r\n/g, '\n').trim();
  const html = state.html.trim();
  const previewSource = text || htmlToText(html);

  return {
    subject: str(subject, 500),
    from,
    messageId: str(headers['message-id'], 400).trim(),
    text,
    html,
    attachments: state.attachments,
    preview: previewOf(previewSource, 180),
    size: source.length,
  };
}
