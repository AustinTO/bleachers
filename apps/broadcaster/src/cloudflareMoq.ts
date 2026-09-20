import { MoqNative } from 'expo-moq-webtransport';

export const PROBE = new Uint8Array([66, 76, 69, 65, 67, 72, 69, 82, 83, 0, 16, 255]);

export async function connectCloudflareMoq(relayUrl: string, broadcastName: string, capabilityIdentity?: unknown) {
  const namespace = broadcastName.split('/');
  console.info('[bleachers:moq-track]', { role: 'publisher', relayOrigin: new URL(relayUrl).origin, capabilityIdentity, broadcastName, namespace, trackName: 'media/main/video' });
  const publisher = await MoqNative.connectPublisher({ relayUrl, broadcastName });
  try {
    const track = await publisher.publishTrack({ namespace, name: 'media/main/video' });
    const audioTrack = await publisher.publishTrack({ namespace, name: 'media/main/audio' });
    await track.ready();
    await audioTrack.ready();
    await track.sendObject({ payload: PROBE, timestampUs: 0, keyframe: true });
    return {
      sendObject: track.sendObject.bind(track),
      sendAudioObject: audioTrack.sendObject.bind(audioTrack),
      check: () => publisher.check(),
      close: () => publisher.close(),
    };
  } catch (error) {
    await publisher.close();
    throw error;
  }
}

export type CloudflareMoqSession = Awaited<ReturnType<typeof connectCloudflareMoq>>;
