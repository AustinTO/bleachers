import { requireNativeModule } from 'expo-modules-core';

type PublisherBridge = {
  moqConnectPublisher(relayUrl: string, broadcastName: string): Promise<string>;
  moqPublishTrack(publisherId: string, namespace: string[], name: string): Promise<string>;
  moqSendObject(trackId: string, payload: Uint8Array, timestampUs: number, keyframe: boolean): Promise<void>;
  moqCheckPublisher(publisherId: string): Promise<void>;
  moqClosePublisher(publisherId: string): Promise<void>;
};

export const MoqNative = {
  async connectPublisher(options: { relayUrl: string; broadcastName: string }) {
    const bridge = requireNativeModule<PublisherBridge>('ExpoMoqWebTransport');
    const id = await bridge.moqConnectPublisher(options.relayUrl, options.broadcastName);
    let closed = false;
    return {
      async publishTrack(track: { namespace: string[]; name: string }) {
        if (closed) throw new Error('Publisher closed');
        const trackId = await bridge.moqPublishTrack(id, track.namespace, track.name);
        return {
          async ready() { await bridge.moqCheckPublisher(id); },
          async sendObject(object: { payload: Uint8Array; timestampUs: number; keyframe: boolean }) {
            if (closed) throw new Error('Publisher closed');
            if (!Number.isSafeInteger(object.timestampUs) || object.timestampUs < 0) throw new Error('timestampUs must be a nonnegative safe integer');
            await bridge.moqSendObject(trackId, object.payload, object.timestampUs, object.keyframe);
          },
        };
      },
      async check() { await bridge.moqCheckPublisher(id); },
      async close() {
        if (closed) return;
        closed = true;
        await bridge.moqClosePublisher(id);
      },
    };
  },
};
