import '@moq/publish/element';
import '@moq/publish/ui';
import { MoqtConnection } from '@moqt/webtransport';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type EventKind = 'GOAL' | 'SAVE' | 'FOUL' | 'HIGHLIGHT';
type EventItem = { id: string; sequence: number; kind: EventKind; team?: 'home' | 'away'; gameTimeSeconds: number; createdAt?: string };
type Game = { gameId: string; homeTeam: string; awayTeam: string; status: string; homeScore: number; awayScore: number; clockSeconds: number; clockRunning: boolean; events: EventItem[] };
type Capability = { relayUrl: string; broadcastName: string; capabilityIdentity?: unknown; profile?: string; draft?: string };
type ObjectLocation = { groupId: bigint; objectId: bigint; timestampUs: number; keyframe: boolean };
type BufferedFrame = { keyframe: boolean; timestampUs: number; receivedAtMs: number; payload: Uint8Array; groupId: bigint; objectId: bigint };
type MediaState = 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'degraded';
const REWIND_US = 10_000_000;
const BUFFER_US = 15_000_000;
const EVENT_PREROLL_MS = 12_000;
const capabilityRequests = new Map<string, Promise<Capability>>();

function getCapability(gameId: string, role: 'publisher' | 'viewer') {
  const key = `${gameId}:${role}`;
  let request = capabilityRequests.get(key);
  if (!request) {
    request = fetch(`${API}/v1/games/${gameId}/media-capability`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`${role === 'publisher' ? 'Publisher' : 'Viewer'} capability is unavailable`);
      return response.json() as Promise<Capability>;
    });
    capabilityRequests.set(key, request);
    request.catch(() => capabilityRequests.delete(key));
  }
  return request;
}

