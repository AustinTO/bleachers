import { getNativeWebTransportModule } from './native';
import type {
  NativeWebTransportModuleApi,
  NativeWebTransportOptions,
  WebTransportBidirectionalStreamLike,
  WebTransportCloseInfoLike,
} from './types';

const DEFAULT_READ_CHUNK = 64 * 1024;

function assertChunk(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('WebTransport stream writes require Uint8Array chunks');
  }
}

/**
 * A WebTransport-shaped native transport for Expo/React Native.
 *
 * It intentionally uses WHATWG ReadableStream/WritableStream so Sans-I/O MoQT
 * implementations such as @moqt/webtransport can consume it structurally.
 * Expo SDK 53+ provides the Web Streams globals on native platforms.
 */
export class NativeWebTransport {
  readonly kind = 'webtransport' as const;
  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfoLike>;
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStreamLike>;
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly maxDatagramSize: number;
  };

  private readonly native: NativeWebTransportModuleApi;
  private readonly url: string;
  private readonly protocols: string[];
  private readonly options: NativeWebTransportOptions;
  private sessionId?: string;
  private negotiatedProtocol?: string;
  private datagramMax = 0;
  private closeRequested?: WebTransportCloseInfoLike;
  private released = false;

  constructor(url: string, options: NativeWebTransportOptions = {}) {
    this.url = url;
    this.options = options;
    this.protocols = [...(options.protocols ?? [])];
    this.native = options.nativeApi ?? getNativeWebTransportModule();

    this.ready = this.connect();
    this.closed = this.monitorClosed();

    this.incomingUnidirectionalStreams = new ReadableStream({
      pull: async (controller) => {
        try {
          const sessionId = await this.requireSession();
          const recvId = await this.native.acceptUni(sessionId);
          controller.enqueue(this.makeReadable(recvId));
        } catch (error) {
          controller.error(error);
        }
      },
    });

    this.incomingBidirectionalStreams = new ReadableStream({
      pull: async (controller) => {
        try {
          const sessionId = await this.requireSession();
          const ids = await this.native.acceptBi(sessionId);
          controller.enqueue(this.makeBidi(ids.sendStreamId, ids.recvStreamId));
        } catch (error) {
          controller.error(error);
        }
      },
    });

    const readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const sessionId = await this.requireSession();
          controller.enqueue(await this.native.receiveDatagram(sessionId));
        } catch (error) {
          controller.error(error);
        }
      },
    });

    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        assertChunk(chunk);
        const sessionId = await this.requireSession();
        if (this.datagramMax > 0 && chunk.byteLength > this.datagramMax) {
          throw new RangeError(
            `Datagram is ${chunk.byteLength} bytes; native max is ${this.datagramMax}`,
          );
        }
        await this.native.sendDatagram(sessionId, chunk);
      },
    });

    // maxDatagramSize becomes meaningful once ready resolves. A getter keeps
    // the browser-shaped object current instead of freezing the initial 0.
    this.datagrams = {
      readable,
      writable,
      get maxDatagramSize() {
        return 0;
      },
    } as typeof this.datagrams;
    Object.defineProperty(this.datagrams, 'maxDatagramSize', {
      enumerable: true,
      get: () => this.datagramMax,
    });
  }

  /** WebTransport subprotocol selected by the server (e.g. "moqt-16"). */
  get protocol(): string | undefined {
    return this.negotiatedProtocol;
  }

  async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
    const sessionId = await this.requireSession();
    const sendId = await this.native.openUni(sessionId);
    return this.makeWritable(sendId);
  }

  async createBidirectionalStream(): Promise<WebTransportBidirectionalStreamLike> {
    const sessionId = await this.requireSession();
    const ids = await this.native.openBi(sessionId);
    return this.makeBidi(ids.sendStreamId, ids.recvStreamId);
  }

  close(info: Partial<WebTransportCloseInfoLike> = {}): void {
    const normalized = {
      closeCode: info.closeCode ?? 0,
      reason: info.reason ?? '',
    };
    this.closeRequested = normalized;
    void this.ready
      .then(async () => {
        if (this.sessionId) {
          await this.native.close(this.sessionId, normalized.closeCode, normalized.reason);
        }
      })
      // `closed` already surfaces connection failures; do not create a second
      // unhandled rejection solely because close() was called while connecting.
      .catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const nativeOptions = this.options.native ?? {};
    const info = await this.native.connect(
      this.url,
      this.protocols,
      nativeOptions.noCertificateVerification ?? false,
      nativeOptions.maxIdleTimeoutSecs === undefined ? 30 : nativeOptions.maxIdleTimeoutSecs,
      nativeOptions.keepAliveIntervalSecs ?? null,
    );
    this.sessionId = info.sessionId;
    this.negotiatedProtocol = info.protocol ?? undefined;
    this.datagramMax = info.maxDatagramSize;

    if (this.closeRequested) {
      const { closeCode, reason } = this.closeRequested;
      await this.native.close(info.sessionId, closeCode, reason);
    }
  }

  private async monitorClosed(): Promise<WebTransportCloseInfoLike> {
    await this.ready;
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error('Native WebTransport session disappeared after connect');
    try {
      const info = await this.native.waitClosed(sessionId);
      return this.closeRequested ?? info;
    } finally {
      if (!this.released) {
        this.released = true;
        await this.native.releaseSession(sessionId).catch(() => undefined);
      }
    }
  }

  private async requireSession(): Promise<string> {
    await this.ready;
    if (!this.sessionId) throw new Error('Native WebTransport session is unavailable');
    return this.sessionId;
  }

  private makeBidi(sendId: string, recvId: string): WebTransportBidirectionalStreamLike {
    return {
      readable: this.makeReadable(recvId),
      writable: this.makeWritable(sendId),
    };
  }

  private makeReadable(recvId: string): ReadableStream<Uint8Array> {
    const readSize = this.options.readChunkSize ?? DEFAULT_READ_CHUNK;
    let done = false;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (done) return;
        try {
          const chunk = await this.native.recvRead(recvId, readSize);
          if (chunk.byteLength === 0) {
            done = true;
            controller.close();
            await this.native.releaseRecvStream(recvId).catch(() => undefined);
            return;
          }
          controller.enqueue(chunk);
        } catch (error) {
          done = true;
          controller.error(error);
          await this.native.releaseRecvStream(recvId).catch(() => undefined);
        }
      },
      cancel: async (reason) => {
        done = true;
        const code = typeof reason === 'number' ? reason : 0;
        await this.native.recvStop(recvId, code).catch(() => undefined);
        await this.native.releaseRecvStream(recvId).catch(() => undefined);
      },
    });
  }

  private makeWritable(sendId: string): WritableStream<Uint8Array> {
    let done = false;
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (done) throw new TypeError('Cannot write to a closed WebTransport stream');
        assertChunk(chunk);
        await this.native.sendWrite(sendId, chunk);
      },
      close: async () => {
        if (done) return;
        done = true;
        try {
          await this.native.sendFinish(sendId);
        } finally {
          await this.native.releaseSendStream(sendId).catch(() => undefined);
        }
      },
      abort: async (reason) => {
        if (done) return;
        done = true;
        const code = typeof reason === 'number' ? reason : 0;
        try {
          await this.native.sendReset(sendId, code);
        } finally {
          await this.native.releaseSendStream(sendId).catch(() => undefined);
        }
      },
    });
  }
}
