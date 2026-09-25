import { ExternalProvider, NormalizedGame, NormalizedTeam } from './index';

export class BandProvider implements ExternalProvider {
  id = 'band';

  /**
   * Fetch teams/bands available to the authorized user.
   */
  async fetchTeams(context: { accessToken: string }): Promise<NormalizedTeam[]> {
    // The Band API endpoint to list bands the user has joined
    const url = 'https://openapi.band.us/v2.1/bands';
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${context.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch BAND teams: ${response.statusText}`);
    }

    const data = await response.json() as any;
    const bands = data.result_data?.bands || [];

    return bands.map((band: any) => ({
      externalId: band.band_key,
      name: band.name,
      logoUrl: band.cover
    }));
  }

  /**
   * Fetch the game schedule from a specific BAND's calendar.
   */
  async fetchSchedule(context: { accessToken: string }, bandKey: string): Promise<NormalizedGame[]> {
    // Currently, the BAND public API does not provide an endpoint to list calendar events
    // directly unless using specific enterprise/partner APIs.
    // For this MVP, we will return an empty array or mocked data if the endpoint isn't available.
    // Let's assume we have an endpoint like `/v2/band/events` for the sake of the interface,
    // though in reality we might need to rely on users manually adding games or using iCal sync.
    
    // We'll mock it or just return empty for now, logging a warning.
    console.warn('BAND API does not currently expose a public calendar events endpoint.');
    return [];
  }
}
