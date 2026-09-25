export interface NormalizedTeam {
  externalId: string;
  name: string;
  logoUrl?: string;
}

export interface NormalizedGame {
  externalId: string;
  seasonId?: string;
  homeTeamExternalId: string;
  awayTeamExternalId: string;
  homeTeamName: string;
  awayTeamName: string;
  startTime: Date;
  location?: string;
}

export interface ExternalProvider {
  /** The unique identifier for this provider (e.g., 'band', 'se_tourney'). */
  id: string;

  /** Fetch teams available to the authorized user/organization. */
  fetchTeams(context: any): Promise<NormalizedTeam[]>;

  /** Fetch the game schedule for a specific team or organization. */
  fetchSchedule(context: any, teamExternalId: string): Promise<NormalizedGame[]>;
}
export * from "./se_tourney";
export * from "./band";
