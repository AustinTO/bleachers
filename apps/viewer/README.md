# Bleachers Viewer

Browser viewer for the live MoQ path. The viewer treats the game timeline as
authoritative: score, clock, events, viewer saves, replay navigation, and media
locations all share one game timestamp. WebTransport/WebCodecs supply the
premium MoQ path for H.264/AAC; state remains usable independently when media
degrades.

Run locally:

```bash
npm install
npm run dev
```

Open `/` with a private game id:

```text
http://localhost:5173/?game=<game-id>&relay=<relay-url>&name=<broadcast-name>
```

If `VITE_MOQ_RELAY_URL` is present in `.env.local`, the `relay` query
parameter may be omitted.

The relay URL is the subscriber-capability endpoint. The broadcast name used
by the Android publisher is `sports/<game-id>`.

Short game IDs are accepted (`?game=abc123`) and resolved to the canonical UUID
before requesting media capability. `↶10` and event selection navigate the
local rolling DVR while the live subscription remains active. `Save Moment`
records a timeline signal; permanent clip export is intentionally separate.
