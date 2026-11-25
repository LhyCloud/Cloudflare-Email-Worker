/**
 * Cloud Mail —— Cloudflare Worker 入口。
 *
 * fetch: 提供静态界面与 JSON API（自动建表、多用户）
 * email: 接收 Email Routing 投递的邮件
 */
import {
  handleChangePassword,
  handleLogin,
  handleLogout,
  handleMe,
  handleSetup,
  handleSetupStatus,
  handleUpdateProfile,
} from './api/auth.js';
import {
  handleEmptyTrash,
  handleMailDelete,
  handleMailGet,
  handleMailList,
  handleMailPatch,
  handleSend,
  handleSentDelete,
  handleSentGet,
} from './api/mails.js';
import {
  handleAdoptOrphans,
  handleAdminOverview,
  handleDiagnostics,
  handleUserCreate,
  handleUserDelete,
  handleUserList,
  handleUserResetPassword,
  handleUserUpdate,
} from './api/users.js';
import { handleKeyCreate, handleKeyList, handleKeyRevoke } from './api/keys.js';
import { ensureReady } from './bootstrap.js';
import { handleIncomingEmail } from './email.js';
import { HttpError, fail, json, ok, securityHeaders } from './lib/http.js';
import { str } from './lib/util.js';

/** 构建时由 scripts/build.mjs 替换为内联的界面 HTML。 */
const APP_HTML = /*__APP_HTML__*/ '';

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https: http:",
  "style-src 'self' 'unsafe-inline' https: http:",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data: https: http:",
  "frame-src 'self' data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function htmlResponse(html) {
  return new Response(html, {
    headers: securityHeaders({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
    }),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz') {
        return json({ ok: true, service: 'cloud-mail', ts: Date.now() });
      }
      if (url.pathname.startsWith('/api/')) {
        await ensureReady(env);
        return await routeApi(request, env, url);
      }
      if (url.pathname === '/favicon.ico') {
        return new Response(null, { status: 204, headers: securityHeaders() });
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return htmlResponse(request.method === 'HEAD' ? '' : APP_HTML);
      }
      return new Response('Method Not Allowed', { status: 405 });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.status, error.code, error.message);
      }
      const name = String(error?.name || '');
      const message = String(error?.message || '');
      console.error('unhandled error', name, message, error);
      // 运行时的加密能力限制（例如 PBKDF2 轮数超限）给出可操作的提示，而不是笼统的 500
      if (name === 'NotSupportedError' || /not supported/i.test(message)) {
        return fail(500, 'runtime_unsupported', `当前运行时限制：${message || name}。请检查 PBKDF2_ITERATIONS 等参数。`);
      }
      return fail(500, 'internal_error', '服务器开小差了，请稍后重试');
    }
  },

  async email(message, env, ctx) {
    await handleIncomingEmail(message, env, ctx);
  },
};

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ---- 公共接口 ----
  if (path === '/api/setup') {
    if (method === 'GET') return handleSetupStatus(env, request);
    if (method === 'POST') return handleSetup(request, env);
  }
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);

  // ---- 当前用户 ----
  if (path === '/api/me') {
    if (method === 'GET') return handleMe(request, env);
    if (method === 'PATCH') return handleUpdateProfile(request, env);
  }
  if (path === '/api/me/password' && method === 'POST') return handleChangePassword(request, env);

  // ---- API 密钥 ----
  if (path === '/api/keys') {
    if (method === 'GET') return handleKeyList(request, env);
    if (method === 'POST') return handleKeyCreate(request, env);
  }
  const keyRevokeMatch = path.match(/^\/api\/keys\/(\d+)\/revoke$/);
  if (keyRevokeMatch && method === 'POST') return handleKeyRevoke(request, env, Number(keyRevokeMatch[1]));
  const keyMatch = path.match(/^\/api\/keys\/(\d+)$/);
  if (keyMatch && method === 'DELETE') return handleKeyRevoke(request, env, Number(keyMatch[1]));

  // ---- 邮件 ----
  if (path === '/api/mails' && method === 'GET') return handleMailList(request, env);
  if (path === '/api/mails/send' && method === 'POST') return handleSend(request, env);
  if (path === '/api/mails/trash/empty' && method === 'POST') return handleEmptyTrash(request, env);

  const mailMatch = path.match(/^\/api\/mails\/(\d+)$/);
  if (mailMatch) {
    const id = Number(mailMatch[1]);
    if (method === 'GET') return handleMailGet(request, env, id);
    if (method === 'PATCH') return handleMailPatch(request, env, id);
    if (method === 'DELETE') return handleMailDelete(request, env, id);
  }

  const sentMatch = path.match(/^\/api\/sent\/(\d+)$/);
  if (sentMatch && method === 'GET') return handleSentGet(request, env, Number(sentMatch[1]));
  if (sentMatch && method === 'DELETE') return handleSentDelete(request, env, Number(sentMatch[1]));

  // ---- 管理员 ----
  if (path === '/api/users') {
    if (method === 'GET') return handleUserList(request, env);
    if (method === 'POST') return handleUserCreate(request, env);
  }
  const userMatch = path.match(/^\/api\/users\/(\d+)$/);
  if (userMatch) {
    const id = Number(userMatch[1]);
    if (method === 'PATCH') return handleUserUpdate(request, env, id);
    if (method === 'DELETE') return handleUserDelete(request, env, id);
  }
  const userPasswordMatch = path.match(/^\/api\/users\/(\d+)\/password$/);
  if (userPasswordMatch && method === 'POST') return handleUserResetPassword(request, env, Number(userPasswordMatch[1]));

  if (path === '/api/admin/overview' && method === 'GET') return handleAdminOverview(request, env);
  if (path === '/api/diagnostics' && method === 'GET') return handleDiagnostics(request, env);
  if (path === '/api/diagnostics/adopt' && method === 'POST') return handleAdoptOrphans(request, env);

  return json(
    { ok: false, error: { code: 'not_found', message: `接口不存在：${str(path, 80)}` } },
    { status: 404 },
  );
}
