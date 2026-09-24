import '@moq/publish/element';
import '@moq/publish/ui';
import { MoqtConnection } from '@moqt/webtransport';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import './styles.css';

type EventKind = 'GOAL' | 'SAVE' | 'FOUL' | 'HIGHLIGHT' | 'GOAL_CORRECTION';
type EventItem = { id: string; sequence: number; kind: EventKind; team?: 'home' | 'away'; gameTimeSeconds: number; createdAt?: string };
type SavedMoment = { id: string; event_id: string | null; game_time_seconds: number; created_at: string; media_at_ms: number; media_ready: number };
type Game = { gameId: string; homeTeam: string; awayTeam: string; createdAt?: string; status: string; homeScore: number; awayScore: number; clockSeconds: number; clockRunning: boolean; events: EventItem[] };
type Capability = { relayUrl: string; broadcastName: string; expires?: string; capabilityIdentity?: unknown; profile?: string; draft?: string };
type ObjectLocation = { groupId: bigint; objectId: bigint; timestampUs: number; keyframe: boolean };
type BufferedFrame = { keyframe: boolean; timestampUs: number; receivedAtMs: number; payload: Uint8Array; groupId: bigint; objectId: bigint };
type MediaState = 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'degraded';
const REWIND_US = 10_000_000;
const BUFFER_US = 180_000_000;
const MAX_BUFFER_BYTES = 48 * 1024 * 1024;
const EVENT_PREROLL_MS = 12_000;
const capabilityRequests = new Map<string, Promise<Capability>>();

function getCapability(gameId: string, role: 'publisher' | 'viewer', organizerSecret?: string) {
  const key = `${gameId}:${role}:${organizerSecret ?? ''}`;
  let request = capabilityRequests.get(key);
  if (!request) {
    request = fetch(`${API}/v1/games/${gameId}/media-capability`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(organizerSecret ? { authorization: `Bearer ${organizerSecret}` } : {}) }, body: JSON.stringify({ role }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`${role === 'publisher' ? 'Publisher' : 'Viewer'} capability is unavailable`);
      return response.json() as Promise<Capability>;
    });
    capabilityRequests.set(key, request);
    void request.then(() => capabilityRequests.delete(key), () => capabilityRequests.delete(key));
  }
  return request;
}

function Draft16Camera({ relayUrl, broadcastName, capabilityIdentity, onRewindReady, replayActive, onReplayState, audioMuted }: { relayUrl: string; broadcastName: string; capabilityIdentity?: unknown; onRewindReady: (rewind: (event?: EventItem) => boolean) => void; replayActive: boolean; onReplayState: (active: boolean) => void; audioMuted: boolean }) {
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
  const bufferBytesRef = useRef(0);
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
                const payload = h264.payload.slice();
                framesRef.current.push({ keyframe: h264.keyframe, timestampUs: h264.timestampUs, receivedAtMs: Date.now(), payload, groupId: object.groupId, objectId: object.objectId });
                bufferBytesRef.current += payload.byteLength;
                const cutoff = h264.timestampUs - BUFFER_US;
                while (framesRef.current[0] && (framesRef.current[0].timestampUs < cutoff || bufferBytesRef.current > MAX_BUFFER_BYTES)) {
                  bufferBytesRef.current -= framesRef.current.shift()!.payload.byteLength;
                }
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
            if (historicalActiveRef.current) { console.info('[bleachers:rewind]', { result: 'replay-active-use-live-to-return' }); return false; }
            const frames = framesRef.current;
            if (!frames.length) { console.info('[bleachers:rewind]', { result: 'no-live-location-yet' }); return false; }
            const latest = frames.at(-1)!;
            const eventWallMs = event?.createdAt ? Date.parse(event.createdAt) : Number.NaN;
            if (event && (!Number.isFinite(eventWallMs) || eventWallMs < frames[0].receivedAtMs - 5_000 || eventWallMs > latest.receivedAtMs + 5_000)) {
              console.info('[bleachers:rewind]', { result: 'event-outside-buffer', eventId: event.id });
              return false;
            }
            const eventFrame = Number.isFinite(eventWallMs)
              ? frames.reduce((closest, frame) => Math.abs(frame.receivedAtMs - eventWallMs) < Math.abs(closest.receivedAtMs - eventWallMs) ? frame : closest, latest)
              : latest;
            const targetTimestampUs = event ? eventFrame.timestampUs - EVENT_PREROLL_MS * 1000 : latest.timestampUs - REWIND_US;
            let startIndex = frames.findIndex((frame) => frame.keyframe);
            for (let index = frames.length - 1; index >= 0; index -= 1) {
              if (frames[index].keyframe && frames[index].timestampUs <= targetTimestampUs) { startIndex = index; break; }
            }
            if (startIndex < 0) { console.info('[bleachers:rewind]', { result: 'no-keyframe-in-buffer' }); return false; }
            const start = frames[startIndex];
            if (!h264Codec(start.payload)) { console.info('[bleachers:rewind]', { result: 'keyframe-missing-codec' }); return false; }
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
            return true;
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

type ArchiveSegment = { id: string; startMs: number; endMs: number; url: string };

function unpackArchiveSegment(bytes: Uint8Array, startMs: number) {
  const frames: { type: 'video' | 'audio'; keyframe: boolean; timestampUs: number; receivedAtMs: number; payload: Uint8Array; sampleRate?: number; channels?: number; config?: Uint8Array }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let firstTimestampUs: number | undefined;
  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset);
    offset += 4;
    if (length < 17 || offset + length > bytes.length) throw new Error('Archived video is incomplete');
    const envelope = bytes.subarray(offset, offset + length);
    const isVideo = hasH264Envelope(envelope);
    const isAudio = !isVideo && envelope[0] === 0x42 && envelope[1] === 0x4c && envelope[2] === 0x41 && envelope[3] === 0x31;
    
    if (isVideo) {
      const frame = decodeH264Envelope(envelope);
      if (!frame) throw new Error('Archived video is invalid');
      firstTimestampUs ??= frame.timestampUs;
      frames.push({ type: 'video', ...frame, receivedAtMs: startMs + (frame.timestampUs - firstTimestampUs) / 1000 });
    } else if (isAudio) {
      const frame = decodeAacEnvelope(envelope);
      if (!frame) throw new Error('Archived audio is invalid');
      firstTimestampUs ??= frame.timestampUs;
      frames.push({ type: 'audio', keyframe: false, ...frame, receivedAtMs: startMs + (frame.timestampUs - firstTimestampUs) / 1000 });
    }
    
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('Archived video is incomplete');
  return frames;
}

