import { requireOptionalNativeModule } from 'expo-modules-core';

type MoqNative = { startPublishing(relayUrl: string, broadcastName: string): Promise<void>; stopPublishing(): Promise<void> };
export const moqNative = requireOptionalNativeModule<MoqNative>('MoqNative');
