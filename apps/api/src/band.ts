import { Env } from './index';
import { authMiddleware } from './auth';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function error(code: string, status = 400) {
  return json({ error: code }, status);
}

// Ensure the Env type has BAND_CLIENT_ID and BAND_CLIENT_SECRET
export async function bandAuthRoute(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);

  // GET /v1/auth/band
  if (request.method === 'GET' && pathname === '/v1/auth/band') {
    const userId = await authMiddleware(request, env);
    if (!userId) return error('unauthorized', 401);

    const redirectUri = `${url.origin}/v1/auth/band/callback`;
    const clientId = env.BAND_CLIENT_ID || 'dummy_client_id'; // Needs to be configured in Cloudflare

    // BAND OAuth authorization URL
    const authorizeUrl = new URL('https://auth.band.us/oauth2/authorize');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    // Passing the userId in the state parameter to correlate the callback
    authorizeUrl.searchParams.set('state', userId);

    return Response.redirect(authorizeUrl.toString(), 302);
  }

  // GET /v1/auth/band/callback
  if (request.method === 'GET' && pathname === '/v1/auth/band/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state'); // Should be userId

    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 });
    }

    const userId = state;

    const clientId = env.BAND_CLIENT_ID || 'dummy_client_id';
    const clientSecret = env.BAND_CLIENT_SECRET || 'dummy_secret';
    // Generate base64 Authorization header
    const basicAuth = btoa(`${clientId}:${clientSecret}`);

    // Exchange code for token
    const tokenRes = await fetch('https://auth.band.us/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
      }).toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('BAND token error:', errText);
      return new Response('Failed to obtain BAND access token', { status: 400 });
    }

    const tokenData = await tokenRes.json() as any;
    const accessToken = tokenData.access_token;
    
    // Now fetch BAND profile to get external_account_id
    const profileRes = await fetch('https://openapi.band.us/v2/profile', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!profileRes.ok) {
      return new Response('Failed to fetch BAND profile', { status: 400 });
    }

    const profileData = await profileRes.json() as any;
    const bandUserKey = profileData.result_data?.user_key;

    // Store in user_integrations table
    const integrationId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO user_integrations (id, user_id, provider, external_account_id, access_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        access_token = excluded.access_token,
        external_account_id = excluded.external_account_id,
        updated_at = excluded.updated_at
    `).bind(
      integrationId,
      userId,
      'band',
      bandUserKey || null,
      accessToken,
      now,
      now
    ).run();

    // Redirect the user back to the frontend app, probably /teams or /integrations
    // We assume the frontend lives at a specific known URL or we just redirect back to the origin
    // For now, redirect to the viewer's root or a settings page
    // Using a relative redirect or environment-based frontend URL
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:5173';
    return Response.redirect(`${frontendUrl}/teams`, 302);
  }

  return error('not_found', 404);
}
