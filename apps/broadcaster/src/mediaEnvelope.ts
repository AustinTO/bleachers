const MAGIC = [0x42, 0x4c, 0x43, 0x31]; // BLC1
const AUDIO_MAGIC = [0x42, 0x4c, 0x41, 0x31]; // BLA1
const HEADER_SIZE = 17;

export function encodeH264Frame(payload: Uint8Array, timestampUs: number, keyframe: boolean, width: number, height: number): Uint8Array {
  const packet = new Uint8Array(HEADER_SIZE + payload.length);
  packet.set(MAGIC, 0);
  const view = new DataView(packet.buffer);
  view.setUint8(4, keyframe ? 1 : 0);
  view.setBigUint64(5, BigInt(timestampUs));
  view.setUint16(13, width);
  view.setUint16(15, height);
  packet.set(payload, HEADER_SIZE);
  return packet;
}

export function encodeAacFrame(payload: Uint8Array, timestampUs: number, config: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const headerSize = 17;
  const packet = new Uint8Array(headerSize + config.length + payload.length);
  packet.set(AUDIO_MAGIC, 0);
  const view = new DataView(packet.buffer);
  view.setBigUint64(4, BigInt(timestampUs));
  view.setUint16(12, sampleRate);
  view.setUint8(14, channels);
  view.setUint16(15, config.length);
  packet.set(config, headerSize);
  packet.set(payload, headerSize + config.length);
  return packet;
}
