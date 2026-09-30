import { Env } from './index';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function error(code: string, status = 400) {
  return json({ error: code }, status);
}

const OTP_TTL_MS = 15 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function requestAuthCode(request: Request, env: Env): Promise<Response> {
  const input = await request.json().catch(() => null) as { email?: unknown } | null;
  const normalizedEmail = normalizeEmail(input?.email);
  if (!normalizedEmail) return error('invalid_email');

  const from = env.EMAIL_FROM;
  if (!env.EMAIL || !from) return error('email_unavailable', 503);

  const now = Date.now();
  const previous = await env.DB.prepare('SELECT requested_at FROM auth_otps WHERE email = ?')
    .bind(normalizedEmail).first<{ requested_at: number }>();
  if (previous && now - previous.requested_at < OTP_COOLDOWN_MS) return error('code_recently_requested', 429);

  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  const code = (100000 + random % 900000).toString();
  const expiresAt = now + OTP_TTL_MS;

  await env.DB.prepare(
    'INSERT INTO auth_otps (email, code, expires_at, requested_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, requested_at = excluded.requested_at, attempts = 0'
  ).bind(normalizedEmail, code, expiresAt, now).run();

  try {
    await env.EMAIL.send({
      from,
      to: normalizedEmail,
      subject: 'Your Bleachers sign-in code',
      text: `Your Bleachers sign-in code is ${code}. It expires in 15 minutes.`,
    });
  } catch (cause) {
    await env.DB.prepare('DELETE FROM auth_otps WHERE email = ? AND code = ?')
      .bind(normalizedEmail, code).run();
    console.error('Failed to send sign-in code', cause);
    return error('email_unavailable', 503);
  }

  return json({ success: true, message: 'Code sent to your email.' });
}

export async function verifyAuthCode(request: Request, env: Env): Promise<Response> {
  const input = await request.json().catch(() => null) as { email?: unknown; code?: unknown } | null;
  const code = input?.code;
  const normalizedEmail = normalizeEmail(input?.email);
  if (!normalizedEmail || typeof code !== 'string' || !/^\d{6}$/.test(code)) return error('invalid_request');

  const otpRecord = await env.DB.prepare('SELECT code, expires_at, attempts FROM auth_otps WHERE email = ?')
    .bind(normalizedEmail).first<{ code: string; expires_at: number; attempts: number }>();
  if (!otpRecord) return error('invalid_code');
  if (Date.now() > otpRecord.expires_at) {
    await env.DB.prepare('DELETE FROM auth_otps WHERE email = ?').bind(normalizedEmail).run();
    return error('expired_code');
  }
  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) return error('too_many_attempts', 429);
  if (otpRecord.code !== code) {
    await env.DB.prepare('UPDATE auth_otps SET attempts = attempts + 1 WHERE email = ?').bind(normalizedEmail).run();
    return error('invalid_code');
  }

  const consumed = await env.DB.prepare('DELETE FROM auth_otps WHERE email = ? AND code = ?')
    .bind(normalizedEmail, code).run();
  if (consumed.meta.changes !== 1) return error('invalid_code');

  let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normalizedEmail).first<{ id: string }>();
  if (!user) {
    const userId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(userId, normalizedEmail, new Date().toISOString()).run();
    user = { id: userId };
  }

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.DB.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, user.id, expiresAt).run();

  const res = json({ success: true, token });
  res.headers.set('Set-Cookie', `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`);
  return res;
}

export async function getMe(request: Request, env: Env): Promise<Response> {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  const user = await env.DB.prepare('SELECT id, email, name, avatar_url, created_at FROM users WHERE id = ?').bind(userId).first();
  if (!user) return error('not_found', 404);
  return json(user);
}

export async function authMiddleware(request: Request, env: Env): Promise<string | null> {
  let token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/session=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token) return null;
  const session = await env.DB.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?').bind(token).first<{ user_id: string; expires_at: number }>();
  if (!session || Date.now() > session.expires_at) return null;
  return session.user_id;
}

export async function mergeAuth(request: Request, env: Env): Promise<Response> {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  const { viewerSessionId } = await request.json().catch(() => ({})) as { viewerSessionId?: string };
  if (!viewerSessionId) return error('missing_session');
  
  await env.DB.prepare('UPDATE moment_saves SET user_id = ? WHERE viewer_session_id = ? AND user_id IS NULL').bind(userId, viewerSessionId).run();
  
  return json({ success: true });
}
