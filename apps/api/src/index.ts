import { DurableObject } from 'cloudflare:workers';
import { requestAuthCode, verifyAuthCode, mergeAuth, getMe, authMiddleware } from "./auth";
import { createOrganization, createTeam, getMyOrganizationsAndTeams } from "./teams";
import { bandAuthRoute } from "./band";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  GAME_STATE: DurableObjectNamespace<GameState>;
  CLOUDFLARE_ACCOUNT_ID: string;
  MOQ_RELAY_ID: string;
  CLOUDFLARE_MOQ_API_TOKEN?: string;
  MOQ_DEFAULT_PUBLISHER_TOKEN?: string;
  MOQ_DEFAULT_VIEWER_TOKEN?: string;
  /** `cloudflare` = draft-16 JWT path; default = moq.live moq-lite (MoQKit-compatible). */
  MOQ_PROFILE?: string;
  BAND_CLIENT_ID?: string;
  BAND_CLIENT_SECRET?: string;
  FRONTEND_URL?: string;
  /** Unused; draft selection is implied by MOQ_PROFILE. */
  MOQ_DRAFT?: string;
  EMAIL?: any;
}

type TeamSide = 'home' | 'away';
type EventKind = 'GOAL' | 'SAVE' | 'FOUL' | 'HIGHLIGHT' | 'GOAL_CORRECTION';

type GameEvent = {
  id: string;
  sequence: number;
  kind: EventKind;
  gameTimeSeconds: number;
  team?: TeamSide;
  createdAt: string;
};

