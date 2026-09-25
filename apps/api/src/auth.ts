import { Env } from './index';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function error(code: string, status = 400) {
  return json({ error: code }, status);
}

import { EmailMessage } from 'cloudflare:email';

export async function requestAuthCode(request: Request, env: Env): Promise<Response> {
  const { email } = await request.json().catch(() => ({})) as { email?: string };
  if (!email || !email.includes('@')) return error('invalid_email');

  const normalizedEmail = email.toLowerCase().trim();
  const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

  await env.DB.prepare(
    'INSERT INTO auth_otps (email, code, expires_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at'
  ).bind(normalizedEmail, code, expiresAt).run();

  if (env.EMAIL) {
    try {
      const msg = new EmailMessage(
        'no-reply@bleachers.com',
        normalizedEmail,
        `Your login code is: ${code}`
      );
      await env.EMAIL.send(msg);
    } catch (e) {
      console.error('Failed to send email', e);
    }
  }

  return json({ success: true, message: 'Code sent to your email.' });
}

export async function verifyAuthCode(request: Request, env: Env): Promise<Response> {
  const { email, code } = await request.json().catch(() => ({})) as { email?: string, code?: string };
  if (!email || !code) return error('invalid_request');
  const normalizedEmail = email.toLowerCase().trim();

  const otpRecord = await env.DB.prepare('SELECT code, expires_at FROM auth_otps WHERE email = ?').bind(normalizedEmail).first<{ code: string; expires_at: number }>();
  if (!otpRecord) return error('invalid_code');
  if (Date.now() > otpRecord.expires_at) return error('expired_code');
  if (otpRecord.code !== code) return error('invalid_code');

  await env.DB.prepare('DELETE FROM auth_otps WHERE email = ?').bind(normalizedEmail).run();

  let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normalizedEmail).first<{ id: string }>();
  if (!user) {
    const userId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(userId, normalizedEmail, new Date().toISOString()).run();
    user = { id: userId };
  }

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  await env.DB.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, user.id, expiresAt).run();

  const res = json({ success: true });
  res.headers.set('Set-Cookie', `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`);
  return res;
}

export async function getMe(request: Request, env: Env): Promise<Response> {
  const userId = request.headers.get('x-user-id');
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
