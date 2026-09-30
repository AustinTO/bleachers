export type TeamSide = 'home' | 'away';
export type EventKind = 'GOAL' | 'SAVE' | 'FOUL' | 'HIGHLIGHT';

export type RemoteGameEvent = {
  id: string;
  sequence: number;
  kind: EventKind;
  team?: TeamSide;
  gameTimeSeconds: number;
  createdAt: string;
};

export type RemoteGame = {
  gameId: string;
  homeTeam?: string;
  awayTeam?: string;
  status: 'scheduled' | 'live' | 'ended';
  homeScore: number;
  awayScore: number;
  clockSeconds: number;
  clockRunning: boolean;
  sequence: number;
  events: RemoteGameEvent[];
};

export type MediaCapability = { relayUrl: string; broadcastName: string; expires: string; profile?: string; draft?: string; capabilityIdentity?: unknown };

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'https://bleachers-api.austintaylorodell.workers.dev';
let organizerSecret = '';
let authToken = '';

export const setOrganizerSecret = (secret: string) => { organizerSecret = secret.trim(); };
export const getOrganizerSecret = () => organizerSecret;

export const setAuthToken = (token: string) => { authToken = token.trim(); };
export const getAuthToken = () => authToken;

export let serverTimeOffsetMs = 0;

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const credential = path.startsWith('/v1/games/') && organizerSecret ? organizerSecret : authToken || organizerSecret;
  const authorization = credential ? `Bearer ${credential}` : undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(problem.error || `Server request failed (${response.status})`, response.status);
  }
  if (response.headers.has('date')) {
    serverTimeOffsetMs = new Date(response.headers.get('date')!).getTime() - Date.now();
  }
  return (await response.json()) as T;
}

export const api = {
  getGame: async (gameId: string) => (await request<{ game: RemoteGame }>(`/v1/games/${encodeURIComponent(gameId.trim())}`)).game,
  createGame: async (homeTeam: string, awayTeam: string, teamId?: string) => {
    const body: any = { homeTeam, awayTeam };
    if (teamId) body.teamId = teamId;
    const result = await request<{ game: RemoteGame; organizerSecret: string }>('/v1/games', { method: 'POST', body: JSON.stringify(body) });
    setOrganizerSecret(result.organizerSecret);
    return result.game;
  },
  startGame: async (gameId: string) => (await request<{ game: RemoteGame }>(`/v1/games/${gameId}/start`, { method: 'POST' })).game,
  endGame: async (gameId: string) => (await request<{ game: RemoteGame }>(`/v1/games/${gameId}/end`, { method: 'POST' })).game,
  command: async (gameId: string, command: { kind: EventKind | 'CLOCK'; team?: TeamSide; running?: boolean; clockSeconds?: number }) =>
    (await request<{ game: RemoteGame }>(`/v1/games/${gameId}/commands`, { method: 'POST', body: JSON.stringify(command) })).game,
  mediaCapability: async (gameId: string, role: 'publisher' | 'viewer') =>
    request<MediaCapability>(`/v1/games/${gameId}/media-capability`, { method: 'POST', body: JSON.stringify({ role }) }),
  createOrganization: async (name: string) => request<{ id: string; name: string }>('/v1/organizations', { method: 'POST', body: JSON.stringify({ name }) }),
  createTeam: async (organizationId: string, name: string, logoUrl?: string, primaryColor?: string) => request<{ id: string; organizationId: string; name: string; logoUrl?: string; primaryColor?: string }>('/v1/teams', { method: 'POST', body: JSON.stringify({ organizationId, name, logoUrl, primaryColor }) }),
  updateTeam: async (teamId: string, name?: string, logoUrl?: string, primaryColor?: string) => request<{ success: true }>(`/v1/teams/${teamId}`, { method: 'PUT', body: JSON.stringify({ name, logoUrl, primaryColor }) }),

  
  // Auth & Team Methods
  requestCode: async (email: string) => request<{ success: true }>('/v1/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) }),
  verifyCode: async (email: string, code: string) => {
    const response = await fetch(`${baseUrl}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const data = await response.json() as { token?: string; error?: string };
    if (!response.ok || !data.token) throw new Error(data.error || 'Verification failed');
    return data.token;
  },
  getMe: async () => request<{ email: string }>('/v1/users/me'),
  getOrganizationsAndTeams: async () => request<{ organizations: any[]; teams: any[] }>('/v1/users/me/organizations'),
  getTeamGames: async (teamId: string) => request<{ games: any[] }>(`/v1/teams/${teamId}/games`),
  sendTelemetry: async (gameId: string, audioLevel: number, motionLevel: number) => {
    return request<void>(`/v1/games/${encodeURIComponent(gameId)}/telemetry`, {
      method: 'POST',
      body: JSON.stringify({ audioLevel, motionLevel }),
    }).catch(() => {});
  }
};
