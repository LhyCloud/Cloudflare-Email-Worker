/**
 * 收信入口：Email Routing → Worker。
 * 收件地址匹配到用户邮箱则归入该用户；匹配不到的无主邮件一律归到管理员，
 * 保证任何一封信都不会落在没人可见的「黑洞」里。
 */
import { dbFirst, dbRun, ensureSchema, firstAdminUser, orphanFallbackUser } from './lib/db.js';
import { domainOf, rememberDomain } from './lib/domain.js';
import { looksLikeHtml, parseMail } from './lib/mime.js';
import { normalizeEmail, nowIso, splitAddress, str, trimToBytes } from './lib/util.js';
import { trimStore } from './api/mails.js';

const MAX_STORED_BODY = 900 * 1024;

function bareAddress(value) {
  const text = str(value, 400).trim().replace(/^<|>$/g, '');
  const angle = text.match(/<([^<>]+)>/);
  return normalizeEmail(angle ? angle[1] : text);
}

async function matchRecipient(env, address) {
  if (!address) return null;
  const direct = await dbFirst(env, 'SELECT id, email FROM users WHERE lower(email) = ?', address);
  if (direct) return direct;
  // 域名换了但本地部分相同的场景
  const local = address.split('@')[0];
  if (!local) return null;
  return dbFirst(env, "SELECT id, email FROM users WHERE lower(substr(email, 1, instr(email, '@') - 1)) = ? LIMIT 1", local);
}

export async function handleIncomingEmail(message, env, ctx) {
  await ensureSchema(env);

  const recipient = bareAddress(message.to || message.headers.get('to') || '');
  const raw = await new Response(message.raw).text();
  const parsed = parseMail(raw);

  const headerFrom = splitAddress(parsed.from || message.headers.get('from') || '');
  const sender = headerFrom.address || bareAddress(message.from);
  const senderName = str(headerFrom.name, 120);
  const realSender = bareAddress(message.from) || sender;
  // Message-ID 优先取平台给的 header，缺失时退回原始邮件头（用于去重）
  const messageId = str(message.headers.get('message-id') || parsed.messageId, 400).trim() || null;

  const user = await matchRecipient(env, recipient);
  // 无主邮件（收件地址没有对应账号）全部归到管理员，宁可多收也不丢信；
  // 连管理员都还没有（初始化没走完）时退回最早的可用账号，最后才允许留空。
  const owner = user || (await firstAdminUser(env)) || (await orphanFallbackUser(env));
  if (owner && !user) {
    console.log(`[orphan] ${recipient || '(未知收件人)'} 没有对应账号，已归到 ${owner.email}`);
  }
  // 第一封邮件就能把收件域名学下来，之后所有地址输入框都只需要填前缀
  if (recipient) await rememberDomain(env, domainOf(recipient));
  const html = parsed.html ? trimToBytes(parsed.html, MAX_STORED_BODY) : '';
  const text = parsed.text ? trimToBytes(parsed.text, MAX_STORED_BODY) : '';
  // 只发 HTML 的邮件（有些发信方连 Content-Type 都不写）也要按 HTML 存
  const bodyType = html || looksLikeHtml(text) ? 'html' : 'text';
  const body = html || text || '(无内容)';

  try {
    if (messageId) {
      const existing = await dbFirst(env, 'SELECT id FROM emails WHERE message_id = ?', messageId);
      if (existing) return;
    }

    await dbRun(
      env,
      `INSERT OR IGNORE INTO emails
         (message_id, user_id, sender, sender_name, real_sender, receiver, subject, body, body_type, preview, attachments, is_read, is_starred, received_at, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      messageId,
      owner ? Number(owner.id) : null,
      sender,
      senderName,
      realSender,
      recipient,
      parsed.subject,
      body,
      bodyType,
      parsed.preview,
      JSON.stringify(parsed.attachments || []),
      nowIso(),
      parsed.size,
    );

    await trimStore(env);
  } catch (error) {
    console.error('inbound email failed', error);
    // 抛出让 Cloudflare 稍后重试，避免静默丢信
    throw error;
  }
}
