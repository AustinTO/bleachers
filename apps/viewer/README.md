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

Create a game at `/?mode=setup`. The organizer link returned after creation
contains a PIN in the URL fragment. Keep that link private; it grants game
start, scoring, clock, and end controls. Share only the plain `?game=<game-id>`
link with viewers. The organizer page also shows the short game code and
8-character organizer PIN to enter in the Android broadcaster when joining an
existing game. You can paste the full organizer link into the broadcaster's
game field instead.

The organizer can correct an accidental goal; the correction remains in the
event timeline. Viewer moment saves are restored on reload for the same browser
session. Saving a selected event preserves that event's media time. The
broadcaster uploads keyframe-aligned H.264 segments to the API's
R2 archive; saved moments and older events can play video from there after a
viewer freeze or reload. Save Moment reports when archived video becomes ready.
Archived replay currently contains video only; live viewing retains H.264/AAC.
Expiring viewer media capabilities refresh during a long game. The viewer also
retains up to three minutes of recent H.264 frames with a 48 MiB memory cap;
actual coverage depends on bitrate. Older events fall back to the archive.
The video stage supports fullscreen viewing with score, clock, save, audio, and
return-to-live controls over the picture.
The postgame timeline loads the durable event history, including events older
than the 100-item live snapshot window. The Share button sends or copies only
the spectator link.

Apply API migrations `0003_organizer_secret.sql`, `0004_media_segments.sql`,
and `0005_moment_media_time.sql`
and create the `bleachers-media` R2 bucket before using the archive flow.
Games created before that migration have no organizer secret and cannot use the
new protected mutation routes; create a new game for this flow.

If `VITE_MOQ_RELAY_URL` is present in `.env.local`, the `relay` query
parameter may be omitted.

The relay URL is the subscriber-capability endpoint. The broadcast name used
by the Android publisher is `sports/<game-id>`.

Short game IDs are accepted (`?game=abc123`) and resolved to the canonical UUID
before requesting media capability. `↶10` and event selection navigate the
local rolling DVR while the live subscription remains active; after a buffer
gap they load archived video. `Save Moment` marks a private timeline point and
plays the archived footage once the publisher uploads its segment. Downloadable
clip export remains separate.