function Draft16Camera({ relayUrl, broadcastName, capabilityIdentity, onRewindReady, replayActive, onReplayState, audioMuted }: { relayUrl: string; broadcastName: string; capabilityIdentity?: unknown; onRewindReady: (rewind: (event?: EventItem) => void) => void; replayActive: boolean; onReplayState: (active: boolean) => void; audioMuted: boolean }) {
  const [imageUrl, setImageUrl] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [mediaState, setMediaState] = useState<MediaState>('connecting');
  const previousUrl = useRef('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const replayCanvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<VideoDecoder | undefined>(undefined);
  const audioDecoderRef = useRef<AudioDecoder | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const audioNextTimeRef = useRef(0);
  const audioMutedRef = useRef(audioMuted);
  const replayDecoderRef = useRef<VideoDecoder | undefined>(undefined);
  const locationsRef = useRef<ObjectLocation[]>([]);
  const framesRef = useRef<BufferedFrame[]>([]);
  const historicalCloseRef = useRef<(() => void) | undefined>(undefined);
  const historicalActiveRef = useRef(false);
  const replayQueueRef = useRef<{ keyframe: boolean; timestampUs: number; payload: Uint8Array }[]>([]);
  const replayBaseRef = useRef<{ timestampUs: number; wallMs: number } | undefined>(undefined);
  const replayTimerRef = useRef<number | undefined>(undefined);
  const replayTelemetryRef = useRef<{ first?: number; last?: number; count: number }>({ count: 0 });
  const rawTimestampUsRef = useRef(0);
  const lastVideoObjectAtRef = useRef(0);
  useEffect(() => {
    const unlockAudio = () => {
      const context = audioContextRef.current;
      if (context?.state === 'suspended') void context.resume().catch(() => undefined);
    };
    window.addEventListener('pointerdown', unlockAudio, { capture: true });
    return () => window.removeEventListener('pointerdown', unlockAudio, { capture: true });
  }, []);
  useEffect(() => {
    audioMutedRef.current = audioMuted;
    const context = audioContextRef.current;
    if (!context) return;
    audioNextTimeRef.current = 0;
    if (audioMuted) void context.suspend().catch(() => undefined);
    else void context.resume().catch(() => undefined);
  }, [audioMuted]);
  useEffect(() => {
    let cancelled = false;
    let closeActive: (() => void) | undefined;
    const run = async () => {
      while (!cancelled) {
        let transport: WebTransport | undefined;
        let connection: MoqtConnection | undefined;
        try {
          setMediaState('connecting');
          transport = new WebTransport(relayUrl, { protocols: ['moqt-16'] } as WebTransportOptions);
          const activeTransport = transport;
          closeActive = () => activeTransport.close();
          void transport.closed.catch(() => undefined);
          await transport.ready;
          if (cancelled) return;
          connection = new MoqtConnection(16);
          await connection.connect(transport);
          const parts = broadcastName.split('/');
          console.info('[bleachers:moq-track]', { gameId: parts[1]?.replace(/\.hang$/, ''), role: 'viewer', relayOrigin: new URL(relayUrl).origin, capabilityIdentity, broadcastName, namespace: [parts[0] || 'sports', parts[1] || broadcastName], trackName: 'media/main/video' });
          setMediaState('waiting');
          setMediaError('Waiting for camera objects…');
          const subscription = await connection.subscribeTrack(
            [new TextEncoder().encode(parts[0] || 'sports'), new TextEncoder().encode(parts[1] || broadcastName)],
            new TextEncoder().encode('media/main/video'),
            // Use the relay's live/default filter.  Rewind is implemented by
            // the local rolling frame buffer below; draft-16 Cloudflare
            // relays may leave explicit LargestObject subscriptions pending.
            { onObject: (object) => {
              if (object.kind !== 'data' || cancelled) return;
              const expected = [66, 76, 69, 65, 67, 72, 69, 82, 83, 0, 16, 255];
              if (object.payload.length === expected.length && expected.every((byte, index) => object.payload[index] === byte)) {
                setMediaError('Native transport verified: received the 12-byte Android test object.');
                console.info('[bleachers:object-verified]', { bytes: object.payload.length, groupId: String(object.groupId), objectId: String(object.objectId) });
                return;
              }
              const rawTimestampUs = Math.max(rawTimestampUsRef.current + 1, Math.round(performance.now() * 1000));
              rawTimestampUsRef.current = rawTimestampUs;
              const h264 = decodeH264Envelope(object.payload) ?? decodeRawH264(object.payload, rawTimestampUs);
              locationsRef.current.push({ groupId: object.groupId, objectId: object.objectId, timestampUs: h264?.timestampUs ?? Date.now() * 1000, keyframe: h264?.keyframe ?? false });
              if (h264) {
                lastVideoObjectAtRef.current = Date.now();
                setMediaState('live');
                framesRef.current.push({ keyframe: h264.keyframe, timestampUs: h264.timestampUs, receivedAtMs: Date.now(), payload: h264.payload.slice(), groupId: object.groupId, objectId: object.objectId });
                const cutoff = h264.timestampUs - BUFFER_US;
                while (framesRef.current[0] && framesRef.current[0].timestampUs < cutoff) framesRef.current.shift();
                while (locationsRef.current[0] && locationsRef.current[0].timestampUs < cutoff) locationsRef.current.shift();
                if (!('VideoDecoder' in window)) { setMediaError('This browser does not support WebCodecs H.264 playback.'); return; }
                if (!decoderRef.current) {
                  const decoder = new VideoDecoder({ output: (frame) => {
                    const canvas = canvasRef.current;
                    if (canvas) {
                      // Android encodes the sensor's landscape surface; present
                      // it counter-clockwise so the browser matches portrait UI.
                      canvas.width = frame.displayWidth;
                      canvas.height = frame.displayHeight;
                      const context = canvas.getContext('2d');
                      if (context) context.drawImage(frame, 0, 0);
                    }
                    frame.close();
                  }, error: (error) => setMediaError(`H.264 decode failed: ${error.message}`) });
                  const codec = h264Codec(h264.payload);
                  if (!codec) { setMediaError('Waiting for an H.264 keyframe…'); return; }
                  decoder.configure({ codec, avc: { format: 'annexb' } } as VideoDecoderConfig);
                  decoderRef.current = decoder;
                }
                const decoder = decoderRef.current;
                if (decoder?.state === 'configured') {
                  try {
                    decoder.decode(new EncodedVideoChunk({ type: h264.keyframe ? 'key' : 'delta', timestamp: h264.timestampUs, data: h264.payload }));
                  } catch (error) {
                    console.info('[bleachers:decode-drop]', { error: error instanceof Error ? error.message : String(error), state: decoder.state });
                  }
                }
                setMediaError('LIVE H.264 · native Android encoder');
                return;
              }
              const payload = object.payload.slice().buffer as ArrayBuffer;
              const next = URL.createObjectURL(new Blob([payload], { type: 'image/jpeg' }));
              const old = previousUrl.current;
              previousUrl.current = next;
              setImageUrl(next);
              if (old) URL.revokeObjectURL(old);
            } },
          );
          console.info('[bleachers:subscribe-ok]', JSON.stringify({ trackAlias: String(subscription.trackAlias), broadcastName, trackName: 'media/main/video' }));
          void connection.subscribeTrack(
            [new TextEncoder().encode(parts[0] || 'sports'), new TextEncoder().encode(parts[1] || broadcastName)],
            new TextEncoder().encode('media/main/audio'),
            { onObject: (object) => {
              if (object.kind !== 'data' || cancelled) return;
              const aac = decodeAacEnvelope(object.payload);
              if (!aac || !('AudioDecoder' in window)) return;
              if (!audioDecoderRef.current) {
                const context = new AudioContext();
                audioContextRef.current = context;
                const decoder = new AudioDecoder({
                  output: (audio) => playAudioData(context, audio, audioNextTimeRef, audioMutedRef),
                  error: (error) => console.info('[bleachers:aac-decode-error]', { error: error.message }),
                });
                decoder.configure({ codec: 'mp4a.40.2', sampleRate: aac.sampleRate, numberOfChannels: aac.channels, description: aac.config });
                audioDecoderRef.current = decoder;
              }
              const decoder = audioDecoderRef.current;
              if (decoder?.state === 'configured') {
                try { decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: aac.timestampUs, data: aac.payload })); }
                catch (error) { console.info('[bleachers:aac-decode-drop]', { error: error instanceof Error ? error.message : String(error) }); }
              }
            } },
          ).then((audio) => console.info('[bleachers:subscribe-ok]', JSON.stringify({ trackAlias: String(audio.trackAlias), broadcastName, trackName: 'media/main/audio' }))).catch((error) => console.info('[bleachers:audio-subscribe-error]', { error: error instanceof Error ? error.message : String(error) }));
          onRewindReady((event) => {
            if (historicalActiveRef.current) { console.info('[bleachers:rewind]', { result: 'replay-active-use-live-to-return' }); return; }
            const frames = framesRef.current;
            if (!frames.length) { console.info('[bleachers:rewind]', { result: 'no-live-location-yet' }); return; }
            const latest = frames.at(-1)!;
            const eventWallMs = event?.createdAt ? Date.parse(event.createdAt) : Number.NaN;
            const eventFrame = Number.isFinite(eventWallMs)
              ? frames.reduce((closest, frame) => Math.abs(frame.receivedAtMs - eventWallMs) < Math.abs(closest.receivedAtMs - eventWallMs) ? frame : closest, latest)
              : latest;
            const targetTimestampUs = event ? eventFrame.timestampUs - EVENT_PREROLL_MS * 1000 : latest.timestampUs - REWIND_US;
            let startIndex = frames.findIndex((frame) => frame.keyframe);
            for (let index = frames.length - 1; index >= 0; index -= 1) {
              if (frames[index].keyframe && frames[index].timestampUs <= targetTimestampUs) { startIndex = index; break; }
            }
            if (startIndex < 0) { console.info('[bleachers:rewind]', { result: 'no-keyframe-in-buffer' }); return; }
            const start = frames[startIndex];
            console.info('[bleachers:rewind-request]', {
              requestedLocation: { groupId: String(start.groupId), objectId: String(start.objectId) },
              latestLocation: { groupId: String(latest.groupId), objectId: String(latest.objectId) },
              targetTimestampUs,
              requestedAgeUs: latest.timestampUs - start.timestampUs,
              observedHistoryUs: latest.timestampUs - frames[0].timestampUs,
              observedObjects: frames.length,
              start: event ? 'event-local-buffer' : 'local-buffer',
              eventId: event?.id,
              eventAgeMs: event ? latest.receivedAtMs - eventFrame.receivedAtMs : undefined,
            });
            closeDecoder(replayDecoderRef);
            replayQueueRef.current = [];
            replayBaseRef.current = undefined;
            replayTelemetryRef.current = { count: 0 };
            if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
            historicalActiveRef.current = true;
            console.info('[bleachers:rewind-first-historical]', { location: { groupId: String(start.groupId), objectId: String(start.objectId) }, keyframe: true, decode: 'keyframe-available', firstAgeUs: latest.timestampUs - start.timestampUs });
            for (const frame of frames.slice(startIndex)) {
              enqueueReplayFrame(frame, replayDecoderRef, replayQueueRef, replayBaseRef, replayTimerRef, replayCanvasRef, replayTelemetryRef, onReplayState);
            }
          });
          if (cancelled) await subscription.unsubscribe();
          else {
            await transport.closed;
            if (!cancelled) throw new Error('Relay session closed; reconnecting…');
          }
        } catch (cause) {
          if (cancelled) return;
          setMediaState('reconnecting');
          console.info('[bleachers:moq-error]', JSON.stringify({ message: cause instanceof Error ? cause.message : String(cause), relayOrigin: (() => { try { return new URL(relayUrl).origin; } catch { return relayUrl; } })(), broadcastName }));
          setMediaError(cause instanceof Error ? cause.message : 'Draft-16 media connection failed');
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } finally {
          await connection?.close().catch(() => undefined);
          transport?.close();
        }
      }
    };
    void run();
    const healthTimer = window.setInterval(() => {
      if (cancelled || !lastVideoObjectAtRef.current) return;
      if (Date.now() - lastVideoObjectAtRef.current > 2_500) setMediaState('degraded');
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(healthTimer);
      closeActive?.();
      historicalCloseRef.current?.();
      if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
      closeDecoder(decoderRef);
      closeDecoder(replayDecoderRef);
      closeAudioDecoder(audioDecoderRef);
      audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = undefined;
      if (previousUrl.current) URL.revokeObjectURL(previousUrl.current);
    };
  }, [relayUrl, broadcastName, onRewindReady, onReplayState]);
  useEffect(() => { if (!replayActive) { historicalCloseRef.current?.(); historicalCloseRef.current = undefined; historicalActiveRef.current = false; closeDecoder(replayDecoderRef); replayQueueRef.current = []; replayBaseRef.current = undefined; replayTelemetryRef.current = { count: 0 }; if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current); } }, [replayActive]);
  return <div className="camera-stage"><span className={`media-health media-health-${mediaState}`}><span className="media-health-dot" />{mediaState === 'live' ? 'LIVE' : mediaState === 'degraded' ? 'VIDEO DELAYED' : mediaState === 'reconnecting' ? 'RECONNECTING' : mediaState === 'waiting' ? 'WAITING FOR CAMERA' : 'CONNECTING'}</span>{imageUrl ? <img src={imageUrl} alt="Live camera" /> : <><canvas ref={canvasRef} style={{ display: !replayActive && mediaError.startsWith('LIVE H.264') ? 'block' : 'none', width: '100%', height: '100%', objectFit: 'contain' }} /><canvas ref={replayCanvasRef} style={{ display: replayActive ? 'block' : 'none', width: '100%', height: '100%', objectFit: 'contain' }} />{(!mediaError.startsWith('LIVE H.264') && !replayActive) ? <div className="video-placeholder"><div className="play-orb">▶</div><p>{mediaError || 'Connecting to draft-16 camera…'}</p></div> : null}</>}</div>;
}