function ArchivedReplay({ gameId, event, onClose }: { gameId: string; event: EventItem; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<VideoDecoder | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const audioDecoderRef = useRef<AudioDecoder | undefined>(undefined);
  const audioNextTimeRef = useRef(0);
  const audioMutedRef = useRef(false);
  const queueRef = useRef<{ keyframe: boolean; timestampUs: number; payload: Uint8Array }[]>([]);
  const baseRef = useRef<{ timestampUs: number; wallMs: number } | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const telemetryRef = useRef<{ first?: number; last?: number; count: number }>({ count: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [finished, setFinished] = useState(false);
  const [retry, setRetry] = useState(0);
  const [playableFrames, setPlayableFrames] = useState<any[]>([]);

  const downloadClip = () => {
    if (!playableFrames.length) return;
    const firstAudio = playableFrames.find(f => f.type === 'audio');
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: 1280, height: 720 },
      audio: firstAudio && firstAudio.sampleRate && firstAudio.channels ? {
        codec: 'aac',
        sampleRate: firstAudio.sampleRate,
        numberOfChannels: firstAudio.channels,
      } : undefined,
      firstTimestampBehavior: 'offset',
      fastStart: 'in-memory',
    });
    for (const frame of playableFrames) {
      if (frame.type === 'video') muxer.addVideoChunk(new EncodedVideoChunk({ type: frame.keyframe ? 'key' : 'delta', timestamp: frame.timestampUs, data: frame.payload }));
      else if (frame.type === 'audio') muxer.addAudioChunk(new EncodedAudioChunk({ type: 'key', timestamp: frame.timestampUs, data: frame.payload }));
    }
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `clip-${event.id}.mp4`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const abort = new AbortController();
    const run = async () => {
      setLoading(true); setError(''); setFinished(false);
      closeDecoder(decoderRef);
      closeAudioDecoder(audioDecoderRef);
      audioContextRef.current?.close().catch(() => undefined);
      audioContextRef.current = undefined;
      audioNextTimeRef.current = 0;
      queueRef.current = [];
      baseRef.current = undefined;
      timerRef.current = undefined;
      telemetryRef.current = { count: 0 };
      try {
        if (!('VideoDecoder' in window)) throw new Error('This browser cannot play archived H.264 video.');
        const eventMs = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
        if (!Number.isFinite(eventMs)) throw new Error('This moment has no media timestamp.');
        const startMs = eventMs - 12_000;
        const endMs = eventMs + 8_000;
        const response = await fetch(`${API}/v1/games/${gameId}/media-segments?from=${startMs}&to=${endMs}`, { signal: abort.signal });
        if (!response.ok) throw new Error('Archived video could not be loaded.');
        const { segments } = await response.json() as { segments: ArchiveSegment[] };
        if (!segments.length) throw new Error('Video for this moment is still processing or was not archived. Try again shortly.');
        const frames = (await Promise.all(segments.map(async (segment) => {
          const file = await fetch(`${API}${segment.url}`, { signal: abort.signal });
          if (!file.ok) throw new Error('An archived video segment is unavailable.');
          return unpackArchiveSegment(new Uint8Array(await file.arrayBuffer()), segment.startMs);
        }))).flat();
        if (abort.signal.aborted) return;
        const eventFrame = frames.reduce<(typeof frames)[number] | undefined>((closest, frame) => !closest || Math.abs(frame.receivedAtMs - eventMs) < Math.abs(closest.receivedAtMs - eventMs) ? frame : closest, undefined);
        if (!eventFrame || Math.abs(eventFrame.receivedAtMs - eventMs) > 1_000) throw new Error('Archived video does not cover this moment.');
        let firstKeyframe = -1;
        for (let index = 0; index < frames.length; index += 1) {
          if (frames[index].keyframe && frames[index].receivedAtMs <= startMs) firstKeyframe = index;
        }
        if (firstKeyframe < 0) firstKeyframe = frames.findIndex((frame) => frame.keyframe && frame.receivedAtMs <= eventMs);
        if (firstKeyframe < 0) throw new Error('Archived video has no keyframe before this moment.');
        const playable = frames.slice(firstKeyframe).filter((frame) => frame.receivedAtMs <= endMs);
        if (!playable.length) throw new Error('Archived video is not ready yet.');
        setPlayableFrames(playable);
        setLoading(false);
        for (const frame of playable) {
          if (frame.type === 'video') {
            enqueueReplayFrame(frame, decoderRef, queueRef, baseRef, timerRef, canvasRef, telemetryRef, (active) => { if (!active) setFinished(true); });
          } else if (frame.type === 'audio' && frame.sampleRate && frame.channels && frame.config) {
            if (!audioContextRef.current) {
               audioContextRef.current = new AudioContext();
               audioDecoderRef.current = new AudioDecoder({
                 output: (audio) => playAudioData(audioContextRef.current!, audio, audioNextTimeRef, audioMutedRef),
                 error: (e) => console.info('[bleachers:archived-aac-error]', { error: e.message })
               });
               audioDecoderRef.current.configure({ codec: 'mp4a.40.2', sampleRate: frame.sampleRate, numberOfChannels: frame.channels, description: frame.config });
            }
            if (audioDecoderRef.current?.state === 'configured') {
              try { audioDecoderRef.current.decode(new EncodedAudioChunk({ type: 'key', timestamp: frame.timestampUs, data: frame.payload })); }
              catch (e) { console.info('[bleachers:archived-aac-drop]', { error: String(e) }); }
            }
          }
        }
      } catch (cause) {
        if (!abort.signal.aborted) { setLoading(false); setError(cause instanceof Error ? cause.message : 'Archived video could not be played.'); }
      }
    };
    void run();
    return () => { abort.abort(); if (timerRef.current !== undefined) window.clearTimeout(timerRef.current); timerRef.current = undefined; closeDecoder(decoderRef); closeAudioDecoder(audioDecoderRef); audioContextRef.current?.close().catch(()=>undefined); queueRef.current = []; baseRef.current = undefined; };
  }, [gameId, event, retry]);
  return <div className="archived-replay"><canvas ref={canvasRef} />{loading ? <p role="status">Loading saved video…</p> : null}{error ? <div className="archive-error" role="status"><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>TRY AGAIN</button></div> : null}{finished ? <div className="archive-finished" role="status">Replay finished <button onClick={() => setRetry((value) => value + 1)}>PLAY AGAIN</button></div> : null}
    <div className="archive-controls">
      {playableFrames.length > 0 && <button className="archive-download" onClick={downloadClip}>↓ DOWNLOAD MP4</button>}
      <button className="archive-close" onClick={onClose}>✕ CLOSE REPLAY</button>
    </div>
  </div>;
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

