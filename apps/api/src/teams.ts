import { Env } from './index';
import { authMiddleware } from './auth';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function error(code: string, status = 400) {
  return json({ error: code }, status);
}

export async function createOrganization(request: Request, env: Env): Promise<Response> {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  const { name } = await request.json().catch(() => ({})) as { name?: string };
  if (!name) return error('missing_name');
  
  const orgId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').bind(orgId, name, new Date().toISOString()).run();
  
  // Also add the user as an owner
  await env.DB.prepare('INSERT INTO organization_members (user_id, organization_id, role, created_at) VALUES (?, ?, ?, ?)').bind(userId, orgId, 'owner', new Date().toISOString()).run();
  
  return json({ id: orgId, name });
}

export async function createTeam(request: Request, env: Env): Promise<Response> {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  const { organizationId, name, logoUrl, primaryColor } = await request.json().catch(() => ({})) as { organizationId?: string, name?: string, logoUrl?: string, primaryColor?: string };
  if (!organizationId || !name) return error('missing_params');
  
  // Verify user is owner/admin of org
  const role = await env.DB.prepare('SELECT role FROM organization_members WHERE user_id = ? AND organization_id = ?').bind(userId, organizationId).first<{ role: string }>();
  if (!role || (role.role !== 'owner' && role.role !== 'admin')) return error('forbidden', 403);
  
  const teamId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO teams (id, organization_id, name, logo_url, primary_color, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(teamId, organizationId, name, logoUrl || null, primaryColor || null, new Date().toISOString()).run();
  
  // Also add the user as an admin to the team specifically
  await env.DB.prepare('INSERT INTO team_members (user_id, team_id, role, created_at) VALUES (?, ?, ?, ?)').bind(userId, teamId, 'admin', new Date().toISOString()).run();
  
  return json({ id: teamId, organizationId, name, logoUrl, primaryColor });
}

export async function updateTeam(request: Request, env: Env, teamId: string): Promise<Response> {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  const { name, logoUrl, primaryColor } = await request.json().catch(() => ({})) as { name?: string, logoUrl?: string, primaryColor?: string };
  
  // Verify user is owner/admin of team
  const role = await env.DB.prepare('SELECT role FROM team_members WHERE user_id = ? AND team_id = ?').bind(userId, teamId).first<{ role: string }>();
  if (!role || (role.role !== 'owner' && role.role !== 'admin')) return error('forbidden', 403);
  
  if (name) {
    await env.DB.prepare('UPDATE teams SET name = ?, logo_url = ?, primary_color = ? WHERE id = ?').bind(name, logoUrl || null, primaryColor || null, teamId).run();
  } else {
    await env.DB.prepare('UPDATE teams SET logo_url = ?, primary_color = ? WHERE id = ?').bind(logoUrl || null, primaryColor || null, teamId).run();
  }
  
  return json({ success: true });
}

export async function getMyOrganizationsAndTeams(request: Request, env: Env): Promise<Response> {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  
  // We fetch orgs where the user is a member
  const orgsResult = await env.DB.prepare(`
    SELECT o.id, o.name, om.role 
    FROM organizations o 
    JOIN organization_members om ON o.id = om.organization_id 
    WHERE om.user_id = ?
  `).bind(userId).all();
  
  // And fetch teams where the user is a member
  const teamsResult = await env.DB.prepare(`
    SELECT t.id, t.organization_id, t.name, t.logo_url, t.primary_color, tm.role 
    FROM teams t 
    JOIN team_members tm ON t.id = tm.team_id 
    WHERE tm.user_id = ?
  `).bind(userId).all();
  
  return json({
    organizations: orgsResult.results,
    teams: teamsResult.results
  });
}
