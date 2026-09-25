import { Env } from './index';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// Cloudflare Workers do not have native WebCodecs. 
// We polyfill the minimal surface area mp4-muxer needs.
class EncodedVideoChunkPolyfill {
  type: 'key' | 'delta';
  timestamp: number;
  byteLength: number;
  data: Uint8Array;
  constructor(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
    this.byteLength = init.data.byteLength;
  }
  copyTo(destination: BufferSource) {
    if (destination instanceof ArrayBuffer) {
      new Uint8Array(destination).set(this.data);
    } else {
      new Uint8Array((destination as ArrayBufferView).buffer, (destination as ArrayBufferView).byteOffset, (destination as ArrayBufferView).byteLength).set(this.data);
    }
  }
}

class EncodedAudioChunkPolyfill {
  type: 'key' | 'delta';
  timestamp: number;
  byteLength: number;
  data: Uint8Array;
  constructor(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
    this.byteLength = init.data.byteLength;
  }
  copyTo(destination: BufferSource) {
    if (destination instanceof ArrayBuffer) {
      new Uint8Array(destination).set(this.data);
    } else {
      new Uint8Array((destination as ArrayBufferView).buffer, (destination as ArrayBufferView).byteOffset, (destination as ArrayBufferView).byteLength).set(this.data);
    }
  }
}

function hasH264Envelope(bytes: Uint8Array) {
  return bytes[0] === 0x48 && bytes[1] === 0x32 && bytes[2] === 0x36 && bytes[3] === 0x34;
}

export async function hlsPlaylistRoute(request: Request, env: Env, gameId: string) {
  const records = await env.DB.prepare('SELECT id, start_ms, end_ms FROM media_segments WHERE game_id = ? ORDER BY start_ms ASC')
    .bind(gameId)
    .all<{ id: string; start_ms: number; end_ms: number }>();
    
  let m3u8 = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n`;
  
  for (const row of records.results) {
    const durationSec = ((row.end_ms - row.start_ms) / 1000).toFixed(3);
    m3u8 += `#EXTINF:${durationSec},\n`;
    m3u8 += `/v1/games/${gameId}/hls/segment/${row.id}.mp4\n`;
  }
  
  const game = await env.DB.prepare('SELECT status FROM games WHERE id = ?').bind(gameId).first<{ status: string }>();
  if (game?.status === 'ended') {
    m3u8 += `#EXT-X-ENDLIST\n`;
  }
  
  return new Response(m3u8, {
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

export async function hlsSegmentRoute(request: Request, env: Env, gameId: string, segmentId: string) {
  const segmentIdWithoutExt = segmentId.replace(/\.mp4$/, '');
  const row = await env.DB.prepare('SELECT r2_key FROM media_segments WHERE id = ? AND game_id = ?')
    .bind(segmentIdWithoutExt, gameId)
    .first<{ r2_key: string }>();
    
  if (!row) {
    return new Response('Segment not found', { status: 404 });
  }
  
  const object = await env.MEDIA.get(row.r2_key);
  if (!object) {
    return new Response('Media missing', { status: 404 });
  }
  
  const arrayBuffer = await object.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: 1280, height: 720 },
    audio: { codec: 'aac', numberOfChannels: 1, sampleRate: 48000 },
    firstTimestampBehavior: 'offset',
    fastStart: 'in-memory'
  });
  
  let videoAdded = false;
  
  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset);
    offset += 4;
    if (length < 17 || offset + length > bytes.length) break; // Incomplete or invalid segment
    
    const envelope = bytes.subarray(offset, offset + length);
    offset += length;
    
    const isVideo = hasH264Envelope(envelope);
    const isAudio = !isVideo && envelope[0] === 0x42 && envelope[1] === 0x4c && envelope[2] === 0x41 && envelope[3] === 0x31;
    
    if (isVideo) {
      // Decode H.264 envelope: 4 bytes magic, 8 bytes timestampUs, 1 byte keyframe, 4 bytes width, 4 bytes height, then payload
      const timestampView = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
      const timestampUs = Number(timestampView.getBigInt64(4, false));
      const keyframe = envelope[12] !== 0;
      // width: timestampView.getUint32(13, false)
      // height: timestampView.getUint32(17, false)
      const payload = envelope.subarray(21);
      
      const chunk = new EncodedVideoChunkPolyfill({ type: keyframe ? 'key' : 'delta', timestamp: timestampUs, data: payload }) as any;
      muxer.addVideoChunk(chunk);
      videoAdded = true;
    } else if (isAudio) {
      // Decode AAC envelope: 4 bytes magic, 8 bytes timestampUs, 2 bytes sampleRate, 1 byte channels, 2 bytes configLength, then config, then payload
      const timestampView = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
      const timestampUs = Number(timestampView.getBigInt64(4, false));
      // const sampleRate = timestampView.getUint16(12, false);
      // const channels = envelope[14];
      const configLength = timestampView.getUint16(15, false);
      const payload = envelope.subarray(17 + configLength);
      
      const chunk = new EncodedAudioChunkPolyfill({ type: 'key', timestamp: timestampUs, data: payload }) as any;
      muxer.addAudioChunk(chunk);
    }
  }
  
  if (!videoAdded) {
    return new Response('No video in segment', { status: 404 });
  }
  
  muxer.finalize();
  const buffer = muxer.target.buffer;
  
  return new Response(buffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000'
    }
  });
}
