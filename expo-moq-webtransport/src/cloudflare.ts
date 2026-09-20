import { NativeWebTransport } from './NativeWebTransport';
import type { NativeWebTransportOptions } from './types';

export const CLOUDFLARE_MOQ_DRAFT16_ORIGIN =
  'https://draft-16.cloudflare.mediaoverquic.com';

export type CloudflareDraft16Options = Omit<NativeWebTransportOptions, 'protocols'> & {
  endpointOrigin?: string;
};

/**
 * Creates a WebTransport session that explicitly offers the MoQT draft-16
 * WebTransport subprotocol expected by Cloudflare's draft-16 relay.
 */
export function createCloudflareDraft16Transport(
  token: string,
  options: CloudflareDraft16Options = {},
): NativeWebTransport {
  const origin = (options.endpointOrigin ?? CLOUDFLARE_MOQ_DRAFT16_ORIGIN).replace(/\/$/, '');
  const encodedToken = encodeURIComponent(token);
  return new NativeWebTransport(`${origin}/${encodedToken}`, {
    ...options,
    protocols: ['moqt-16'],
  });
}

/** Fails early if a relay didn't actually negotiate draft-16. */
export async function assertDraft16(transport: NativeWebTransport): Promise<void> {
  await transport.ready;
  if (transport.protocol !== 'moqt-16') {
    transport.close({ closeCode: 1, reason: 'Expected moqt-16' });
    throw new Error(
      `Expected WebTransport subprotocol "moqt-16", got ${JSON.stringify(transport.protocol)}`,
    );
  }
}
