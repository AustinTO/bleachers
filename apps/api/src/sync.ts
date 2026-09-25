import { Env } from './index';
import { ExternalProvider, NormalizedGame, NormalizedTeam } from './providers';

/**
 * Upsert normalized teams from a provider into an organization.
 */
export async function syncTeams(
  env: Env, 
  organizationId: string, 
  providerId: string, 
  teams: NormalizedTeam[]
): Promise<void> {
  // A simplistic sync that just ensures they exist.
  // We match on name or create new if not matched.
  // Alternatively, we could add external_source/external_id to the `teams` table schema, 
  // but for Sprint 2 we assume name is stable enough, or we use the provider logic.
  
  // Note: For production, we should probably add external_id to teams table too,
  // but we'll stick to a basic insert if name doesn't exist for now.
  
  for (const team of teams) {
    const existing = await env.DB.prepare('SELECT id FROM teams WHERE organization_id = ? AND name = ?')
      .bind(organizationId, team.name).first<{ id: string }>();
      
    if (!existing) {
      const teamId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO teams (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(teamId, organizationId, team.name, new Date().toISOString()).run();
    }
  }
}

/**
 * Upsert normalized games from a provider into the games table.
 */
export async function syncGames(
  env: Env,
  teamId: string,
  providerId: string,
  games: NormalizedGame[]
): Promise<void> {
  for (const game of games) {
    const existing = await env.DB.prepare('SELECT id FROM games WHERE external_id = ? AND external_source = ?')
      .bind(game.externalId, providerId).first<{ id: string }>();
      
    if (!existing) {
      const gameId = crypto.randomUUID();
      // Only set to scheduled if we have a valid future start time, else 'ended' (simple heuristic)
      const isFuture = game.startTime.getTime() > Date.now();
      const status = isFuture ? 'scheduled' : 'ended';
      
      await env.DB.prepare(`
        INSERT INTO games (id, status, team_id, season_id, external_id, external_source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        gameId, 
        status, 
        teamId, 
        game.seasonId || null, 
        game.externalId, 
        providerId, 
        new Date().toISOString()
      ).run();
      
      // We also initialize the game state for the simulcast/broadcaster
      const stateObj = env.GAME_STATE.get(env.GAME_STATE.idFromName(gameId));
      await stateObj.fetch('http://internal/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          homeTeam: game.homeTeamName,
          awayTeam: game.awayTeamName
        })
      });
    }
  }
}
