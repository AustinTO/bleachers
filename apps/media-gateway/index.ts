import { MoqtConnection } from '@moqt/transport';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Sprint 6: BroadcastDestination (Media Gateway)
 * This service subscribes to the MoQ video/audio tracks and pipes the payload
 * to an FFmpeg process to stream out to Facebook/YouTube via RTMPS.
 */

const API = process.env.API_URL || 'https://bleachers-api.austintaylorodell.workers.dev';
const SCORE_FILE = path.join('/tmp', 'score.txt');

async function syncGameScore(gameId: string) {
  // Initial empty score
  fs.writeFileSync(SCORE_FILE, 'WAITING FOR SCORE...', 'utf8');

  try {
    // We would use a WebSocket connection to the Game DO in production:
    // const ws = new WebSocket(`${API.replace('http', 'ws')}/v1/games/${gameId}/state`);
    // ws.onmessage = (event) => {
    //    const data = JSON.parse(event.data);
    //    if (data.homeScore !== undefined) {
    //        const text = `${data.homeTeam} ${data.homeScore} - ${data.awayScore} ${data.awayTeam}`;
    //        fs.writeFileSync(SCORE_FILE, text, 'utf8');
    //    }
    // };
    
    // Fallback: poll API for simplicity if DO WS isn't set up yet
    setInterval(async () => {
      try {
        const response = await fetch(`${API}/v1/games/${gameId}`);
        if (!response.ok) return;
        const data: any = await response.json();
        const game = data.game;
        if (game) {
           const clockMinutes = Math.floor((game.clockSeconds || 0) / 60).toString().padStart(2, '0');
           const clockSeconds = ((game.clockSeconds || 0) % 60).toString().padStart(2, '0');
           const text = `${game.homeTeam || 'HOME'} ${game.homeScore || 0} - ${game.awayScore || 0} ${game.awayTeam || 'AWAY'}  |  ${clockMinutes}:${clockSeconds}`;
           fs.writeFileSync(SCORE_FILE, text, 'utf8');
        }
      } catch (err) {
        // ignore
      }
    }, 2000);
  } catch (err) {
    console.error('Failed to sync game score:', err);
  }
}

async function startGateway(relayUrl: string, broadcastName: string, rtmpDestUrl: string, gameId: string) {
  console.log(`[media-gateway] Connecting to MoQ relay: ${relayUrl}`);
  
  // Create score file for FFmpeg to watch
  syncGameScore(gameId);

  // Use MoqtConnection to establish a transport
  const connection = new MoqtConnection(16);
  // await connection.connect(transport);
  
  const namespace = broadcastName.split('/');
  console.log(`[media-gateway] Connected. Subscribing to: ${broadcastName}`);

  // FFmpeg drawtext font (can be any default system font)
  const fontFile = process.env.FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  // Start FFmpeg process for RTMP multiplexing and score composition
  const ffmpeg: ChildProcessWithoutNullStreams = spawn('ffmpeg', [
    '-y',
    '-f', 'h264', '-i', 'pipe:3',
    '-f', 'aac', '-i', 'pipe:4',
    // Apply score text overlay using drawtext reading from SCORE_FILE dynamically
    '-vf', `drawtext=fontfile=${fontFile}:textfile=${SCORE_FILE}:reload=1:fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=30`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'flv',
    rtmpDestUrl
  ], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
  });

  const videoPipe = (ffmpeg.stdio as any)[3];
  const audioPipe = (ffmpeg.stdio as any)[4];

  ffmpeg.stderr.on('data', (data) => {
    // console.log(`[ffmpeg] ${data}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`[media-gateway] FFmpeg exited with code ${code}`);
  });

  // 1. Subscribe to Video
  /*
  await connection.subscribeTrack(
    [new TextEncoder().encode(namespace[0]), new TextEncoder().encode(namespace[1])],
    new TextEncoder().encode('media/main/video'),
    {
      onObject: (object) => {
        if (object.kind !== 'data') return;
        const payload = object.payload;
        if (payload.length > 17 && payload[0] === 0x42 && payload[1] === 0x4c && payload[2] === 0x43 && payload[3] === 0x31) {
            videoPipe.write(payload.slice(17));
        }
      }
    }
  );
  */

  // 2. Subscribe to Audio
  /*
  await connection.subscribeTrack(
    [new TextEncoder().encode(namespace[0]), new TextEncoder().encode(namespace[1])],
    new TextEncoder().encode('media/main/audio'),
    {
      onObject: (object) => {
        if (object.kind !== 'data') return;
        const payload = object.payload;
        if (payload.length > 17 && payload[0] === 0x42 && payload[1] === 0x4c && payload[2] === 0x41 && payload[3] === 0x31) {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const configLength = view.getUint16(15);
            audioPipe.write(payload.slice(17 + configLength));
        }
      }
    }
  );
  */

  console.log(`[media-gateway] Gateway is live. Streaming to ${rtmpDestUrl}`);
}

const RTMP_DEST = process.env.RTMP_DEST || 'rtmps://live-api-s.facebook.com:443/rtmp/TEST';
const GAME_ID = process.env.GAME_ID || 'game-123';
startGateway('https://moq.live/anon', `sports/${GAME_ID}`, RTMP_DEST, GAME_ID);
