# expo-moq-webtransport

Experimental native WebTransport bridge for **Expo / React Native** designed to be structurally compatible with OpenMOQ/Playa's `@moqt/webtransport` and Cloudflare's **MoQT draft-16** relay.

It fills the missing mobile transport layer:

```text
React Native / Expo
        │
        │ WHATWG ReadableStream / WritableStream
        ▼
expo-moq-webtransport
        │
        │ Expo Modules (Uint8Array <-> ByteArray/Data)
        ▼
Kotlin / Swift
        │
        │ UniFFI
        ▼
moq-dev/web-transport-ffi + small subprotocol patch
        │
        ▼
QUIC + HTTP/3 WebTransport
        │
        ▼
Cloudflare MoQ draft-16
```

## Why the patch exists

`web-transport-ffi-v0.1.2` exposes native WebTransport streams/datagrams to Kotlin and Swift, but its FFI `Client.connect(url)` does not expose WebTransport subprotocol negotiation. Cloudflare draft-16 expects the WebTransport protocol token `moqt-16`.

`native-patch/0001-webtransport-subprotocols.patch` adds:

- `Client.connect_with_protocols(url, protocols)` using the upstream `ConnectRequest.with_protocols(...)` API;
- `Session.protocol()` to expose the selected protocol;
- `Session.close_info()` so the JS facade can report browser-shaped close information;
- a safe certificate-store fallback: platform roots are preferred, but if native root discovery yields an empty store (a mobile/Android failure mode), Mozilla roots from `webpki-roots` are used instead.

The patch is intentionally small and pinned to upstream tag `web-transport-ffi-v0.1.2`.

## JavaScript API

```ts
import {
  assertDraft16,
  createCloudflareDraft16Transport,
} from 'expo-moq-webtransport';
import { MoqtConnection } from '@moqt/webtransport';

const wt = createCloudflareDraft16Transport(CLOUDFLARE_MOQ_TOKEN);
await assertDraft16(wt);

const moq = new MoqtConnection(16);
await moq.connect(wt);
```

`NativeWebTransport` provides the byte-transport surface used by `@moqt/webtransport`:

- `kind === 'webtransport'`
- `protocol`
- `ready` / `closed`
- `createBidirectionalStream()`
- `createUnidirectionalStream()`
- `incomingBidirectionalStreams`
- `incomingUnidirectionalStreams`
- `datagrams.readable` / `datagrams.writable`
- `close()`

The implementation uses pull-based native reads/accepts so JavaScript stream backpressure controls native work instead of flooding the bridge with events.

## Cloudflare draft-16 helper

```ts
const wt = createCloudflareDraft16Transport(token);
```

creates:

```text
https://draft-16.cloudflare.mediaoverquic.com/<url-encoded-token>
```

and offers exactly:

```text
moqt-16
```

Use short-lived relay tokens. Cloudflare draft-16 puts the token in the URL path.

## Requirements

- Expo SDK 53+ recommended
- React Native 0.78+
- iOS 16+
- Android API 24+ at the native transport layer
- a **development build / custom native build**; this cannot run inside Expo Go
- Rust toolchain for producing the vendored native FFI artifacts
- Android NDK + `cargo-ndk` for Android
- macOS + Xcode for the iOS XCFramework

For Playa/OpenMOQ, pin the pre-1.0 packages to the same release. At the time this scaffold was produced, `@moqt/transport` and `@moqt/webtransport` are both `0.5.7`.

```bash
npm install @moqt/transport@0.5.7 @moqt/webtransport@0.5.7
```

## Build the package

The TypeScript portion and mock bridge test can be run anywhere:

```bash
npm test
npm run build
```

### Android native artifacts

Install Rust and `cargo-ndk`, set `ANDROID_NDK_HOME`, then:

```bash
npm run native:android
```

The script:

1. clones `moq-dev/web-transport` at `web-transport-ffi-v0.1.2`;
2. applies the subprotocol patch;
3. generates UniFFI Kotlin bindings;
4. cross-compiles the Rust library for Android;
5. vendors the generated Kotlin source and `.so` files into this Expo module.

### iOS native artifacts

On macOS with Xcode:

```bash
npm run native:ios
```

The script generates the Swift UniFFI binding, builds device + simulator static libraries, creates `WebTransportFFI.xcframework`, and vendors it into `ios/vendor/`.

## Add to an Expo app

The easiest development layout is a local Expo module:

```text
your-app/
  modules/
    expo-moq-webtransport/   <- this directory
  package.json
```

Reference it from the app:

```json
{
  "dependencies": {
    "expo-moq-webtransport": "file:./modules/expo-moq-webtransport"
  }
}
```

Then install and generate a native development build:

```bash
npm install
npx expo prebuild
npx expo run:android
# or on macOS:
npx expo run:ios
```

If using EAS, commit/vendor the generated native artifacts first, then build normally with EAS.

## Direct transport use

```ts
import { NativeWebTransport } from 'expo-moq-webtransport';

const wt = new NativeWebTransport('https://relay.example.com/path', {
  protocols: ['moqt-16'],
  native: {
    maxIdleTimeoutSecs: 30,
    keepAliveIntervalSecs: 10,
  },
});

await wt.ready;
console.log(wt.protocol);

const bidi = await wt.createBidirectionalStream();
const writer = bidi.writable.getWriter();
await writer.write(new Uint8Array([1, 2, 3]));
await writer.close();
```

`noCertificateVerification` exists only for local testing. Do not enable it against production relays.

## What has been verified in this artifact

- strict TypeScript compilation of the WebTransport facade;
- a runtime mock covering negotiated `moqt-16`, bidi stream bytes + FIN/EOF, datagram read/write, and close propagation;
- compile-time structural shape against the byte-stream interface Playa expects;
- upstream source compatibility of the patch design was checked against `web-transport-ffi-v0.1.2`, `web-transport-quinn-v0.12.0`, and its `ConnectRequest.with_protocols` / `Session.protocol()` APIs;
- Cloudflare's current draft-16 URL/auth model and draft support were checked when this scaffold was created.

## What is **not** claimed as verified here

This environment is Linux and does not have the Rust/Android NDK/Xcode toolchains needed to compile both native targets. Therefore the generated UniFFI Kotlin/Swift code and final Android/iOS link step have **not** been compiled in this environment yet. The native wrappers are written to the current UniFFI surface, but the first real native build may expose small generated-name/type adjustments.

That is the next validation gate; it is deliberately documented rather than pretending the native binaries were built here.

## Repository layout

```text
src/                         JS/TS WebTransport facade
android/                     Expo Kotlin module
ios/                         Expo Swift module + XCFramework target
native-patch/                minimal upstream FFI patch
scripts/                     clone/patch/build/vendor scripts
example/                     Cloudflare + MoqtConnection smoke test
test/                        compile-time transport-shape checks
```

## License

This wrapper is MIT. The vendored/built `moq-dev/web-transport` components retain their upstream MIT/Apache-2.0 licensing.