function closeDecoder(ref: { current: VideoDecoder | undefined }) {
  const decoder = ref.current;
  ref.current = undefined;
  if (!decoder || decoder.state === 'closed') return;
  try { decoder.close(); } catch (error) {
    console.info('[bleachers:decoder-close]', { error: error instanceof Error ? error.message : String(error), state: decoder.state });
  }
}

function closeAudioDecoder(ref: { current: AudioDecoder | undefined }) {
  const decoder = ref.current;
  ref.current = undefined;
  if (!decoder || decoder.state === 'closed') return;
  try { decoder.close(); } catch { /* cleanup may race decoder teardown */ }
}

function playAudioData(context: AudioContext, audio: AudioData, nextTimeRef: { current: number }, mutedRef: { current: boolean }) {
  try {
    // Browsers prohibit sound until the viewer interacts with the page. Drop
    // pre-gesture audio instead of queuing stale commentary or logging an
    // autoplay exception; the next AAC frame plays after any click/tap.
    if (mutedRef.current || context.state !== 'running') { nextTimeRef.current = 0; return; }
    const buffer = context.createBuffer(audio.numberOfChannels, audio.numberOfFrames, audio.sampleRate);
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const samples = new Float32Array(audio.numberOfFrames);
      audio.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
      buffer.copyToChannel(samples, channel);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, nextTimeRef.current);
    source.start(startAt);
    nextTimeRef.current = startAt + buffer.duration;
  } finally { audio.close(); }
}