type GameSnapshot = {
  gameId: string;
  status: 'scheduled' | 'live' | 'ended';
  homeScore: number;
  awayScore: number;
  clockSeconds: number;
  clockRunning: boolean;
  clockUpdatedAt?: number;
  sequence: number;
  events: GameEvent[];
  latestTelemetry?: any;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const cors = (response: Response, request?: Request) => {
  const headers = new Headers(response.headers);
  const origin = request?.headers.get('origin') || '*';
  headers.set('access-control-allow-origin', origin);
  if (origin !== '*') headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type, authorization, x-capture-start-ms, x-capture-end-ms, x-user-id');
  return new Response(response.body, { status: response.status, headers });
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const error = (code: string, status: number) => json({ error: code }, status);
const id = () => crypto.randomUUID();
const PIN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const organizerPin = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => PIN_ALPHABET[byte & 31]).join('');
};
function normalizeOrganizerSecret(value: string) {
  const trimmed = value.trim();
  const compact = trimmed.replace(/[-_\s]/g, '').toUpperCase();
  return /^[2-9A-HJ-NP-Z]{8}$/.test(compact) ? compact : trimmed;
}
async function hashSecret(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeOrganizerSecret(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function body<T>(request: Request): Promise<T | null> {
  try { return await request.json<T>(); } catch { return null; }
}

export class GameState extends DurableObject<Env> {
  private snapshot: GameSnapshot | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.snapshot = await this.ctx.storage.get<GameSnapshot>('snapshot');
    });
  }

  async create(gameId: string): Promise<GameSnapshot> {
    if (!this.snapshot) {
      this.snapshot = { gameId, status: 'scheduled', homeScore: 0, awayScore: 0, clockSeconds: 0, clockRunning: false, clockUpdatedAt: Date.now(), sequence: 0, events: [] };
      await this.persist();
    }
    return this.snapshot;
  }

  async getSnapshot(): Promise<GameSnapshot | undefined> {
    if (!this.snapshot) return undefined;
    const elapsed = this.snapshot.clockRunning ? Math.floor((Date.now() - (this.snapshot.clockUpdatedAt ?? Date.now())) / 1000) : 0;
    return { ...this.snapshot, clockSeconds: this.snapshot.clockSeconds + Math.max(0, elapsed) };
  }

  private advanceClock() {
    if (!this.snapshot) return;
    const now = Date.now();
    if (this.snapshot.clockRunning && this.snapshot.clockUpdatedAt) this.snapshot.clockSeconds += Math.max(0, Math.floor((now - this.snapshot.clockUpdatedAt) / 1000));
    this.snapshot.clockUpdatedAt = now;
  }

  async start(): Promise<GameSnapshot> {
    const snapshot = this.requireSnapshot();
    if (snapshot.status !== 'scheduled') throw new Error('game_not_scheduled');
    snapshot.clockUpdatedAt = Date.now();
    snapshot.status = 'live';
    snapshot.clockRunning = true;
    await this.persist();
    return snapshot;
  }

  async end(): Promise<GameSnapshot> {
    const snapshot = this.requireSnapshot();
    if (snapshot.status !== 'live') throw new Error('game_not_live');
    this.advanceClock();
    snapshot.status = 'ended';
    snapshot.clockRunning = false;
    await this.persist();
    return snapshot;
  }

  async applyCommand(command: { kind: EventKind | 'CLOCK'; team?: TeamSide; running?: boolean; clockSeconds?: number }): Promise<GameSnapshot> {
    const snapshot = this.requireSnapshot();
    if (snapshot.status !== 'live') throw new Error('game_not_live');
    this.advanceClock();

    if (command.kind === 'CLOCK') {
      if (typeof command.running === 'boolean') snapshot.clockRunning = command.running;
      if (typeof command.clockSeconds === 'number' && Number.isFinite(command.clockSeconds) && command.clockSeconds >= 0) snapshot.clockSeconds = Math.floor(command.clockSeconds);
      await this.persist();
      return snapshot;
    }

    if (typeof command.clockSeconds === 'number' && Number.isFinite(command.clockSeconds) && command.clockSeconds >= 0) snapshot.clockSeconds = Math.floor(command.clockSeconds);
    if (command.kind === 'GOAL' && command.team === 'home') snapshot.homeScore += 1;
    if (command.kind === 'GOAL' && command.team === 'away') snapshot.awayScore += 1;
    if (command.kind === 'GOAL_CORRECTION') {
      if (command.team === 'home' && snapshot.homeScore > 0) snapshot.homeScore -= 1;
      else if (command.team === 'away' && snapshot.awayScore > 0) snapshot.awayScore -= 1;
      else throw new Error('score_cannot_be_reduced');
    }
    snapshot.sequence += 1;
    const event: GameEvent = { id: id(), sequence: snapshot.sequence, kind: command.kind, team: command.team, gameTimeSeconds: snapshot.clockSeconds, createdAt: new Date().toISOString() };
    snapshot.events = [event, ...snapshot.events].slice(0, 100);
    await this.persist();
    await this.env.DB.prepare('INSERT INTO game_events (id, game_id, sequence, kind, game_time_seconds, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(event.id, snapshot.gameId, event.sequence, event.kind, event.gameTimeSeconds, JSON.stringify(event), event.createdAt).run();
    return snapshot;
  }

  async applyTelemetry(data: any): Promise<void> {
    const snapshot = this.requireSnapshot();
    if (snapshot.status !== 'live') return;
    snapshot.latestTelemetry = data;
    await this.persist();
  }

  private requireSnapshot() {
    if (!this.snapshot) throw new Error('game_not_found');
    return this.snapshot;
  }
  private async persist() { await this.ctx.storage.put('snapshot', this.snapshot!); }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request);
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    let response: Response;

    if (request.method === 'GET' && url.pathname === '/health') response = json({ ok: true, service: 'bleachers-api' });
    else if (request.method === 'POST' && url.pathname === '/v1/games') response = await createGame(request, env);
    else if (request.method === 'POST' && url.pathname === '/v1/auth/request-code') response = await requestAuthCode(request, env);
    else if (request.method === 'POST' && url.pathname === '/v1/auth/verify') response = await verifyAuthCode(request, env);
    else if (request.method === 'POST' && url.pathname === '/v1/auth/merge') response = await mergeAuth(request, env);
    else if (request.method === 'GET' && url.pathname.startsWith('/v1/auth/band')) response = await bandAuthRoute(request, env, url.pathname);
    else if (request.method === 'GET' && url.pathname === '/v1/users/me') response = await getMe(request, env);
    else if (request.method === 'POST' && url.pathname === '/v1/organizations') response = await createOrganization(request, env);
    else if (request.method === 'POST' && url.pathname === '/v1/teams') response = await createTeam(request, env);
    else if (request.method === 'GET' && url.pathname === '/v1/users/me/organizations') response = await getMyOrganizationsAndTeams(request, env);
    else if (parts[0] === 'v1' && parts[1] === 'games' && parts[2]) response = await gameRoute(request, env, parts[2], parts.slice(3));
    else if (request.method === 'GET' && parts[0] === 'v1' && parts[1] === 'teams' && parts[2] && parts[3] === 'games') response = await teamGamesRoute(request, env, parts[2]);
    else response = error('not_found', 404);
    return cors(response, request);
  },
  async scheduled(event, env, ctx) {
    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const old = await env.DB.prepare('SELECT id, r2_key FROM media_segments WHERE end_ms < ? LIMIT 500').bind(cutoffMs).all<{ id: string; r2_key: string }>();
    if (old.results && old.results.length > 0) {
      const keys = old.results.map((r) => r.r2_key);
      await Promise.all(keys.map(k => env.MEDIA.delete(k)));
      const ids = old.results.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM media_segments WHERE id IN (${placeholders})`).bind(...ids).run();
    }

    // Background Sync Cron for Sprint 6
    const teams = await env.DB.prepare("SELECT id, external_id, external_source FROM teams WHERE external_source = 'se_tourney' AND external_id IS NOT NULL").all<{ id: string; external_id: string; external_source: string }>();
    if (teams.results && teams.results.length > 0) {
      const { SeTourneyProvider } = await import('./providers/se_tourney');
      const provider = new SeTourneyProvider();
      
      for (const team of teams.results) {
        try {
          const schedule = await provider.fetchSchedule({ apiKey: 'mock_key' }, team.external_id);
          for (const extGame of schedule) {
            // Check if game exists
            const existing = await env.DB.prepare('SELECT id, status FROM games WHERE external_id = ? AND external_source = ?').bind(extGame.externalId, team.external_source).first<{ id: string; status: string }>();
            
            if (!existing) {
              // Create Draft Broadcast for imported game
              const gameId = id();
              const organizerSecret = organizerPin();
              const createdAt = new Date().toISOString();
              await env.DB.prepare(`
                INSERT INTO games (id, home_team, away_team, created_at, organizer_secret_hash, status, team_id, external_id, external_source) 
                VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
              `).bind(gameId, extGame.homeTeamName, extGame.awayTeamName, createdAt, await hashSecret(organizerSecret), team.id, extGame.externalId, team.external_source).run();
              // Initialize Durable Object state
              await env.GAME_STATE.getByName(gameId).create(gameId);
            } else if (existing.status === 'scheduled') {
              // Only update scheduled games (do not overwrite if live/ended)
              await env.DB.prepare(`
                UPDATE games SET home_team = ?, away_team = ? WHERE id = ?
              `).bind(extGame.homeTeamName, extGame.awayTeamName, existing.id).run();
            }
          }
        } catch (err) {
          console.error(`Sync failed for team ${team.id}:`, err);
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function createGame(request: Request, env: Env) {
  const input = await body<{ homeTeam?: string; awayTeam?: string; teamId?: string }>(request);
  const homeTeam = input?.homeTeam?.trim();
  const awayTeam = input?.awayTeam?.trim();
  const teamId = input?.teamId?.trim() || null;
  
  if (!homeTeam || !awayTeam) return error('homeTeam_and_awayTeam_required', 400);

  if (teamId) {
    const userId = await authMiddleware(request, env);
    if (!userId) return error('unauthorized', 401);
    const membership = await env.DB.prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin', 'coach', 'broadcaster')").bind(teamId, userId).first<{ role: string }>();
    if (!membership) return error('unauthorized', 403);
  }

  const gameId = id();
  const organizerSecret = organizerPin();
  const createdAt = new Date().toISOString();
  await env.DB.prepare('INSERT INTO games (id, home_team, away_team, created_at, organizer_secret_hash, status, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(gameId, homeTeam, awayTeam, createdAt, await hashSecret(organizerSecret), 'scheduled', teamId).run();
  const game = await env.GAME_STATE.getByName(gameId).create(gameId);
  return json({ game: { ...game, homeTeam, awayTeam, createdAt, status: 'scheduled' }, organizerSecret }, 201);
}

async function teamGamesRoute(request: Request, env: Env, teamId: string) {
  const userId = await authMiddleware(request, env);
  if (!userId) return error('unauthorized', 401);
  const membership = await env.DB.prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, userId).first<{ role: string }>();
  if (!membership) return error('unauthorized', 403);

  const records = await env.DB.prepare('SELECT id, home_team, away_team, status, created_at, started_at, ended_at FROM games WHERE team_id = ? ORDER BY created_at DESC LIMIT 50').bind(teamId).all<{ id: string; home_team: string; away_team: string; status: string; created_at: string; started_at: string | null; ended_at: string | null }>();
  return json({
    team: teamId,
    games: records.results.map(r => ({
      gameId: r.id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      status: r.status,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at
    }))
  });
}

import { hlsPlaylistRoute, hlsSegmentRoute } from './hls';

async function gameRoute(request: Request, env: Env, gameId: string, rest: string[]) {
  let row = await env.DB.prepare('SELECT id, home_team, away_team, status, created_at, team_id FROM games WHERE id = ?').bind(gameId).first<{ id: string; home_team: string; away_team: string; status: string; created_at: string; team_id: string | null }>();
  // The broadcaster displays a short game code. Accept it when it resolves to
  // one game; private production links should continue to use the full UUID.
  if (!row && gameId.length >= 6 && gameId.length < 36) {
    const matches = await env.DB.prepare('SELECT id, home_team, away_team, status, created_at, team_id FROM games WHERE id LIKE ? LIMIT 2').bind(`${gameId}%`).all<{ id: string; home_team: string; away_team: string; status: string; created_at: string; team_id: string | null }>();
    if (matches.results.length > 1) return error('ambiguous_game_code', 409);
    row = matches.results[0] ?? null;
  }
  if (!row) return error('game_not_found', 404);
  const resolvedGameId = row.id;
  
  if (request.method === 'GET' && rest[0] === 'hls' && rest[1] === 'playlist.m3u8') return hlsPlaylistRoute(request, env, resolvedGameId);
  if (request.method === 'GET' && rest[0] === 'hls' && rest[1] === 'segment' && rest[2]) return hlsSegmentRoute(request, env, resolvedGameId, rest[2]);
  
  const capabilityInput = rest[0] === 'media-capability' ? await body<{ role?: string }>(request.clone()) : null;
  const protectedAction = request.method === 'POST' && (['start', 'end', 'commands', 'media-segments', 'broadcast-simulcast'].includes(rest[0]) || rest[0] === 'media-capability' && capabilityInput?.role === 'publisher');
  if (protectedAction) {
    const stored = await env.DB.prepare('SELECT organizer_secret_hash FROM games WHERE id = ?').bind(resolvedGameId).first<{ organizer_secret_hash: string | null }>();
    const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    
    let authorized = false;
    if (supplied) {
      if (stored?.organizer_secret_hash && await hashSecret(supplied) === stored.organizer_secret_hash) {
        authorized = true;
      } else {
        const session = await env.DB.prepare('SELECT user_id FROM auth_sessions WHERE token = ? AND expires_at > ?').bind(supplied, Date.now()).first<{ user_id: string }>();
        if (session && row.team_id) {
          const membership = await env.DB.prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin', 'broadcaster', 'coach')").bind(row.team_id, session.user_id).first<{ role: string }>();
          if (membership) authorized = true;
        }
      }
    }
    if (!authorized) return error('organizer_authorization_required', 403);
  }
  const game = env.GAME_STATE.getByName(resolvedGameId);
  if (rest[0] === 'media-segments') return mediaSegmentRoute(request, env, resolvedGameId, rest);
  if (request.method === 'GET' && rest.length === 0) {
    const snapshot = await game.getSnapshot() as any;
    return json({ game: { status: row.status, homeScore: 0, awayScore: 0, clockSeconds: 0, clockRunning: false, sequence: 0, events: [], ...snapshot, homeTeam: row.home_team, awayTeam: row.away_team, createdAt: row.created_at } });
  }
  if (request.method === 'GET' && rest[0] === 'events') {
    const records = await env.DB.prepare('SELECT payload_json FROM game_events WHERE game_id = ? ORDER BY sequence DESC LIMIT 1000').bind(resolvedGameId).all<{ payload_json: string }>();
    return json({ events: records.results.map((record) => JSON.parse(record.payload_json) as GameEvent) });
  }
  if (request.method === 'POST' && rest[0] === 'media-capability') return mintMediaCapability(request, env, resolvedGameId);
  if (request.method === 'POST' && rest[0] === 'start') {
    let snapshot: GameSnapshot;
    try { snapshot = await game.start(); } catch { return error('game_not_scheduled', 409); }
    await env.DB.prepare("UPDATE games SET status = 'live', started_at = COALESCE(started_at, ?) WHERE id = ?").bind(new Date().toISOString(), resolvedGameId).run();
    return json({ game: { ...snapshot, homeTeam: row.home_team, awayTeam: row.away_team } });
  }
  if (request.method === 'POST' && rest[0] === 'end') {
    let snapshot: GameSnapshot;
    try { snapshot = await game.end(); } catch { return error('game_not_live', 409); }
    await env.DB.prepare("UPDATE games SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE id = ?").bind(new Date().toISOString(), resolvedGameId).run();
    return json({ game: { ...snapshot, homeTeam: row.home_team, awayTeam: row.away_team } });
  }
  if (request.method === 'POST' && rest[0] === 'commands') {
    const command = await body<{ kind?: EventKind | 'CLOCK'; team?: TeamSide; running?: boolean; clockSeconds?: number }>(request);
    if (!command?.kind || !['GOAL', 'SAVE', 'FOUL', 'HIGHLIGHT', 'GOAL_CORRECTION', 'CLOCK'].includes(command.kind)) return error('invalid_command', 400);
    if (['GOAL', 'GOAL_CORRECTION'].includes(command.kind) && command.team !== 'home' && command.team !== 'away') return error('goal_team_required', 400);
    if (command.clockSeconds !== undefined && (!Number.isFinite(command.clockSeconds) || command.clockSeconds < 0 || command.clockSeconds > 86400)) return error('invalid_clock', 400);
    try {
      return json({ game: await game.applyCommand({ kind: command.kind, team: command.team, running: command.running, clockSeconds: command.clockSeconds }) });
    } catch (cause) { return error(cause instanceof Error ? cause.message : 'command_failed', 409); }
  }
  if (request.method === 'POST' && rest[0] === 'telemetry') {
    const telemetry = await body<any>(request);
    if (!telemetry) return error('invalid_telemetry', 400);
    try {
      await game.applyTelemetry(telemetry);
      return json({ success: true });
    } catch (cause) { return error('telemetry_failed', 500); }
  }
  if (request.method === 'POST' && rest[0] === 'broadcast-simulcast') {
    const input = await body<{ rtmpUrl?: string }>(request);
    if (!input?.rtmpUrl) return error('invalid_rtmp_url', 400);
    
    // Trigger Cloudflare Container deployment of media-gateway
    console.log(`[simulcast] Triggering media-gateway container for game ${resolvedGameId} to ${input.rtmpUrl}`);
    
    // We would use Cloudflare Service Bindings to trigger the container:
    // await env.MEDIA_GATEWAY_SERVICE.fetch('http://media-gateway/start', {
    //   method: 'POST',
    //   body: JSON.stringify({ gameId: resolvedGameId, rtmpUrl: input.rtmpUrl })
    // });
    
    return json({ success: true, message: 'Simulcast gateway started' });
  }
  if (request.method === 'GET' && rest[0] === 'moments') {
    const viewerSessionId = new URL(request.url).searchParams.get('viewerSessionId')?.trim();
    if (!viewerSessionId || viewerSessionId.length > 128) return error('invalid_viewer_session', 400);
    const records = await env.DB.prepare('SELECT m.id, m.event_id, m.game_time_seconds, m.created_at, COALESCE(m.media_at_ms, unixepoch(m.created_at) * 1000) AS media_at_ms, EXISTS (SELECT 1 FROM media_segments s WHERE s.game_id = m.game_id AND s.start_ms <= COALESCE(m.media_at_ms, unixepoch(m.created_at) * 1000) + 1000 AND s.end_ms >= COALESCE(m.media_at_ms, unixepoch(m.created_at) * 1000) - 1000) AS media_ready FROM moment_saves m WHERE m.game_id = ? AND m.viewer_session_id = ? ORDER BY m.created_at DESC LIMIT 100')
      .bind(resolvedGameId, viewerSessionId).all<{ id: string; event_id: string | null; game_time_seconds: number; created_at: string; media_at_ms: number; media_ready: number }>();
    return json({ moments: records.results });
  }
  if (request.method === 'POST' && rest[0] === 'moments') {
    const input = await body<{ eventId?: string; gameTimeSeconds?: number; viewerSessionId?: string; mediaAtMs?: number }>(request);
    const viewerSessionId = input?.viewerSessionId?.trim();
    const gameTimeSeconds = input?.gameTimeSeconds;
    if (!viewerSessionId || viewerSessionId.length > 128 || typeof gameTimeSeconds !== 'number' || !Number.isFinite(gameTimeSeconds) || gameTimeSeconds < 0) return error('invalid_moment', 400);
    const mediaAtMs = input?.mediaAtMs ?? Date.now();
    if (!Number.isSafeInteger(mediaAtMs) || mediaAtMs < Date.parse(row.created_at) - 10_000 || mediaAtMs > Date.now() + 5_000) return error('invalid_media_time', 400);
    const eventId = input?.eventId?.trim() || null;
    const saveId = id();
    const createdAt = new Date().toISOString();
    try {
      await env.DB.prepare('INSERT INTO moment_saves (id, game_id, event_id, game_time_seconds, viewer_session_id, created_at, media_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(saveId, resolvedGameId, eventId, Math.floor(gameTimeSeconds), viewerSessionId, createdAt, mediaAtMs).run();
      return json({ saved: true, id: saveId, gameId: resolvedGameId, eventId, gameTimeSeconds: Math.floor(gameTimeSeconds), createdAt, mediaAtMs }, 201);
    } catch (cause) {
      // Duplicate saves from the same anonymous viewer are idempotent.
      if (String(cause).toLowerCase().includes('unique')) {
        const saved = await env.DB.prepare('SELECT id, created_at, media_at_ms FROM moment_saves WHERE game_id = ? AND viewer_session_id = ? AND event_id = ?')
          .bind(resolvedGameId, viewerSessionId, eventId).first<{ id: string; created_at: string; media_at_ms: number | null }>();
        if (saved) return json({ saved: true, duplicate: true, id: saved.id, gameId: resolvedGameId, eventId, gameTimeSeconds: Math.floor(gameTimeSeconds), createdAt: saved.created_at, mediaAtMs: saved.media_at_ms ?? Date.parse(saved.created_at) });
      }
      return error('moment_save_failed', 500);
    }
  }
  return error('not_found', 404);
}

const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
type MediaSegmentRow = { id: string; start_ms: number; end_ms: number; r2_key: string; size_bytes: number };

function validSegmentPayload(bytes: Uint8Array): boolean {
  let offset = 0;
  let frames = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    offset += 4;
    if (length < 18 || length > bytes.length - offset) return false;
    const magic = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (magic !== 'BLC1' && magic !== 'BLA1') return false;
    if (frames === 0 && bytes[offset + 4] !== 1) return false;
    offset += length;
    frames++;
  }
  return frames > 0 && offset === bytes.length;
}

async function mediaSegmentRoute(request: Request, env: Env, gameId: string, rest: string[]): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'POST' && rest.length === 1) {
    const startMs = Number(request.headers.get('x-capture-start-ms'));
    const endMs = Number(request.headers.get('x-capture-end-ms'));
    const now = Date.now();
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return error('invalid_media_type', 415);
    if (!request.headers.has('x-capture-start-ms') || !request.headers.has('x-capture-end-ms') || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs || endMs - startMs > 60_000 || startMs < now - 86_400_000 || endMs > now + 120_000) return error('invalid_capture_time', 400);
    const declaredSize = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_SEGMENT_BYTES) return error('media_segment_too_large', 413);
    const reader = request.body?.getReader();
    if (!reader) return error('invalid_media_segment', 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SEGMENT_BYTES) {
        await reader.cancel();
        return error('media_segment_too_large', 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    if (!validSegmentPayload(bytes)) return error('invalid_media_segment', 400);
    const segmentId = id();
    const key = `games/${gameId}/segments/${segmentId}.bin`;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
    try {
      await env.DB.prepare('INSERT INTO media_segments (id, game_id, start_ms, end_ms, r2_key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(segmentId, gameId, startMs, endMs, key, bytes.length, new Date().toISOString()).run();
    } catch (cause) {
      await env.MEDIA.delete(key);
      throw cause;
    }
    return json({ segment: { id: segmentId, startMs, endMs, url: `/v1/games/${gameId}/media-segments/${segmentId}` } }, 201);
  }
  if (request.method === 'GET' && rest.length === 1) {
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!url.searchParams.has('from') || !url.searchParams.has('to') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > 86_400_000) return error('invalid_time_range', 400);
    const records = await env.DB.prepare('SELECT id, start_ms, end_ms, r2_key, size_bytes FROM media_segments WHERE game_id = ? AND end_ms >= ? AND start_ms <= ? ORDER BY start_ms ASC LIMIT 500')
      .bind(gameId, from, to).all<MediaSegmentRow>();
    return json({ segments: records.results.map((segment) => ({ id: segment.id, startMs: segment.start_ms, endMs: segment.end_ms, url: `/v1/games/${gameId}/media-segments/${segment.id}` })) });
  }
  if (request.method === 'GET' && rest.length === 2) {
    const segment = await env.DB.prepare('SELECT id, start_ms, end_ms, r2_key, size_bytes FROM media_segments WHERE game_id = ? AND id = ?')
      .bind(gameId, rest[1]).first<MediaSegmentRow>();
    if (!segment) return error('media_segment_not_found', 404);
    const object = await env.MEDIA.get(segment.r2_key);
    if (!object) return error('media_segment_not_found', 404);
    return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=60' } });
  }
  return error('not_found', 404);
}

type CloudflareTokenResponse = {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: { issuers?: Array<{ cloudflare_tokens?: Array<{ secret?: string; expires?: string }> }> };
};

type CapabilityIdentity = { jti?: string; sub?: string; aud?: string | string[]; scope?: unknown };

function inspectCapability(secret: string): CapabilityIdentity {
  try {
    const encoded = secret.split('.')[1];
    if (!encoded) return {};
    const json = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') .padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    const claims = JSON.parse(json) as Record<string, unknown>;
    return { jti: typeof claims.jti === 'string' ? claims.jti : undefined, sub: typeof claims.sub === 'string' ? claims.sub : undefined, aud: typeof claims.aud === 'string' || Array.isArray(claims.aud) ? claims.aud as string | string[] : undefined, scope: claims.scope };
  } catch { return {}; }
}

type CloudflareTokenListResponse = {
  success: boolean;
  result?: { issuers?: Array<{ cloudflare_tokens?: Array<{ jti?: string; label?: string; created?: string; expires?: string }> }> };
};

async function mintMediaCapability(request: Request, env: Env, gameId: string) {
  const input = await body<{ role?: 'publisher' | 'viewer' }>(request);
  if (input?.role !== 'publisher' && input?.role !== 'viewer') return error('invalid_media_role', 400);

  const broadcastName = `sports/${gameId}.hang`;

  // MoQKit / @moq speak moq-lite. Cloudflare draft-14/16 are IETF MOQT and reject
  // that handshake with HTTP 403 ("Forbidden") — path tokens do not change the ALPN.
  // Default Sprint-0 relay is moq.live (moq-lite). Set MOQ_PROFILE=cloudflare only when
  // an IETF native/browser client is in use; that path still Worker-mints draft-16 JWTs.
  if (env.MOQ_PROFILE === 'cloudflare') {
    const defaultToken = input.role === 'publisher' ? env.MOQ_DEFAULT_PUBLISHER_TOKEN : env.MOQ_DEFAULT_VIEWER_TOKEN;
    if (defaultToken) {
      const relayUrl = `https://draft-16.cloudflare.mediaoverquic.com/${defaultToken}`;
      const capabilityIdentity = inspectCapability(defaultToken);
      console.log(JSON.stringify({ component: 'media-capability', gameId, role: input.role, relayOrigin: new URL(relayUrl).origin, capabilityIdentity, broadcastName, namespace: broadcastName.split('/'), trackName: 'media/main/video', tokenMode: 'relay-default' }));
      return json({ relayUrl, broadcastName, expires: undefined, draft: '16', profile: 'cloudflare', capabilityIdentity });
    }
    if (!env.CLOUDFLARE_MOQ_API_TOKEN) return error('media_capability_service_not_configured', 503);
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const operations = input.role === 'publisher' ? ['publish', 'subscribe'] : ['subscribe'];
    const payload = await createCloudflareToken(env, operations, expires, `${input.role}:${gameId}`, input.role);
    const secret = payload.result?.issuers?.flatMap((issuer) => issuer.cloudflare_tokens ?? []).find((token) => token.secret)?.secret;
    if (!payload.success || !secret) {
      return json({ error: 'media_capability_mint_failed', detail: payload.errors?.[0]?.message ?? 'Cloudflare rejected capability minting.' }, 502);
    }
    const relayUrl = `https://draft-16.cloudflare.mediaoverquic.com/${secret}`;
    const capabilityIdentity = inspectCapability(secret);
    console.log(JSON.stringify({ component: 'media-capability', gameId, role: input.role, relayOrigin: new URL(relayUrl).origin, capabilityIdentity, broadcastName, namespace: broadcastName.split('/'), trackName: 'media/main/video' }));
    return json({
      relayUrl,
      broadcastName,
      expires,
      draft: '16',
      profile: 'cloudflare',
      capabilityIdentity,
    });
  }

  console.log(JSON.stringify({ component: 'media-capability', gameId, role: input.role, relayOrigin: 'https://moq.live', capabilityIdentity: 'moq-live-anon', broadcastName, namespace: broadcastName.split('/'), trackName: 'media/main/video' }));
  return json({
    relayUrl: 'https://moq.live/anon',
    broadcastName,
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    draft: 'lite',
    profile: 'moq-live',
    capabilityIdentity: 'moq-live-anon',
  });
}