function formatOrganizerPin(secret: string) {
  const compact = secret.replace(/[-_\s]/g, '').toUpperCase();
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : secret;
}

function OrganizerSetup() {
  const [homeTeam, setHomeTeam] = useState('');
  const [awayTeam, setAwayTeam] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdGame, setCreatedGame] = useState<string>();
  const [createdSecret, setCreatedSecret] = useState('');
  useEffect(() => {
    if (!createdGame) return;
    const timer = window.setTimeout(() => { window.location.href = `/?game=${createdGame}&mode=organize#secret=${createdSecret}`; }, 1_800);
    return () => window.clearTimeout(timer);
  }, [createdGame, createdSecret]);
  const createGame = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API}/v1/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeTeam, awayTeam }) });
      if (!response.ok) throw new Error('Game could not be created');
      const payload = await response.json() as { game: { gameId: string }; organizerSecret: string };
      setCreatedSecret(payload.organizerSecret);
      setCreatedGame(payload.game.gameId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Game could not be created'); setBusy(false); }
  };
  return <main className="shell setup-shell"><header className="topbar"><span className="mark">BLEACHERS</span><span className="privacy">PRIVATE SETUP</span></header><section className="setup-card"><span className="tag">SOCCER GAME</span><h1>Create a private game</h1><p className="muted">Create a game, then share the viewer link. On the broadcaster, type the game code and organizer PIN.</p>{createdGame ? <div className="created-game"><span className="join-label">Game code</span><strong>{createdGame.slice(0, 6)}</strong><span className="join-label">Organizer PIN</span><strong className="join-pin">{formatOrganizerPin(createdSecret)}</strong><code>{location.origin}/?game={createdGame}</code><button className="live-button" onClick={() => { window.location.href = `/?game=${createdGame}&mode=organize#secret=${createdSecret}`; }}>OPEN ORGANIZER</button><p className="muted">Save the organizer link separately. Anyone with that link can control the game.</p></div> : <form onSubmit={createGame}><label>Home team<input value={homeTeam} onChange={(event) => setHomeTeam(event.target.value)} required /></label><label>Away team<input value={awayTeam} onChange={(event) => setAwayTeam(event.target.value)} required /></label>{error ? <p className="error">{error}</p> : null}<button className="live-button" disabled={busy}>{busy ? 'CREATING…' : 'CREATE PRIVATE GAME'}</button></form>}</section></main>;
}

