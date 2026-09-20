import { DurableObject } from 'cloudflare:workers';

export interface Env {
  DB: D1Database;
  GAME_STATE: DurableObjectNamespace<GameState>;
  CLOUDFLARE_ACCOUNT_ID: string;
  MOQ_RELAY_ID: string;
  CLOUDFLARE_MOQ_API_TOKEN?: string;
  MOQ_DEFAULT_PUBLISHER_TOKEN?: string;
  MOQ_DEFAULT_VIEWER_TOKEN?: string;
  /** `cloudflare` = draft-16 JWT path; default = moq.live moq-lite (MoQKit-compatible). */
  MOQ_PROFILE?: string;
  /** Unused; draft selection is implied by MOQ_PROFILE. */
  MOQ_DRAFT?: string;
}

type TeamSide = 'home' | 'away';
type EventKind = 'GOAL' | 'SAVE' | 'FOUL' | 'HIGHLIGHT';

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
  sequence: number;
  events: GameEvent[];
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const cors = (response: Response) => {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  return new Response(response.body, { status: response.status, headers });
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const error = (code: string, status: number) => json({ error: code }, status);
const id = () => crypto.randomUUID();

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
      this.snapshot = { gameId, status: 'scheduled', homeScore: 0, awayScore: 0, clockSeconds: 0, clockRunning: false, sequence: 0, events: [] };
      await this.persist();
    }
    return this.snapshot;
  }

  async getSnapshot(): Promise<GameSnapshot | undefined> { return this.snapshot; }

  async start(): Promise<GameSnapshot> {
    const snapshot = this.requireSnapshot();
    snapshot.status = 'live';
    snapshot.clockRunning = true;
    await this.persist();
    return snapshot;
  }

  async applyCommand(command: { kind: EventKind | 'CLOCK'; team?: TeamSide; running?: boolean; clockSeconds?: number }): Promise<GameSnapshot> {
    const snapshot = this.requireSnapshot();
    if (snapshot.status !== 'live') throw new Error('game_not_live');

    if (command.kind === 'CLOCK') {
      if (typeof command.running === 'boolean') snapshot.clockRunning = command.running;
      if (typeof command.clockSeconds === 'number' && command.clockSeconds >= 0) snapshot.clockSeconds = Math.floor(command.clockSeconds);
      await this.persist();
      return snapshot;
    }

    if (typeof command.clockSeconds === 'number' && command.clockSeconds >= 0) snapshot.clockSeconds = Math.floor(command.clockSeconds);
    if (command.kind === 'GOAL' && command.team === 'home') snapshot.homeScore += 1;
    if (command.kind === 'GOAL' && command.team === 'away') snapshot.awayScore += 1;
    snapshot.sequence += 1;
    const event: GameEvent = { id: id(), sequence: snapshot.sequence, kind: command.kind, team: command.team, gameTimeSeconds: snapshot.clockSeconds, createdAt: new Date().toISOString() };
    snapshot.events = [event, ...snapshot.events].slice(0, 100);
    await this.persist();
    await this.env.DB.prepare('INSERT INTO game_events (id, game_id, sequence, kind, game_time_seconds, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(event.id, snapshot.gameId, event.sequence, event.kind, event.gameTimeSeconds, JSON.stringify(event), event.createdAt).run();
    return snapshot;
  }

  private requireSnapshot() {
    if (!this.snapshot) throw new Error('game_not_found');
    return this.snapshot;
  }
  private async persist() { await this.ctx.storage.put('snapshot', this.snapshot!); }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    let response: Response;

    if (request.method === 'GET' && url.pathname === '/health') response = json({ ok: true, service: 'bleachers-api' });
    else if (request.method === 'POST' && url.pathname === '/v1/games') response = await createGame(request, env);
    else if (parts[0] === 'v1' && parts[1] === 'games' && parts[2]) response = await gameRoute(request, env, parts[2], parts.slice(3));
    else response = error('not_found', 404);
    return cors(response);
  },
} satisfies ExportedHandler<Env>;

async function createGame(request: Request, env: Env) {
  const input = await body<{ homeTeam?: string; awayTeam?: string }>(request);
  const homeTeam = input?.homeTeam?.trim();
  const awayTeam = input?.awayTeam?.trim();
  if (!homeTeam || !awayTeam) return error('homeTeam_and_awayTeam_required', 400);
  const gameId = id();
  const createdAt = new Date().toISOString();
  await env.DB.prepare('INSERT INTO games (id, home_team, away_team, created_at) VALUES (?, ?, ?, ?)').bind(gameId, homeTeam, awayTeam, createdAt).run();
  const game = await env.GAME_STATE.getByName(gameId).create(gameId);
  return json({ game: { ...game, homeTeam, awayTeam, createdAt } }, 201);
}

async function gameRoute(request: Request, env: Env, gameId: string, rest: string[]) {
  let row = await env.DB.prepare('SELECT id, home_team, away_team, status, created_at FROM games WHERE id = ?').bind(gameId).first<{ id: string; home_team: string; away_team: string; status: string; created_at: string }>();
  // The broadcaster displays a short game code. Accept it when it resolves to
  // one game; private production links should continue to use the full UUID.
  if (!row && gameId.length >= 6 && gameId.length < 36) {
    row = await env.DB.prepare('SELECT id, home_team, away_team, status, created_at FROM games WHERE id LIKE ? LIMIT 1').bind(`${gameId}%`).first<{ id: string; home_team: string; away_team: string; status: string; created_at: string }>();
  }
  if (!row) return error('game_not_found', 404);
  const resolvedGameId = row.id;
  const game = env.GAME_STATE.getByName(resolvedGameId);
  if (request.method === 'GET' && rest.length === 0) return json({ game: { ...(await game.getSnapshot()), homeTeam: row.home_team, awayTeam: row.away_team, createdAt: row.created_at } });
  if (request.method === 'POST' && rest[0] === 'media-capability') return mintMediaCapability(request, env, resolvedGameId);
  if (request.method === 'POST' && rest[0] === 'start') {
    const snapshot = await game.start();
    await env.DB.prepare("UPDATE games SET status = 'live', started_at = COALESCE(started_at, ?) WHERE id = ?").bind(new Date().toISOString(), resolvedGameId).run();
    return json({ game: { ...snapshot, homeTeam: row.home_team, awayTeam: row.away_team } });
  }
  if (request.method === 'POST' && rest[0] === 'commands') {
    const command = await body<{ kind?: EventKind | 'CLOCK'; team?: TeamSide; running?: boolean; clockSeconds?: number }>(request);
    if (!command?.kind || !['GOAL', 'SAVE', 'FOUL', 'HIGHLIGHT', 'CLOCK'].includes(command.kind)) return error('invalid_command', 400);
    try {
      return json({ game: await game.applyCommand({ kind: command.kind, team: command.team, running: command.running, clockSeconds: command.clockSeconds }) });
    } catch (cause) { return error(cause instanceof Error ? cause.message : 'command_failed', 409); }
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