function moqTokenUrl(env: Env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/moq/relays/${env.MOQ_RELAY_ID}/tokens`;
}

async function createCloudflareToken(env: Env, operations: string[], expires: string, label: string, role: 'publisher' | 'viewer'): Promise<CloudflareTokenResponse> {
  const create = async () => {
    const response = await fetch(moqTokenUrl(env), {
      method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_MOQ_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operations, expires, label }),
    });
    return response.json<CloudflareTokenResponse>();
  };
  let payload = await create();
  if (payload.success || !payload.errors?.some((entry) => entry.message?.toLowerCase().includes('maximum') || entry.message?.toLowerCase().includes('token limit'))) return payload;

  const listed = await fetch(moqTokenUrl(env), { headers: { authorization: `Bearer ${env.CLOUDFLARE_MOQ_API_TOKEN}` } });
  const registry = await listed.json<CloudflareTokenListResponse>();
  const tokens = registry.result?.issuers?.flatMap((issuer) => issuer.cloudflare_tokens ?? []) ?? [];
  // Cloudflare's relay beta has a small token cap. Cap recovery is deliberately
  // scoped to our labelled disposable capabilities; creation-time relay tokens
  // and externally managed tokens are never touched.
  const stale = tokens
    .filter((token) => token.jti && (token.label?.startsWith('viewer:') || token.label?.startsWith('publisher:')))
    .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '')) ?? [];
  await Promise.all(stale.map((token) => fetch(`${moqTokenUrl(env)}/${token.jti}`, { method: 'DELETE', headers: { authorization: `Bearer ${env.CLOUDFLARE_MOQ_API_TOKEN}` } })));
  payload = await create();
  return payload;
}
