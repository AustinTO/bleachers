# Bleachers Broadcaster

Android-first Expo shell for the soccer broadcaster flow.

## What works now

* rear-camera permission and 16:9 live preview on a physical Android device;
* scoreboard, running clock, goal/save/foul/highlight event controls;
* a deployed Cloudflare Durable Object-backed game, score/event state, and event feed; and
* native H.264/AAC MoQ publishing to the active game timeline, including a
  local rolling encoded buffer and separate audio/video tracks; and
* camera/encoder health monitoring that can recover the capture pipeline
  without treating stale video as live media.

The Android native module owns Camera2/MediaCodec and microphone capture while
the application transport layer publishes named MoQ tracks. The Worker mints
the short-lived publisher capability at game start; do not place relay tokens
in the application bundle. A goal/save/highlight action belongs to the same
monotonic game timeline as encoded media, allowing event replay without making
a clip first.

## Run on Android

```bash
npm install
npx expo start --android
```

Use a physical Android phone for camera testing. Expo Camera supports device
preview in Expo Go; native MoQ publishing requires the development APK because
Expo Go cannot contain the local `MoqNative` module.

The assembled debug APK is at
`android/app/build/outputs/apk/debug/app-debug.apk`.