function enqueueReplayFrame(
  frame: { keyframe: boolean; timestampUs: number; payload: Uint8Array },
  decoderRef: { current: VideoDecoder | undefined },
  queueRef: { current: { keyframe: boolean; timestampUs: number; payload: Uint8Array }[] },
  baseRef: { current: { timestampUs: number; wallMs: number } | undefined },
  timerRef: { current: number | undefined },
  canvasRef: { current: HTMLCanvasElement | null },
  telemetryRef: { current: { first?: number; last?: number; count: number } },
  onReplayState: (active: boolean) => void,
) {
  if (!decoderRef.current && !frame.keyframe) return;
  telemetryRef.current.first ??= frame.timestampUs;
  telemetryRef.current.last = frame.timestampUs;
  telemetryRef.current.count += 1;
  if (telemetryRef.current.count % 30 === 0) console.info('[bleachers:rewind-progress]', { frames: telemetryRef.current.count, servedDurationUs: (telemetryRef.current.last ?? 0) - (telemetryRef.current.first ?? 0) });
  if (!decoderRef.current) {
    const codec = h264Codec(frame.payload);
    if (!codec) return;
    const decoder = new VideoDecoder({ output: (output) => {
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = output.displayWidth; canvas.height = output.displayHeight; canvas.getContext('2d')?.drawImage(output, 0, 0); }
      output.close();
    }, error: (decodeError) => console.info('[bleachers:rewind-decode-error]', { error: decodeError.message }) });
    decoder.configure({ codec, avc: { format: 'annexb' } } as VideoDecoderConfig);
    decoderRef.current = decoder;
    onReplayState(true);
  }
  queueRef.current.push(frame);
  if (!baseRef.current) baseRef.current = { timestampUs: frame.timestampUs, wallMs: performance.now() };
  if (timerRef.current === undefined) drainReplayQueue(decoderRef, queueRef, baseRef, timerRef, onReplayState);
}