function OrganizerControls({ game, gameId, secret, onChange }: { game: Game; gameId: string; secret: string; onChange: (game: Game) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const copy = async (label: string, url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(label); }
    catch { setError('Could not copy the link. Select the URL shown below instead.'); }
  };
  const send = async (path: string, command?: object) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API}/v1/games/${gameId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: command ? JSON.stringify(command) : undefined });
      const payload = await response.json() as { game?: Game; error?: string };
      if (!response.ok || !payload.game) throw new Error(payload.error ?? 'Game update failed');
      onChange({ ...game, ...payload.game });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Game update failed'); }
    finally { setBusy(false); }
  };
  return <section className="organizer-controls"><div className="timeline-head"><h2>Organizer controls</h2><span>{game.status.toUpperCase()}</span></div>
    {error ? <p className="error">{error}</p> : null}
    {game.status === 'scheduled' ? <button disabled={busy} onClick={() => void send('start')}>START GAME</button> : null}
    {game.status === 'live' ? <><div className="control-grid"><button disabled={busy} onClick={() => void send('commands', { kind: 'GOAL', team: 'home' })}>+ {game.homeTeam} goal</button><button disabled={busy} onClick={() => void send('commands', { kind: 'GOAL', team: 'away' })}>+ {game.awayTeam} goal</button><button disabled={busy} onClick={() => void send('commands', { kind: 'SAVE' })}>SAVE</button><button disabled={busy} onClick={() => void send('commands', { kind: 'HIGHLIGHT' })}>HIGHLIGHT</button><button disabled={busy} onClick={() => void send('commands', { kind: 'FOUL' })}>FOUL</button><button disabled={busy} onClick={() => void send('commands', { kind: 'CLOCK', running: !game.clockRunning })}>{game.clockRunning ? 'PAUSE CLOCK' : 'RESUME CLOCK'}</button></div><div className="correction-controls"><button disabled={busy || game.homeScore === 0} onClick={() => { if (window.confirm(`Remove one ${game.homeTeam} goal?`)) void send('commands', { kind: 'GOAL_CORRECTION', team: 'home' }); }}>− {game.homeTeam} goal</button><button disabled={busy || game.awayScore === 0} onClick={() => { if (window.confirm(`Remove one ${game.awayTeam} goal?`)) void send('commands', { kind: 'GOAL_CORRECTION', team: 'away' }); }}>− {game.awayTeam} goal</button></div><button className="end-game" disabled={busy} onClick={() => { if (window.confirm('End this game?')) void send('end'); }}>END GAME</button></> : null}
    <div className="share-actions"><button onClick={() => void copy('viewer', `${location.origin}/?game=${game.gameId}`)}>{copied === 'viewer' ? 'VIEWER LINK COPIED' : 'COPY VIEWER LINK'}</button><button onClick={() => void copy('organizer', `${location.origin}/?game=${game.gameId}&mode=organize#secret=${secret}`)}>{copied === 'organizer' ? 'ORGANIZER LINK COPIED' : 'COPY ORGANIZER LINK'}</button></div>
    <p className="muted">Viewer link: <code>{location.origin}/?game={game.gameId}</code></p>
    <p className="join-codes"><span>Game code <b>{game.gameId.slice(0, 6)}</b></span><span>Organizer PIN <code className="secret-code">{formatOrganizerPin(secret)}</code></span></p>
    <p className="muted">Type those two codes in the broadcaster, or paste the organizer link into the game field.</p>
  </section>;
}

