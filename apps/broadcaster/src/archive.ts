/** Uploads bounded, independently decodable H.264 chunks without holding up the relay. */
export class MediaArchive {
  private frames: Uint8Array[] = [];
  private bytes = 0;
  private startUs = 0;
  private lastUs = 0;
  private firstUs?: number;
  private firstEpochMs = 0;
  private pending: Array<{ data: Uint8Array; startMs: number; endMs: number }> = [];
  private uploading = false;
  private closed = false;
  private dropped = 0;

  constructor(private readonly gameId: string, private readonly secret: string) {}

  add(packet: Uint8Array, timestampUs: number, keyframe: boolean) {
    if (this.closed) return;
    if (this.firstUs === undefined) {
      this.firstUs = timestampUs;
      this.firstEpochMs = Date.now();
    }
    if (keyframe && this.frames.length && timestampUs - this.startUs >= 4_000_000) this.seal();
    if (!this.frames.length) {
      if (!keyframe) return;
      this.startUs = timestampUs;
    }
    const size = packet.byteLength + 4;
    if (this.bytes + size > 4 * 1024 * 1024) {
      // A segment cannot be split at an inter-frame without losing decodability.
      this.frames = [];
      this.bytes = 0;
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 10 === 0) console.warn('[bleachers:archive-overflow]', { dropped: this.dropped });
      if (!keyframe || size > 4 * 1024 * 1024) return;
      this.startUs = timestampUs;
    }
    this.frames.push(packet);
    this.bytes += size;
    this.lastUs = timestampUs;
  }

  async finish() {
    if (!this.closed) {
      this.closed = true;
      this.seal();
    }
    while (this.uploading || this.pending.length) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  private seal() {
    if (!this.frames.length || this.firstUs === undefined) return;
    const data = new Uint8Array(this.bytes);
    const view = new DataView(data.buffer);
    let offset = 0;
    for (const frame of this.frames) {
      view.setUint32(offset, frame.byteLength);
      offset += 4;
      data.set(frame, offset);
      offset += frame.byteLength;
    }
    const startMs = this.firstEpochMs + Math.round((this.startUs - this.firstUs) / 1000);
    const endMs = this.firstEpochMs + Math.round((this.lastUs - this.firstUs) / 1000);
    this.frames = [];
    this.bytes = 0;
    if (this.pending.length >= 2) {
      this.dropped++;
      console.warn('[bleachers:archive-backlog]', { dropped: this.dropped });
      return;
    }
    this.pending.push({ data, startMs, endMs });
    void this.drain();
  }

  private async drain() {
    if (this.uploading) return;
    this.uploading = true;
    try {
      while (this.pending.length) {
        const segment = this.pending.shift()!;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 12_000);
        try {
          const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'https://bleachers-api.austintaylorodell.workers.dev';
          const response = await fetch(`${baseUrl}/v1/games/${encodeURIComponent(this.gameId)}/media-segments`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.secret}`,
              'content-type': 'application/octet-stream',
              'x-capture-start-ms': String(segment.startMs),
              'x-capture-end-ms': String(segment.endMs),
            },
            body: segment.data.buffer as ArrayBuffer,
            signal: abort.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
          this.dropped++;
          console.warn('[bleachers:archive-upload-failed]', { dropped: this.dropped, reason: error instanceof Error ? error.message : String(error) });
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      this.uploading = false;
    }
  }
}
