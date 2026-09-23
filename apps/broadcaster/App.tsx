import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { Alert, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, EventKind, RemoteGame, TeamSide, getOrganizerSecret, setOrganizerSecret } from './src/api';
import { connectCloudflareMoq, PROBE, type CloudflareMoqSession } from './src/cloudflareMoq';
import BleachersCamera, { BleachersCameraPreview } from './modules/bleachers-camera';
import { encodeAacFrame, encodeH264Frame } from './src/mediaEnvelope';
import { VideoArchive } from './src/archive';

type GameEventKind = EventKind;
type GameEvent = { id: string; kind: GameEventKind; elapsedSeconds: number };

const formatClock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
};

export default function App() {
  useKeepAwake();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [isLive, setIsLive] = useState(false);
  const [isClockRunning, setIsClockRunning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [homeScore, setHomeScore] = useState(0);
  const [awayScore, setAwayScore] = useState(0);
  const [homeTeam, setHomeTeam] = useState('Tigers');
  const [awayTeam, setAwayTeam] = useState('Eagles');
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [cameraReady, setCameraReady] = useState(false);
  const [gameId, setGameId] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [joinGameCode, setJoinGameCode] = useState('');
  const [joinOrganizerSecret, setJoinOrganizerSecret] = useState('');
  const updateJoinGame = (value: string) => {
    const pasted = value.trim();
    if (/^https?:\/\//i.test(pasted)) {
      try {
        const link = new URL(pasted);
        const game = link.searchParams.get('game');
        const secret = new URLSearchParams(link.hash.slice(1)).get('secret');
        if (game && secret) { setJoinGameCode(game); setJoinOrganizerSecret(secret); return; }
      } catch { /* Allow editing an incomplete link. */ }
    }
    setJoinGameCode(value);
  };
  const moqSession = useRef<CloudflareMoqSession | undefined>(undefined);
  const liveRef = useRef(false);
  const archiveRef = useRef<VideoArchive | undefined>(undefined);

  useEffect(() => {
    if (!isClockRunning) return;
    const interval = setInterval(() => setElapsedSeconds((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [isClockRunning]);

  const applyRemoteGame = (game: RemoteGame) => {
    if (game.homeTeam) setHomeTeam(game.homeTeam);
    if (game.awayTeam) setAwayTeam(game.awayTeam);
    setHomeScore(game.homeScore);
    setAwayScore(game.awayScore);
    setElapsedSeconds(game.clockSeconds);
    setIsClockRunning(game.clockRunning);
    setEvents(game.events.map((event) => ({ id: event.id, kind: event.kind, elapsedSeconds: event.gameTimeSeconds })));
  };

  const startLive = async () => {
    if (!cameraReady) return Alert.alert('Camera is still starting', 'Wait for the preview, then try again.');
    if (Platform.OS === 'android') {
      const microphone = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (microphone !== PermissionsAndroid.RESULTS.GRANTED) return Alert.alert('Microphone access is required', 'Allow microphone access to include field audio in the live broadcast.');
    }
    setIsSaving(true);
    setIsConnecting(true);
    let started: RemoteGame;
    try {
      const existingCode = joinGameCode.trim();
      if (existingCode) {
        if (!joinOrganizerSecret.trim()) throw new Error('Enter the organizer PIN to broadcast to an existing game.');
        setOrganizerSecret(joinOrganizerSecret);
        const existing = await api.getGame(existingCode);
        if (existing.status === 'ended') throw new Error('That game has already ended. Create a new game or use another code.');
        started = existing.status === 'live' ? existing : await api.startGame(existing.gameId);
      } else {
        const created = await api.createGame('Tigers', 'Eagles');
        started = await api.startGame(created.gameId);
      }
      setGameId(started.gameId);
      applyRemoteGame(started);
    } catch (cause) {
      Alert.alert('Backend connection failed', cause instanceof Error ? cause.message : 'The game API could not be reached.');
      setIsSaving(false);
      setIsConnecting(false);
      return;
    }
    try {
      const capability = await api.mediaCapability(started.gameId, 'publisher');
      console.info('[bleachers:capability]', { gameId: started.gameId, role: 'publisher', relayOrigin: new URL(capability.relayUrl).origin, capabilityIdentity: capability.capabilityIdentity, broadcastName: capability.broadcastName, namespace: capability.broadcastName.split('/'), trackName: 'media/main/video' });
      moqSession.current = await connectCloudflareMoq(capability.relayUrl, capability.broadcastName, capability.capabilityIdentity);
      setIsLive(true);
      liveRef.current = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      // Use the camera's widely supported hardware surface size. The preview
      // and viewer presentation layers handle portrait display separately.
      // Conservative 720p profile for sideline reliability on mobile H.264
      // hardware; Camera2 can recover rather than wedging the encoder.
      await BleachersCamera.start(1280, 720, 24, 1_200_000);
      await BleachersCamera.startAudio();
      archiveRef.current = new VideoArchive(started.gameId, getOrganizerSecret());
      void pumpH264(moqSession.current, () => liveRef.current, archiveRef.current).catch((cause) => {
        console.error('[bleachers:h264-pump-error]', cause instanceof Error ? cause.message : String(cause));
        liveRef.current = false;
        moqSession.current = undefined;
        setIsLive(false);
        Alert.alert('Live stream stopped', cause instanceof Error ? cause.message : 'The MoQ relay connection closed.');
      });
      void pumpAac(moqSession.current, () => liveRef.current).catch((cause) => console.error('[bleachers:aac-pump-error]', cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) {
      liveRef.current = false;
      await archiveRef.current?.finish();
      archiveRef.current = undefined;
      await BleachersCamera.stop().catch(() => undefined);
      moqSession.current?.close();
      moqSession.current = undefined;
      setIsLive(false);
      const detail = cause instanceof Error ? cause.message : 'The relay rejected the publisher session.';
      Alert.alert('MoQ relay connection failed', detail);
    } finally { setIsSaving(false); setIsConnecting(false); }
  };
  const endLive = async () => {
    await BleachersCamera.stop().catch(() => undefined);
    liveRef.current = false;
    setIsLive(false);
    setIsSaving(true);
    await archiveRef.current?.finish();
    archiveRef.current = undefined;
    moqSession.current?.close();
    moqSession.current = undefined;
    if (gameId) await api.endGame(gameId).catch(() => undefined);
    setIsClockRunning(false);
    setIsSaving(false);
  };
  const addEvent = async (kind: GameEventKind, team?: TeamSide) => {
    if (!gameId || isSaving) return;
    setIsSaving(true);
    try { applyRemoteGame(await api.command(gameId, { kind, team, clockSeconds: elapsedSeconds })); }
    catch { Alert.alert('Event was not saved', 'The game state is unchanged. Check your connection.'); }
    finally { setIsSaving(false); }
  };
  const addGoal = (team: TeamSide) => addEvent('GOAL', team);

  if (!permission) return <View style={styles.screen} />;
  if (!permission.granted) return (
    <SafeAreaView style={styles.permissionScreen}>
      <StatusBar style="light" />
      <Text style={styles.eyebrow}>BLEACHERS</Text>
      <Text style={styles.permissionTitle}>Camera access lets you cover the game.</Text>
      <Text style={styles.permissionCopy}>Use a setup code to join an existing game, or leave it blank to create a new private game from this phone.</Text>
      <Pressable style={styles.primaryButton} onPress={requestPermission}><Text style={styles.primaryButtonText}>Allow camera</Text></Pressable>
    </SafeAreaView>
  );

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {isLive ? <BleachersCameraPreview style={StyleSheet.absoluteFill} /> : <CameraView active facing={facing} mode="picture" ratio="16:9" style={StyleSheet.absoluteFill} onCameraReady={() => setCameraReady(true)} onMountError={(error) => Alert.alert('Camera unavailable', error.message)} />}
      <View pointerEvents="none" style={[styles.scrim, isLive && styles.liveScrim]} />
      <SafeAreaView style={styles.safeArea}>
        <View style={[styles.header, isLive && styles.liveHeader]}>
          {(!isLive || hudVisible) && <View><Text style={styles.eyebrow}>SOCCER · FIELD 1</Text><Text style={styles.connection}>{isConnecting ? 'CONNECTING TO MOQ…' : isLive ? `LIVE · ${gameId?.slice(0, 6)}` : 'NOT LIVE'}</Text></View>}
          <Pressable accessibilityLabel={isLive ? 'Toggle HUD' : 'Flip camera'} style={[styles.flipButton, isLive && styles.hudToggle]} onPress={() => isLive ? setHudVisible((visible) => !visible) : setFacing((value) => value === 'back' ? 'front' : 'back')}><Text style={isLive ? styles.hudLabel : styles.flipButtonText}>{isLive ? 'HUD' : '↻'}</Text></Pressable>
        </View>
        {(!isLive || hudVisible) && <View style={[styles.scoreboard, isLive && styles.liveScoreboard, { padding: 8, marginTop: 8, borderRadius: 10 }]}>
          <View style={styles.teamScore}><Text style={styles.teamName}>{homeTeam.toUpperCase()}</Text><Text style={[styles.score, { fontSize: 34 }]}>{homeScore}</Text></View>
          <View style={styles.clockColumn}><Text style={styles.period}>1ST HALF</Text><Text style={[styles.clock, { fontSize: 22 }]}>{formatClock(elapsedSeconds)}</Text><Pressable onPress={() => { if (gameId) void api.command(gameId, { kind: 'CLOCK', running: !isClockRunning, clockSeconds: elapsedSeconds }).then(applyRemoteGame).catch(() => Alert.alert('Clock was not updated', 'Check your connection.')); else setIsClockRunning((running) => !running); }}><Text style={styles.clockAction}>{isClockRunning ? 'PAUSE CLOCK' : 'START CLOCK'}</Text></Pressable></View>
          <View style={styles.teamScore}><Text style={styles.teamName}>{awayTeam.toUpperCase()}</Text><Text style={[styles.score, { fontSize: 34 }]}>{awayScore}</Text></View>
        </View>}
        <View style={styles.spacer} />
        {(!isLive || hudVisible) && <View style={[styles.controls, styles.liveControls]}>
          {!isLive && <TextInput accessibilityLabel="Game code or organizer link" autoCapitalize="none" autoCorrect={false} placeholder="Game code or organizer link" placeholderTextColor="#7EA28B" value={joinGameCode} onChangeText={updateJoinGame} style={styles.gameCodeInput} />}
          {!isLive && !!joinGameCode.trim() && <TextInput accessibilityLabel="Organizer PIN" autoCapitalize="characters" autoCorrect={false} placeholder="Organizer PIN" placeholderTextColor="#7EA28B" value={joinOrganizerSecret} onChangeText={setJoinOrganizerSecret} style={styles.gameCodeInput} />}
          <View style={styles.goalRow}>
            <Pressable style={[styles.eventButton, styles.goalButton, isLive && styles.liveEventButton, { paddingVertical: 10, borderRadius: 10 }]} onPress={() => addGoal('home')}><Text style={[styles.eventButtonText, { fontSize: 17 }]}>GOAL</Text><Text style={styles.eventSubtext}>{homeTeam.toUpperCase()}</Text></Pressable>
            <Pressable style={[styles.eventButton, styles.goalButton, isLive && styles.liveEventButton, { paddingVertical: 10, borderRadius: 10 }]} onPress={() => addGoal('away')}><Text style={[styles.eventButtonText, { fontSize: 17 }]}>GOAL</Text><Text style={styles.eventSubtext}>{awayTeam.toUpperCase()}</Text></Pressable>
          </View>
          <View style={styles.secondaryRow}><EventButton compact={isLive} label="SAVE" onPress={() => addEvent('SAVE')} /><EventButton compact={isLive} label="FOUL" onPress={() => addEvent('FOUL')} /><EventButton compact={isLive} label="HIGHLIGHT" onPress={() => addEvent('HIGHLIGHT')} /></View>
          <Pressable disabled={isSaving || isConnecting} style={[styles.liveButton, isLive && styles.endButton, (isSaving || isConnecting) && styles.disabledButton, { paddingVertical: 10, borderRadius: 10 }]} onPress={() => isLive ? endLive() : startLive()}><View style={[styles.liveDot, isLive && styles.liveDotOn]} /><Text style={[styles.liveButtonText, { fontSize: 12 }]}>{isConnecting ? 'CONNECTING…' : isSaving ? 'UPDATING GAME…' : isLive ? 'END LIVE' : 'START LIVE'}</Text></Pressable>
          {gameId && !!getOrganizerSecret() && <Pressable accessibilityLabel="Back up organizer access" onPress={() => void Share.share({ message: `Bleachers organizer access — keep private\nGame code: ${gameId.slice(0, 6)}\nOrganizer PIN: ${getOrganizerSecret()}` })}><Text style={styles.clockAction}>BACK UP ORGANIZER ACCESS</Text></Pressable>}
        </View>}
        {!isLive && <ScrollView style={styles.eventFeed} contentContainerStyle={styles.eventFeedContent}>
          {events.length === 0 ? <Text style={styles.emptyEvents}>Game events will appear here.</Text> : events.map((event) => <View key={event.id} style={styles.eventLine}><Text style={styles.eventKind}>{event.kind}</Text><Text style={styles.eventTime}>{formatClock(event.elapsedSeconds)}</Text></View>)}
        </ScrollView>}
      </SafeAreaView>
    </View>
  );
}

async function pumpH264(session: CloudflareMoqSession, isStillLive: () => boolean, archive?: VideoArchive) {
  try { while (isStillLive()) {
    // Check relay health even when the camera queue is temporarily empty.
    // Otherwise a dead native session leaves the UI claiming LIVE forever
    // and viewers correctly receive Track not found.
    await session.check();
    const frame = await BleachersCamera.readFrame();
    if (!frame) { await new Promise<void>((resolve) => setTimeout(resolve, 5)); continue; }
    const payload = encodeH264Frame(frame.payload, frame.timestampUs, frame.keyframe, frame.width, frame.height);
    archive?.add(payload, frame.timestampUs, frame.keyframe);
    await session.sendObject({
      payload,
      timestampUs: frame.timestampUs,
      keyframe: frame.keyframe,
    });
  } } finally { await archive?.finish(); }
}

async function pumpAac(session: CloudflareMoqSession, isStillLive: () => boolean) {
  while (isStillLive()) {
    const frame = await BleachersCamera.readAudioFrame();
    if (!frame) { await new Promise<void>((resolve) => setTimeout(resolve, 5)); continue; }
    await session.sendAudioObject({
      payload: encodeAacFrame(frame.payload, frame.timestampUs, frame.config, frame.sampleRate, frame.channels),
      timestampUs: frame.timestampUs,
      keyframe: false,
    });
  }
}

function EventButton({ label, onPress, compact }: { label: string; onPress: () => void; compact?: boolean }) {
  return <Pressable style={[styles.secondaryButton, compact && styles.compactSecondaryButton]} onPress={onPress}><Text style={[styles.secondaryButtonText, compact && styles.compactSecondaryText]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#061713' }, safeArea: { flex: 1, paddingHorizontal: 16 }, scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(1, 9, 7, 0.24)' }, liveScrim: { backgroundColor: 'rgba(1, 9, 7, 0.04)' },
  liveCameraPlaceholder: { alignItems: 'center', backgroundColor: '#061713', justifyContent: 'center' }, liveCameraCopy: { color: '#8FF5AF', fontSize: 14, fontWeight: '800', letterSpacing: 1.2 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8 }, liveHeader: { alignItems: 'flex-start' }, eyebrow: { color: '#B6FFD5', fontSize: 11, fontWeight: '800', letterSpacing: 1.4 }, connection: { color: '#E9FFF1', fontSize: 11, fontWeight: '700', marginTop: 5 },
  flipButton: { backgroundColor: 'rgba(0,0,0,0.42)', borderRadius: 24, height: 48, width: 48, alignItems: 'center', justifyContent: 'center' }, hudToggle: { backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 8, height: 32, width: 52 }, hudLabel: { color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 1 }, flipButtonText: { color: '#fff', fontSize: 30, lineHeight: 32 },
  scoreboard: { backgroundColor: 'rgba(3, 20, 15, 0.84)', borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, padding: 16 }, liveScoreboard: { alignSelf: 'center', borderRadius: 8, marginTop: 2, paddingHorizontal: 10, paddingVertical: 3, width: '42%' }, teamScore: { alignItems: 'center', minWidth: 70 }, teamName: { color: '#D5EADD', fontSize: 11, fontWeight: '800' }, score: { color: '#fff', fontSize: 44, fontVariant: ['tabular-nums'], fontWeight: '800', marginTop: 2 }, clockColumn: { alignItems: 'center' }, period: { color: '#A9D6BB', fontSize: 10, fontWeight: '800', letterSpacing: 1 }, clock: { color: '#fff', fontSize: 28, fontVariant: ['tabular-nums'], fontWeight: '800', marginTop: 4 }, clockAction: { color: '#8FF5AF', fontSize: 10, fontWeight: '800', marginTop: 4 },
  spacer: { flex: 1 }, controls: { gap: 9 }, liveControls: { alignSelf: 'center', gap: 4, marginBottom: 3, width: '88%' }, goalRow: { flexDirection: 'row', gap: 5 }, eventButton: { alignItems: 'center', borderRadius: 15, flex: 1, paddingVertical: 17 }, liveEventButton: { backgroundColor: 'rgba(249,184,58,0.76)', borderRadius: 8, paddingVertical: 6 }, goalButton: { backgroundColor: '#F9B83A' }, eventButtonText: { color: '#102117', fontSize: 22, fontWeight: '900' }, eventSubtext: { color: '#504015', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
  gameCodeInput: { alignSelf: 'center', backgroundColor: 'rgba(3, 20, 15, 0.78)', borderColor: 'rgba(211,255,224,0.35)', borderRadius: 8, borderWidth: 1, color: '#fff', fontSize: 12, paddingHorizontal: 12, paddingVertical: 8, width: '100%' },
  secondaryRow: { flexDirection: 'row', gap: 5 }, secondaryButton: { alignItems: 'center', backgroundColor: 'rgba(3, 26, 18, 0.72)', borderColor: 'rgba(211,255,224,0.35)', borderRadius: 8, borderWidth: 1, flex: 1, paddingVertical: 6 }, compactSecondaryButton: { paddingVertical: 6 }, secondaryButtonText: { color: '#fff', fontSize: 10, fontWeight: '800' }, compactSecondaryText: { fontSize: 9 },
  liveButton: { alignItems: 'center', backgroundColor: 'rgba(230,49,71,0.78)', borderRadius: 8, flexDirection: 'row', justifyContent: 'center', paddingVertical: 6 }, endButton: { backgroundColor: 'rgba(49,41,43,0.78)' }, disabledButton: { opacity: 0.6 }, liveDot: { backgroundColor: '#fff', borderRadius: 4, height: 8, marginRight: 5, width: 8 }, liveDotOn: { backgroundColor: '#FF5D6E' }, liveButtonText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.2 },
  eventFeed: { flexGrow: 0, maxHeight: 120, marginTop: 10 }, eventFeedContent: { paddingBottom: 6 }, emptyEvents: { color: 'rgba(255,255,255,0.75)', fontSize: 12, paddingVertical: 8, textAlign: 'center' }, eventLine: { backgroundColor: 'rgba(1, 11, 8, 0.72)', borderRadius: 8, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5, paddingHorizontal: 12, paddingVertical: 7 }, eventKind: { color: '#fff', fontSize: 11, fontWeight: '800' }, eventTime: { color: '#A9D6BB', fontSize: 11, fontVariant: ['tabular-nums'], fontWeight: '700' },
  permissionScreen: { alignItems: 'flex-start', backgroundColor: '#061713', flex: 1, justifyContent: 'center', padding: 28 }, permissionTitle: { color: '#fff', fontSize: 34, fontWeight: '800', lineHeight: 40, marginTop: 12 }, permissionCopy: { color: '#C8DFD1', fontSize: 16, lineHeight: 24, marginTop: 18 }, primaryButton: { alignItems: 'center', alignSelf: 'stretch', backgroundColor: '#8FF5AF', borderRadius: 14, marginTop: 30, paddingVertical: 16 }, primaryButtonText: { color: '#102117', fontSize: 16, fontWeight: '900' },
});
