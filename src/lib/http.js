/**
 * HTTP 层：统一的响应格式、错误处理、鉴权辅助。
 */
import { clientIp, str } from './util.js';
import { authenticateApiKey, API_KEY_PREFIX } from './apikeys.js';
import { authenticate } from './auth.js';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin',
};

export function securityHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

export function json(data, init = {}) {
  const headers = securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(init.headers || {}),
  });
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function ok(data = {}) {
  return json({ ok: true, ...data });
}

export function fail(status, code, message, extra) {
  return json({ ok: false, error: { code, message } }, { status, ...(extra ? { extra } : {}) });
}

export async function readJson(request, { limit = 256 * 1024 } = {}) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length && length > limit) {
    throw new HttpError(413, 'payload_too_large', '请求内容过大');
  }
  const text = await request.text();
  if (!text) return {};
  if (text.length > limit) throw new HttpError(413, 'payload_too_large', '请求内容过大');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_json', '请求格式错误');
  }
}

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const alt = request.headers.get('x-auth-token');
  return alt ? alt.trim() : '';
}

export async function requireUser(request, env) {
  // 1) HTTP 接口密钥：X-API-Key，或直接放在 Authorization: Bearer cm_xxx
  const headerKey = (request.headers.get('x-api-key') || '').trim();
  const token = bearerToken(request);
  const apiKey = headerKey || (token.startsWith(API_KEY_PREFIX) ? token : '');
  if (apiKey) {
    const session = await authenticateApiKey(env, apiKey);
    if (!session) throw new HttpError(401, 'invalid_api_key', 'API 密钥无效或已撤销');
    return { ...session, via: 'api_key' };
  }

  // 2) 网页登录会话
  if (!token) throw new HttpError(401, 'unauthorized', '请先登录');
  const session = await authenticate(env, token);
  if (!session) throw new HttpError(401, 'session_expired', '登录状态已失效，请重新登录');
  return { ...session, via: 'session' };
}

export async function requireAdmin(request, env) {
  const session = await requireUser(request, env);
  if (session.user.role !== 'admin') throw new HttpError(403, 'forbidden', '需要管理员权限');
  return session;
}

export function methodNotAllowed(allow) {
  return json(
    { ok: false, error: { code: 'method_not_allowed', message: '不支持的请求方法' } },
    { status: 405, headers: { allow } },
  );
}
