# Example use

Install matching Playa packages:

```bash
npm install @moqt/transport@0.5.7 @moqt/webtransport@0.5.7
```

Add this native module to an Expo SDK 53+ application, build the native FFI artifacts, create a development build, then use `App.tsx` as a Cloudflare draft-16 smoke test.

This module contains native code and therefore does **not** run in Expo Go.
