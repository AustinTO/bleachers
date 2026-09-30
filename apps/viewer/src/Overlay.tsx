import { Game } from './main';

export function Overlay({ game }: { game: Game | undefined }) {
  if (!game) return null;

  const homeDetails = game.homeTeamDetails;
  const awayDetails = game.awayTeamDetails;

  const formatClock = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{
      position: 'absolute',
      top: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(8px)',
      borderRadius: 12,
      padding: '8px 16px',
      color: 'white',
      fontFamily: 'system-ui, sans-serif',
      fontSize: 24,
      fontWeight: 'bold',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      pointerEvents: 'none',
      zIndex: 10,
    }}>
      {/* Away Team */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {awayDetails?.logoUrl && <img src={awayDetails.logoUrl} style={{ width: 32, height: 32, objectFit: 'contain' }} />}
        <span style={{ color: awayDetails?.primaryColor || 'white', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
          {game.awayTeam}
        </span>
        <span style={{ fontSize: 32, marginLeft: 8 }}>{game.awayScore}</span>
      </div>

      {/* Clock & Quarter/Period (Placeholder for period) */}
      <div style={{
        margin: '0 24px',
        padding: '4px 16px',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
        <span style={{ color: game.clockRunning ? '#fff' : '#aaa', fontVariantNumeric: 'tabular-nums' }}>
          {formatClock(game.clockSeconds)}
        </span>
      </div>

      {/* Home Team */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 32, marginRight: 8 }}>{game.homeScore}</span>
        <span style={{ color: homeDetails?.primaryColor || 'white', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
          {game.homeTeam}
        </span>
        {homeDetails?.logoUrl && <img src={homeDetails.logoUrl} style={{ width: 32, height: 32, objectFit: 'contain' }} />}
      </div>
    </div>
  );
}
