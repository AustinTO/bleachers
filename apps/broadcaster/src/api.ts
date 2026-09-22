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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`Server request failed (${response.status})`);
  return (await response.json()) as T;
}

export const api = {
  getGame: async (gameId: string) => (await request<{ game: RemoteGame }>(`/v1/games/${encodeURIComponent(gameId.trim())}`)).game,
  createGame: async (homeTeam: string, awayTeam: string) => (await request<{ game: RemoteGame }>('/v1/games', {
    method: 'POST', body: JSON.stringify({ homeTeam, awayTeam }),
  })).game,
  startGame: async (gameId: string) => (await request<{ game: RemoteGame }>(`/v1/games/${gameId}/start`, { method: 'POST' })).game,
  endGame: async (gameId: string) => (await request<{ game: RemoteGame }>(`/v1/games/${gameId}/end`, { method: 'POST' })).game,
  command: async (gameId: string, command: { kind: EventKind | 'CLOCK'; team?: TeamSide; running?: boolean; clockSeconds?: number }) =>
    (await request<{ game: RemoteGame }>(`/v1/games/${gameId}/commands`, { method: 'POST', body: JSON.stringify(command) })).game,
  mediaCapability: async (gameId: string, role: 'publisher' | 'viewer') =>
    request<MediaCapability>(`/v1/games/${gameId}/media-capability`, { method: 'POST', body: JSON.stringify({ role }) }),
};