function drainReplayQueue(
  decoderRef: { current: VideoDecoder | undefined },
  queueRef: { current: { keyframe: boolean; timestampUs: number; payload: Uint8Array }[] },
  baseRef: { current: { timestampUs: number; wallMs: number } | undefined },
  timerRef: { current: number | undefined },
  onReplayState: (active: boolean) => void,
) {
  const frame = queueRef.current.shift();
  const base = baseRef.current;
  if (!frame || !base || !decoderRef.current) {
    timerRef.current = undefined;
    if (!frame && base) {
      console.info('[bleachers:rewind-complete]', { frames: queueRef.current.length, result: 'return-to-live' });
      onReplayState(false);
    }
    return;
  }
  const dueMs = base.wallMs + (frame.timestampUs - base.timestampUs) / 1000;
  timerRef.current = window.setTimeout(() => {
    timerRef.current = undefined;
    const decoder = decoderRef.current;
    if (decoder?.state === 'configured') {
      try {
        decoder.decode(new EncodedVideoChunk({ type: frame.keyframe ? 'key' : 'delta', timestamp: frame.timestampUs, data: frame.payload }));
      } catch (error) {
        console.info('[bleachers:rewind-decode-drop]', { error: error instanceof Error ? error.message : String(error), state: decoder.state });
      }
    }
    drainReplayQueue(decoderRef, queueRef, baseRef, timerRef, onReplayState);
  }, Math.max(0, dueMs - performance.now()));
}