function App() {
  const gameId = params.get('game') ?? '';
  const isPublisher = location.pathname === '/publish' || params.get('mode') === 'publish';
  const isOrganizer = params.get('mode') === 'organize';
  const organizerSecret = new URLSearchParams(location.hash.slice(1)).get('secret') ?? '';
  const [game, setGame] = useState<Game>();
  const [postgameEvents, setPostgameEvents] = useState<EventItem[]>();
  const [canonicalGameId, setCanonicalGameId] = useState('');
  const [error, setError] = useState('');
  const [replaying, setReplaying] = useState<EventItem>();
  const [archivedEvent, setArchivedEvent] = useState<EventItem>();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [savedMoments, setSavedMoments] = useState<SavedMoment[]>([]);
  const [saveStatus, setSaveStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [viewerSessionId] = useState(getViewerSessionId);
  const configuredRelayUrl = params.get('relay') ?? '';
  const [relayUrl, setRelayUrl] = useState(configuredRelayUrl && (configuredRelayUrl.startsWith('http://') || configuredRelayUrl.startsWith('https://')) ? configuredRelayUrl : configuredRelayUrl ? `https://${configuredRelayUrl}` : '');
  const [capabilityIdentity, setCapabilityIdentity] = useState<unknown>();
  const [rewind, setRewind] = useState<((event?: EventItem) => boolean) | undefined>();
  const [replayActive, setReplayActive] = useState(false);
  const [replayMessage, setReplayMessage] = useState('');
  const [shareMessage, setShareMessage] = useState('');
  const stageRef = useRef<HTMLElement>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [fullScreenFallback, setFullScreenFallback] = useState(false);
  useEffect(() => {
    const sync = () => setFullScreen(document.fullscreenElement === stageRef.current || fullScreenFallback);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [fullScreenFallback]);
  useEffect(() => {
    if (!fullScreenFallback) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullScreenFallback(false); };
    window.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener('keydown', escape); };
  }, [fullScreenFallback]);
  const toggleFullScreen = async () => {
    if (document.fullscreenElement === stageRef.current) { await document.exitFullscreen(); return; }
    if (fullScreenFallback) { setFullScreenFallback(false); setFullScreen(false); return; }
    try { await stageRef.current?.requestFullscreen(); setFullScreen(true); }
    catch { setFullScreenFallback(true); setFullScreen(true); }
  };
  const [audioMuted, setAudioMuted] = useState(false);
  const registerRewind = useCallback((next: (event?: EventItem) => boolean) => setRewind(() => next), []);
  const playReplay = (event?: EventItem) => {
    if (archivedEvent || (game?.status !== 'ended' && replayActive)) { setReplayMessage('Return to live before starting another replay.'); return; }
    setReplayMessage('');
    if (game?.status !== 'ended' && rewind?.(event)) { setReplaying(event); return; }
    const target = event ?? { id: crypto.randomUUID(), sequence: 0, kind: 'HIGHLIGHT' as const, gameTimeSeconds: Math.max(0, (game?.clockSeconds ?? 0) - 10), createdAt: new Date(Date.now() - 10_000).toISOString() };
    setArchivedEvent(target);
    setReplaying(target);
  };
  const shareGame = async () => {
    const url = `${location.origin}/?game=${canonicalGameId || gameId}`;
    try {
      if (navigator.share) await navigator.share({ title: `${game?.homeTeam ?? 'Home'} vs ${game?.awayTeam ?? 'Away'} · Bleachers`, url });
      else { await navigator.clipboard.writeText(url); setShareMessage('Viewer link copied.'); }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setShareMessage(`Viewer link: ${url}`);
    }
  };
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
    if (!canonicalGameId) return;
    let cancelled = false;
    fetch(`${API}/v1/games/${canonicalGameId}/moments?viewerSessionId=${encodeURIComponent(viewerSessionId)}`)
      .then(async (response) => { if (!response.ok) throw new Error('Saved moments unavailable'); return response.json() as Promise<{ moments: SavedMoment[] }>; })
      .then(({ moments }) => { if (!cancelled) { setSavedMoments(moments); setSaved(new Set(moments.map((moment) => moment.event_id).filter((value): value is string => !!value))); } })
      .catch(() => { /* Live viewing remains available while saves are unavailable. */ });
    return () => { cancelled = true; };
  }, [canonicalGameId, viewerSessionId]);

  useEffect(() => {
    if (!canonicalGameId || game?.status !== 'ended') return;
    let cancelled = false;
    setReplayActive(false);
    fetch(`${API}/v1/games/${canonicalGameId}/events`)
      .then(async (response) => { if (!response.ok) throw new Error('Timeline unavailable'); return response.json() as Promise<{ events: EventItem[] }>; })
      .then(({ events }) => { if (!cancelled) setPostgameEvents(events); })
      .catch(() => { /* The game snapshot still contains the most recent events. */ });
    return () => { cancelled = true; };
  }, [canonicalGameId, game?.status]);

  useEffect(() => {
    // Resolve a short link through the game record first.  Media capability
    // and relay namespace must always use the canonical UUID.
    const capabilityGameId = canonicalGameId;
    if (!capabilityGameId || configuredRelayUrl) return;
    let cancelled = false;
    let renewal: number | undefined;
    const load = () => {
      void getCapability(capabilityGameId, isPublisher ? 'publisher' : 'viewer', organizerSecret).then((capability) => {
        if (cancelled) return;
        setRelayUrl(capability.relayUrl);
        setBroadcastName(capability.broadcastName);
        setCapabilityIdentity(capability.capabilityIdentity);
        console.info('[bleachers:capability]', { gameId: capabilityGameId, role: isPublisher ? 'publisher' : 'viewer', relayOrigin: new URL(capability.relayUrl).origin, capabilityIdentity: capability.capabilityIdentity, broadcastName: capability.broadcastName, namespace: capability.broadcastName.split('/'), trackName: 'media/main/video' });
        if (capability.expires) {
          const expiry = Date.parse(capability.expires);
          if (Number.isFinite(expiry)) renewal = window.setTimeout(load, Math.max(1_000, expiry - Date.now() - 60_000));
        }
      }).catch((cause) => {
        if (!cancelled) { setError(cause instanceof Error ? cause.message : 'Media capability is unavailable'); renewal = window.setTimeout(load, 30_000); }
      });
    };
    load();
    return () => { cancelled = true; if (renewal) window.clearTimeout(renewal); };
  }, [gameId, canonicalGameId, configuredRelayUrl, isPublisher, organizerSecret]);

  const selectedEvent = replaying ?? archivedEvent;
  const saveDisabled = saving || (replayActive && !replaying) || (game?.status === 'ended' && !selectedEvent);
  const clock = useMemo(() => {
    const seconds = selectedEvent?.gameTimeSeconds ?? game?.clockSeconds ?? 0;
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }, [game?.clockSeconds, selectedEvent?.gameTimeSeconds]);

  const saveMoment = useCallback(async () => {
    if (!game || saveDisabled) return;
    const gameTimeSeconds = Math.max(0, Math.floor(selectedEvent?.gameTimeSeconds ?? game.clockSeconds));
    const mediaAtMs = selectedEvent?.createdAt ? Date.parse(selectedEvent.createdAt) : Date.now();
    const saveKey = selectedEvent ? `event:${selectedEvent.id}` : `save:${crypto.randomUUID()}`;
    setSaving(true);
    setSaveStatus('Saving moment…');
    try {
      const response = await fetch(`${API}/v1/games/${gameId}/moments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameTimeSeconds, viewerSessionId, eventId: saveKey, mediaAtMs }),
      });
      if (!response.ok) throw new Error('Moment could not be saved');
      const payload = await response.json() as { id?: string; createdAt?: string; mediaAtMs?: number };
      setSaved((current) => new Set(current).add(saveKey));
      setSavedMoments((current) => current.some((moment) => moment.event_id === saveKey) ? current : [{ id: payload.id ?? saveKey, event_id: saveKey, game_time_seconds: gameTimeSeconds, created_at: payload.createdAt ?? new Date().toISOString(), media_at_ms: payload.mediaAtMs ?? mediaAtMs, media_ready: 0 }, ...current]);
      setSaveStatus('Moment marked. Waiting for archived video…');
      const momentMs = payload.mediaAtMs ?? mediaAtMs;
      let ready = false;
      for (let attempt = 0; attempt < 6 && !ready; attempt += 1) {
        if (attempt) await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        try {
          const media = await fetch(`${API}/v1/games/${canonicalGameId || gameId}/media-segments?from=${momentMs - 12_000}&to=${momentMs + 8_000}`);
          if (media.ok) {
            const result = await media.json() as { segments: ArchiveSegment[] };
            ready = result.segments.some((segment) => segment.startMs <= momentMs + 1_000 && segment.endMs >= momentMs - 1_000);
          }
        } catch { /* A moment remains marked while archive connectivity recovers. */ }
      }
      setSaveStatus(ready ? 'Saved video is ready to replay.' : 'Moment marked, but video is not archived yet. Try playback later.');
      if (ready) setSavedMoments((current) => current.map((moment) => moment.event_id === saveKey ? { ...moment, media_ready: 1 } : moment));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Moment could not be saved');
      setSaveStatus('Moment could not be saved.');
    } finally { setSaving(false); }
  }, [game, gameId, canonicalGameId, viewerSessionId, saveDisabled, selectedEvent]);

  if (!gameId && params.get('mode') === 'setup') return <OrganizerSetup />;
  if (!gameId) return <main className="shell empty"><span className="mark">BLEACHERS</span><h1>Private game link required.</h1><p>Open a link containing <code>?game=&lt;gameId&gt;</code> or use <code>?mode=setup</code>.</p></main>;

  return <main className="shell">
    <header className="topbar"><div><span className="mark">BLEACHERS</span><span className="live-label">{isPublisher ? 'PUBLISHER' : game?.status === 'live' ? 'LIVE' : game?.status === 'ended' ? 'POSTGAME' : 'WAITING FOR GAME'}</span></div><div className="topbar-actions"><button className="share-link" onClick={() => void shareGame()}>SHARE</button><span className="privacy">PRIVATE GAME</span></div></header>
    {shareMessage ? <p className="replay-message" role="status">{shareMessage}</p> : null}
    {error ? <section className="error">{error}</section> : null}
    {isPublisher ? <section className="replay-message">Browser publishing does not archive footage. Use the Android broadcaster for saved video and replay after reload.</section> : null}
    <section className={`stage ${fullScreenFallback ? 'stage-fallback-fullscreen' : ''}`} ref={stageRef}>
      {game?.status === 'ended' ? <div className="video-placeholder"><div className="play-orb">✓</div><p>Game ended · timeline and saved moments remain available.</p></div> : relayUrl && broadcastName ? isPublisher ? <moq-publish-ui><moq-publish url={relayUrl} name={broadcastName} source="camera"><video muted autoPlay playsInline /></moq-publish></moq-publish-ui> : <Draft16Camera relayUrl={relayUrl} broadcastName={broadcastName} capabilityIdentity={capabilityIdentity} onRewindReady={registerRewind} replayActive={replayActive} onReplayState={handleReplayState} audioMuted={audioMuted} /> : <div className="video-placeholder"><div className="play-orb">▶</div><p>{isPublisher ? 'Requesting camera publishing capability…' : 'Requesting live viewing capability…'}</p></div>}
      {archivedEvent ? <ArchivedReplay gameId={canonicalGameId || gameId} event={archivedEvent} onClose={() => { setArchivedEvent(undefined); setReplaying(undefined); }} /> : null}
      <div className="stage-overlay"><div className="stage-overlay-score"><b>{game?.homeTeam ?? 'HOME'} {game?.homeScore ?? '—'} · {game?.awayScore ?? '—'} {game?.awayTeam ?? 'AWAY'}</b><span>{clock}</span></div><div className="stage-overlay-actions">{saveStatus ? <span className="stage-save-status" role="status">{saveStatus}</span> : null}{!isPublisher ? <><button onClick={() => { setReplayActive(false); setArchivedEvent(undefined); setReplaying(undefined); setReplayMessage(''); }}>● LIVE</button><button disabled={saveDisabled} onClick={() => void saveMoment()}>☆ SAVE</button><button onClick={() => setAudioMuted((muted) => !muted)}>{audioMuted ? '🔇' : '🔊'}</button></> : null}<button onClick={() => void toggleFullScreen()} aria-label={fullScreen ? 'Exit fullscreen video' : 'Fullscreen video'}>{fullScreen ? '↙ EXIT' : '⛶ FULLSCREEN'}</button></div></div>
    </section>
    <section className="scoreboard"><div><span>{game?.homeTeam ?? 'HOME'}</span><strong>{game?.homeScore ?? '—'}</strong></div><div className="clock"><small>1ST HALF</small><strong>{clock}</strong></div><div><span>{game?.awayTeam ?? 'AWAY'}</span><strong>{game?.awayScore ?? '—'}</strong></div></section>
    {isOrganizer && game ? organizerSecret ? <OrganizerControls game={game} gameId={canonicalGameId || gameId} secret={organizerSecret} onChange={setGame} /> : <section className="error">Organizer link is missing its secret.</section> : null}
    {!isPublisher ? <section className="actions"><button className="live-button" onClick={() => { setReplaying(undefined); setReplayActive(false); setArchivedEvent(undefined); setReplayMessage(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>● LIVE</button><button onClick={() => playReplay()}>↶ −10 SEC</button><button disabled={saveDisabled} onClick={() => void saveMoment()}>☆ SAVE MOMENT</button><button className={audioMuted ? 'muted-button' : ''} onClick={() => setAudioMuted((muted) => !muted)}>{audioMuted ? '🔇 UNMUTE' : '🔊 MUTE'}</button></section> : null}
    {replayMessage ? <p className="replay-message" role="status">{replayMessage}</p> : null}
    {replaying ? <section className="replay-card"><div><span className="tag">REPLAY</span><h2>{replaying.kind} · {formatClock(replaying.gameTimeSeconds)}</h2><p>{archivedEvent ? 'Playing archived video.' : 'Replay is selected while the live subscription stays active.'}</p></div><button onClick={() => { setReplayActive(false); setArchivedEvent(undefined); setReplaying(undefined); setReplayMessage(''); }}>RETURN TO LIVE</button></section> : null}
    <section className="timeline"><div className="timeline-head"><h2>Game events</h2><span>{saved.size} saved</span></div>{(postgameEvents ?? game?.events)?.length ? (postgameEvents ?? game!.events).map((event) => <button className="event" key={event.id} onClick={() => playReplay(event)}><span className="event-icon">{event.kind === 'GOAL' ? '⚽' : event.kind === 'HIGHLIGHT' ? '★' : event.kind === 'GOAL_CORRECTION' ? '−' : '•'}</span><span><b>{event.kind === 'GOAL_CORRECTION' ? 'GOAL CORRECTED' : event.kind}{event.team ? ` · ${event.team === 'home' ? game?.homeTeam : game?.awayTeam}` : ''}</b><small>{formatClock(event.gameTimeSeconds)}</small></span><span>›</span></button>) : <p className="muted">No events yet. Goals, saves, and highlights will appear here.</p>}</section>
    {!isPublisher && savedMoments.length ? <section className="timeline"><div className="timeline-head"><h2>My saved moments</h2><span>{savedMoments.length}</span></div>{savedMoments.map((moment) => <button className="event" key={moment.id} onClick={() => playReplay({ id: moment.id, sequence: 0, kind: 'HIGHLIGHT', gameTimeSeconds: moment.game_time_seconds, createdAt: new Date(moment.media_at_ms).toISOString() })}><span className="event-icon">☆</span><span><b>Saved moment</b><small>Game clock {formatClock(moment.game_time_seconds)} · {moment.media_ready ? 'VIDEO READY' : 'VIDEO NOT AVAILABLE YET'}</small></span><span>›</span></button>)}<p className="muted">Saved times stay with this browser. Archived video can play after the game ends.</p></section> : null}
  </main>;
}

function formatClock(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }

// MoQ owns long-lived WebTransport state.  React StrictMode's development
// double-mount leaves an in-flight SUBSCRIBE behind on some browser builds,
// causing duplicate reconnect loops, so mount the transport owner once.
createRoot(document.getElementById('root')!).render(<App />);
