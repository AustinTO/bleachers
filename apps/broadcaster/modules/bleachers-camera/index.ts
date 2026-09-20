import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';

export type EncodedCameraFrame = {
  payload: Uint8Array;
  timestampUs: number;
  keyframe: boolean;
  width: number;
  height: number;
};

export type EncodedAudioFrame = {
  payload: Uint8Array;
  timestampUs: number;
  config: Uint8Array;
  sampleRate: number;
  channels: number;
};

/** Camera permissions must be granted and any Expo CameraView unmounted first.
 * Frames are Annex B H.264; every keyframe includes SPS/PPS. Pull one frame at
 * a time and await the transport write before pulling again. Native buffering
 * is bounded and requests a new keyframe when the consumer falls behind.
 */
export default requireNativeModule<{
  start(width: number, height: number, fps: number, bitrate: number): Promise<void>;
  readFrame(): Promise<EncodedCameraFrame | null>;
  requestKeyframe(): Promise<void>;
  startAudio(): Promise<void>;
  readAudioFrame(): Promise<EncodedAudioFrame | null>;
  stop(): Promise<void>;
}>('BleachersCamera');

export const BleachersCameraPreview = requireNativeViewManager('BleachersCamera');
