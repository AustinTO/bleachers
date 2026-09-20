import { requireNativeModule } from 'expo-modules-core';
import type { NativeWebTransportModuleApi } from './types';

let cached: NativeWebTransportModuleApi | undefined;

export function getNativeWebTransportModule(): NativeWebTransportModuleApi {
  if (!cached) {
    cached = requireNativeModule<NativeWebTransportModuleApi>('ExpoMoqWebTransport');
  }
  return cached;
}
