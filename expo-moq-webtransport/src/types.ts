export type NativeSessionInfo = {
  sessionId: string;
  protocol?: string | null;
  maxDatagramSize: number;
};

export type NativeBiStreamInfo = {
  sendStreamId: string;
  recvStreamId: string;
};

export type NativeCloseInfo = {
  closeCode: number;
  reason: string;
};

export type NativeConnectOptions = {
  noCertificateVerification?: boolean;
  maxIdleTimeoutSecs?: number | null;
  keepAliveIntervalSecs?: number | null;
};

export interface NativeWebTransportModuleApi {
  connect(
    url: string,
    protocols: string[],
    noCertificateVerification: boolean,
    maxIdleTimeoutSecs: number | null,
    keepAliveIntervalSecs: number | null,
  ): Promise<NativeSessionInfo>;
  close(sessionId: string, code: number, reason: string): Promise<void>;
  waitClosed(sessionId: string): Promise<NativeCloseInfo>;
  releaseSession(sessionId: string): Promise<void>;

  openUni(sessionId: string): Promise<string>;
  openBi(sessionId: string): Promise<NativeBiStreamInfo>;
  acceptUni(sessionId: string): Promise<string>;
  acceptBi(sessionId: string): Promise<NativeBiStreamInfo>;

  sendWrite(sendStreamId: string, data: Uint8Array): Promise<void>;
  sendFinish(sendStreamId: string): Promise<void>;
  sendReset(sendStreamId: string, code: number): Promise<void>;
  releaseSendStream(sendStreamId: string): Promise<void>;

  recvRead(recvStreamId: string, maxBytes: number): Promise<Uint8Array>;
  recvStop(recvStreamId: string, code: number): Promise<void>;
  releaseRecvStream(recvStreamId: string): Promise<void>;

  sendDatagram(sessionId: string, data: Uint8Array): Promise<void>;
  receiveDatagram(sessionId: string): Promise<Uint8Array>;
}

export type NativeWebTransportOptions = {
  protocols?: string[];
  native?: NativeConnectOptions;
  /** Internal/testing escape hatch. Normal applications should omit this. */
  nativeApi?: NativeWebTransportModuleApi;
  /** Native read chunk size. Defaults to 64 KiB. */
  readChunkSize?: number;
};

export type WebTransportCloseInfoLike = {
  closeCode: number;
  reason: string;
};

export type WebTransportBidirectionalStreamLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
