import { NativeWebTransport } from '../src/NativeWebTransport';
import type { NativeWebTransportModuleApi } from '../src/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const writes: number[][] = [];
const finishes: string[] = [];
const datagramWrites: number[][] = [];
const closes: Array<{ code: number; reason: string }> = [];
let readCount = 0;
let resolveClosed!: (info: { closeCode: number; reason: string }) => void;
const nativeClosed = new Promise<{ closeCode: number; reason: string }>((resolve) => {
  resolveClosed = resolve;
});

const mock: NativeWebTransportModuleApi = {
  async connect(_url, protocols) {
    assert(protocols.length === 1 && protocols[0] === 'moqt-16', 'offers moqt-16');
    return { sessionId: 's1', protocol: 'moqt-16', maxDatagramSize: 1200 };
  },
  async close(_sessionId, code, reason) {
    closes.push({ code, reason });
    resolveClosed({ closeCode: code, reason });
  },
  async waitClosed() { return nativeClosed; },
  async releaseSession() {},
  async openUni() { return 'send-uni'; },
  async openBi() { return { sendStreamId: 'send-bi', recvStreamId: 'recv-bi' }; },
  async acceptUni() { return 'recv-incoming'; },
  async acceptBi() { return { sendStreamId: 'send-incoming-bi', recvStreamId: 'recv-incoming-bi' }; },
  async sendWrite(streamId, data) {
    assert(streamId === 'send-bi', 'writes target the opened bidi stream');
    writes.push([...data]);
  },
  async sendFinish(streamId) { finishes.push(streamId); },
  async sendReset() {},
  async releaseSendStream() {},
  async recvRead(streamId) {
    assert(streamId === 'recv-bi', 'reads target the opened bidi stream');
    readCount += 1;
    return readCount === 1 ? new Uint8Array([9, 8]) : new Uint8Array();
  },
  async recvStop() {},
  async releaseRecvStream() {},
  async sendDatagram(_sessionId, data) { datagramWrites.push([...data]); },
  async receiveDatagram() { return new Uint8Array([4, 5, 6]); },
};

async function main() {
  const wt = new NativeWebTransport('https://example.test/token', {
    protocols: ['moqt-16'],
    nativeApi: mock,
  });

  await wt.ready;
  assert(wt.protocol === 'moqt-16', 'negotiated protocol is surfaced');
  assert(wt.datagrams.maxDatagramSize === 1200, 'datagram limit is surfaced');

  const bidi = await wt.createBidirectionalStream();
  const writer = bidi.writable.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
  assert(JSON.stringify(writes) === '[[1,2,3]]', 'bidi write crosses the native boundary');
  assert(finishes.includes('send-bi'), 'WritableStream close sends FIN');

  const reader = bidi.readable.getReader();
  const first = await reader.read();
  const second = await reader.read();
  assert(!first.done && JSON.stringify([...(first.value ?? [])]) === '[9,8]', 'bidi bytes are read');
  assert(second.done === true, 'zero-length native read maps to stream EOF');

  const dgWriter = wt.datagrams.writable.getWriter();
  await dgWriter.write(new Uint8Array([7, 7]));
  assert(JSON.stringify(datagramWrites) === '[[7,7]]', 'datagram write crosses the bridge');
  const dgReader = wt.datagrams.readable.getReader();
  const dg = await dgReader.read();
  assert(JSON.stringify([...(dg.value ?? [])]) === '[4,5,6]', 'datagram read crosses the bridge');

  wt.close({ closeCode: 23, reason: 'local-test' });
  const closed = await wt.closed;
  assert(closed.closeCode === 23 && closed.reason === 'local-test', 'local close info is preserved');
  assert(closes.some((x) => x.code === 23 && x.reason === 'local-test'), 'native close is invoked');

  console.log('RUNTIME MOCK PASS', {
    protocol: wt.protocol,
    maxDatagramSize: wt.datagrams.maxDatagramSize,
    write: writes[0],
    firstRead: first.value ? [...first.value] : [],
    close: closed,
  });
}

void main();
