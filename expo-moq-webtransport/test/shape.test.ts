import { NativeWebTransport } from '../src/NativeWebTransport';
import type { NativeWebTransportModuleApi } from '../src/types';

// Compile-time smoke test for the browser-shaped API using a mock native bridge.
const mock: NativeWebTransportModuleApi = {
  async connect() { return { sessionId: 's', protocol: 'moqt-16', maxDatagramSize: 1200 }; },
  async close() {},
  async waitClosed() { return { closeCode: 0, reason: '' }; },
  async releaseSession() {},
  async openUni() { return 'su'; },
  async openBi() { return { sendStreamId: 'sb', recvStreamId: 'rb' }; },
  async acceptUni() { return 'ru'; },
  async acceptBi() { return { sendStreamId: 'sbi', recvStreamId: 'rbi' }; },
  async sendWrite() {},
  async sendFinish() {},
  async sendReset() {},
  async releaseSendStream() {},
  async recvRead() { return new Uint8Array(); },
  async recvStop() {},
  async releaseRecvStream() {},
  async sendDatagram() {},
  async receiveDatagram() { return new Uint8Array([1]); },
};

const wt = new NativeWebTransport('https://example.test/moq', {
  protocols: ['moqt-16'],
  nativeApi: mock,
});

const _ready: Promise<void> = wt.ready;
const _uni: Promise<WritableStream<Uint8Array>> = wt.createUnidirectionalStream();
const _bi = wt.createBidirectionalStream();
void [_ready, _uni, _bi];
