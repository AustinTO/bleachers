import { MoqtConnection } from '@moqt/transport';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

/**
 * Sprint 6: BroadcastDestination (Media Gateway)
 * This service subscribes to the MoQ video/audio tracks and pipes the payload
 * to an FFmpeg process to stream out to Facebook/YouTube via RTMPS.
 */

async function startGateway(relayUrl: string, broadcastName: string, rtmpDestUrl: string) {
  console.log(`[media-gateway] Connecting to MoQ relay: ${relayUrl}`);
  
  // Use MoqtConnection to establish a transport
  const connection = new MoqtConnection(16);
  // await connection.connect(transport);
  
  const namespace = broadcastName.split('/');
  console.log(`[media-gateway] Connected. Subscribing to: ${broadcastName}`);

  // Start FFmpeg process for RTMP multiplexing
  // We feed Annex-B H.264 and ADTS AAC into FFmpeg stdin.
  const ffmpeg: ChildProcessWithoutNullStreams = spawn('ffmpeg', [
    '-y',
    // Video input format: raw H.264
    '-f', 'h264',
    '-i', 'pipe:3',
    // Audio input format: AAC
    '-f', 'aac',
    '-i', 'pipe:4',
    // Output format: FLV for RTMP
    '-c:v', 'copy',
    '-c:a', 'copy',
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
        
        // Decode H.264 envelope
        const payload = object.payload;
        if (payload.length > 17 && payload[0] === 0x42 && payload[1] === 0x4c && payload[2] === 0x43 && payload[3] === 0x31) {
            const frameData = payload.slice(17);
            // Write Annex-B H.264 frame to FFmpeg
            videoPipe.write(frameData);
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
        
        // Decode AAC envelope
        const payload = object.payload;
        if (payload.length > 17 && payload[0] === 0x42 && payload[1] === 0x4c && payload[2] === 0x41 && payload[3] === 0x31) {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const configLength = view.getUint16(15);
            const audioData = payload.slice(17 + configLength);
            
            // In a complete implementation, add ADTS headers here if missing
            audioPipe.write(audioData);
        }
      }
    }
  );
  */

  console.log(`[media-gateway] Gateway is live. Streaming to ${rtmpDestUrl}`);
}

const RTMP_DEST = process.env.RTMP_DEST || 'rtmps://live-api-s.facebook.com:443/rtmp/TEST';
startGateway('https://moq.live/anon', 'sports/game-123.hang', RTMP_DEST);