function decodeH264Envelope(bytes: Uint8Array) {
  if (!hasH264Envelope(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { keyframe: view.getUint8(4) === 1, timestampUs: Number(view.getBigUint64(5)), payload: bytes.slice(17) };
}

function decodeAacEnvelope(bytes: Uint8Array) {
  if (bytes.length < 17 || bytes[0] !== 0x42 || bytes[1] !== 0x4c || bytes[2] !== 0x41 || bytes[3] !== 0x31) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timestampUs = Number(view.getBigUint64(4));
  const sampleRate = view.getUint16(12);
  const channels = view.getUint8(14);
  const configLength = view.getUint16(15);
  if (bytes.length < 17 + configLength) return undefined;
  return { timestampUs, sampleRate, channels, config: bytes.slice(17, 17 + configLength), payload: bytes.slice(17 + configLength) };
}

function hasH264Envelope(bytes: Uint8Array) {
  return bytes.length >= 17 && bytes[0] === 0x42 && bytes[1] === 0x4c && bytes[2] === 0x43 && bytes[3] === 0x31;
}

// Older test APKs sent Annex-B access units directly.  Accept those objects
// too so a viewer upgrade does not require the broadcaster to be rebuilt.
function decodeRawH264(bytes: Uint8Array, timestampUs: number) {
  let annexB = false;
  let keyframe = false;
  for (let index = 0; index + 4 < bytes.length; index += 1) {
    const start = bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1
      ? index + 3
      : bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0 && bytes[index + 3] === 1
        ? index + 4
        : -1;
    if (start < 0 || start >= bytes.length) continue;
    annexB = true;
    const nalType = bytes[start] & 0x1f;
    keyframe ||= nalType === 5 || nalType === 7;
  }
  return annexB ? { keyframe, timestampUs, payload: bytes } : undefined;
}

function h264Codec(annexB: Uint8Array) {
  for (let i = 0; i + 7 < annexB.length; i++) {
    const offset = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1 ? i + 4 : -1;
    if (offset >= 0 && (annexB[offset] & 0x1f) === 7) return `avc1.${[annexB[offset + 1], annexB[offset + 2], annexB[offset + 3]].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }
  return undefined;
}

const API = import.meta.env.VITE_API_URL ?? 'https://bleachers-api.austintaylorodell.workers.dev';
const params = new URLSearchParams(location.search);

function getViewerSessionId() {
  const key = 'bleachers.viewer-session';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch { return crypto.randomUUID(); }
}

function OrganizerSetup() {
  const [homeTeam, setHomeTeam] = useState('Tigers');
  const [awayTeam, setAwayTeam] = useState('Eagles');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdGame, setCreatedGame] = useState<string>();
  useEffect(() => {
    if (!createdGame) return;
    const timer = window.setTimeout(() => { window.location.href = `/?game=${createdGame.slice(0, 6)}`; }, 1_800);
    return () => window.clearTimeout(timer);
  }, [createdGame]);
  const createGame = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API}/v1/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeTeam, awayTeam }) });
      if (!response.ok) throw new Error('Game could not be created');
      const payload = await response.json() as { game: { gameId: string } };
      setCreatedGame(payload.game.gameId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Game could not be created'); setBusy(false); }
  };
  return <main className="shell setup-shell"><header className="topbar"><span className="mark">BLEACHERS</span><span className="privacy">PRIVATE SETUP</span></header><section className="setup-card"><span className="tag">SOCCER GAME</span><h1>Create a private game</h1><p className="muted">Create the Game Core session first, then enter its short code in the broadcaster app so video and scoring attach to this game.</p>{createdGame ? <div className="created-game"><strong>{createdGame.slice(0, 6)}</strong><code>{location.origin}/?game={createdGame.slice(0, 6)}</code><button className="live-button" onClick={() => { window.location.href = `/?game=${createdGame.slice(0, 6)}`; }}>OPEN VIEWER</button><p className="muted">Opening the game screen… Broadcaster code: <b>{createdGame.slice(0, 6)}</b></p></div> : <form onSubmit={createGame}><label>Home team<input value={homeTeam} onChange={(event) => setHomeTeam(event.target.value)} required /></label><label>Away team<input value={awayTeam} onChange={(event) => setAwayTeam(event.target.value)} required /></label>{error ? <p className="error">{error}</p> : null}<button className="live-button" disabled={busy}>{busy ? 'CREATING…' : 'CREATE PRIVATE GAME'}</button></form>}</section></main>;
}

function App() {
  const gameId = params.get('game') ?? '';
  const isPublisher = location.pathname === '/publish' || params.get('mode') === 'publish';
  const [game, setGame] = useState<Game>();
  const [canonicalGameId, setCanonicalGameId] = useState('');
  const [error, setError] = useState('');
  const [replaying, setReplaying] = useState<EventItem>();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [viewerSessionId] = useState(getViewerSessionId);
  const configuredRelayUrl = params.get('relay') ?? '';
  const [relayUrl, setRelayUrl] = useState(configuredRelayUrl && (configuredRelayUrl.startsWith('http://') || configuredRelayUrl.startsWith('https://')) ? configuredRelayUrl : configuredRelayUrl ? `https://${configuredRelayUrl}` : '');
  const [capabilityIdentity, setCapabilityIdentity] = useState<unknown>();
  const [rewind, setRewind] = useState<((event?: EventItem) => void) | undefined>();
  const [replayActive, setReplayActive] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const registerRewind = useCallback((next: (event?: EventItem) => void) => setRewind(() => next), []);
  const handleReplayState = useCallback((active: boolean) => {
    setReplayActive(active);
    if (!active) setReplaying(undefined);
  }, []);
  // Short codes are accepted by the API, but media namespaces use the
  // canonical UUID returned in the game record.
  const [broadcastName, setBroadcastName] = useState(params.get('name') ?? '');

  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${API}/v1/games/${gameId}`);
        if (!response.ok) throw new Error('Game not found');
        const payload = await response.json() as { game: Game };
        if (!cancelled) { setGame(payload.game); setCanonicalGameId(payload.game.gameId); setError(''); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load game'); }
    };
    void load();
    const timer = window.setInterval(load, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [gameId]);

  useEffect(() => {
    // Resolve a short link through the game record first.  Media capability
    // and relay namespace must always use the canonical UUID.
    const capabilityGameId = canonicalGameId;
    if (!capabilityGameId || configuredRelayUrl) return;
    void getCapability(capabilityGameId, isPublisher ? 'publisher' : 'viewer').then((capability) => {
      setRelayUrl(capability.relayUrl);
      setBroadcastName(capability.broadcastName);
      setCapabilityIdentity(capability.capabilityIdentity);
      console.info('[bleachers:capability]', { gameId: capabilityGameId, role: isPublisher ? 'publisher' : 'viewer', relayOrigin: new URL(capability.relayUrl).origin, capabilityIdentity: capability.capabilityIdentity, broadcastName: capability.broadcastName, namespace: capability.broadcastName.split('/'), trackName: 'media/main/video' });
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Media capability is unavailable'));
  }, [gameId, canonicalGameId, configuredRelayUrl, isPublisher]);

  const clock = useMemo(() => {
    const seconds = game?.clockSeconds ?? 0;
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }, [game?.clockSeconds]);

  const saveMoment = useCallback(async () => {
    if (!game) return;
    const gameTimeSeconds = Math.max(0, Math.floor(game.clockSeconds));
    const saveKey = `live:${Math.floor(gameTimeSeconds / 5) * 5}`;
    try {
      const response = await fetch(`${API}/v1/games/${gameId}/moments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameTimeSeconds, viewerSessionId, eventId: saveKey }),
      });
      if (!response.ok) throw new Error('Moment could not be saved');
      setSaved((current) => new Set(current).add(saveKey));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Moment could not be saved');
    }
  }, [game, gameId, viewerSessionId]);

  if (!gameId && params.get('mode') === 'setup') return <OrganizerSetup />;
  if (!gameId) return <main className="shell empty"><span className="mark">BLEACHERS</span><h1>Private game link required.</h1><p>Open a link containing <code>?game=&lt;gameId&gt;</code> or use <code>?mode=setup</code>.</p></main>;

  return <main className="shell">
    <header className="topbar"><div><span className="mark">BLEACHERS</span><span className="live-label">{isPublisher ? 'PUBLISHER' : game?.status === 'live' ? 'LIVE' : game?.status === 'ended' ? 'POSTGAME' : 'WAITING FOR GAME'}</span></div><span className="privacy">PRIVATE GAME</span></header>
    {error ? <section className="error">{error}</section> : null}
    <section className="stage">
      {game?.status === 'ended' ? <div className="video-placeholder"><div className="play-orb">✓</div><p>Game ended · timeline and saved moments remain available.</p></div> : relayUrl && broadcastName ? isPublisher ? <moq-publish-ui><moq-publish url={relayUrl} name={broadcastName} source="camera"><video muted autoPlay playsInline /></moq-publish></moq-publish-ui> : <Draft16Camera relayUrl={relayUrl} broadcastName={broadcastName} capabilityIdentity={capabilityIdentity} onRewindReady={registerRewind} replayActive={replayActive} onReplayState={handleReplayState} audioMuted={audioMuted} /> : <div className="video-placeholder"><div className="play-orb">▶</div><p>{isPublisher ? 'Requesting camera publishing capability…' : 'Requesting live viewing capability…'}</p></div>}
    </section>
    <section className="scoreboard"><div><span>{game?.homeTeam ?? 'HOME'}</span><strong>{game?.homeScore ?? '—'}</strong></div><div className="clock"><small>1ST HALF</small><strong>{clock}</strong></div><div><span>{game?.awayTeam ?? 'AWAY'}</span><strong>{game?.awayScore ?? '—'}</strong></div></section>
    {!isPublisher ? <section className="actions"><button className="live-button" onClick={() => { setReplaying(undefined); setReplayActive(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>● LIVE</button><button onClick={() => { rewind?.(); setReplaying(game?.events[0]); }}>↶ −10 SEC</button><button onClick={() => void saveMoment()}>☆ SAVE MOMENT</button><button className={audioMuted ? 'muted-button' : ''} onClick={() => setAudioMuted((muted) => !muted)}>{audioMuted ? '🔇 UNMUTE' : '🔊 MUTE'}</button></section> : null}
    {replaying ? <section className="replay-card"><div><span className="tag">REPLAY</span><h2>{replaying.kind} · {formatClock(replaying.gameTimeSeconds)}</h2><p>Replay is selected while the live subscription stays active.</p></div><button onClick={() => setReplaying(undefined)}>RETURN TO LIVE</button></section> : null}
    <section className="timeline"><div className="timeline-head"><h2>Game events</h2><span>{saved.size} saved</span></div>{game?.events.length ? game.events.map((event) => <button className="event" key={event.id} onClick={() => { setReplaying(event); rewind?.(event); }}><span className="event-icon">{event.kind === 'GOAL' ? '⚽' : event.kind === 'HIGHLIGHT' ? '★' : '•'}</span><span><b>{event.kind}{event.team ? ` · ${event.team === 'home' ? game.homeTeam : game.awayTeam}` : ''}</b><small>{formatClock(event.gameTimeSeconds)}</small></span><span>›</span></button>) : <p className="muted">No events yet. Goals, saves, and highlights will appear here.</p>}</section>
  </main>;
}

function formatClock(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }

// MoQ owns long-lived WebTransport state.  React StrictMode's development
// double-mount leaves an in-flight SUBSCRIBE behind on some browser builds,
// causing duplicate reconnect loops, so mount the transport owner once.
createRoot(document.getElementById('root')!).render(<App />);
