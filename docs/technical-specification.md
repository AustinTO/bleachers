# Realtime Rec Sports Platform — Technical Specification

## 1. Decision summary

Build a soccer-first, phone-first live experience whose *product contract* is
LIVE + REWIND + ANGLES. **The game is the product; media is a set of
synchronized data sources inside that game.** Score, clock, events, cameras,
audio, replay requests, and viewer saves attach to one monotonic game timeline.
The production-critical design is deliberately not locked to an unfinished MoQ
draft or one vendor SDK:

* native broadcaster publishes once through a `LiveMediaTransport` adapter;
* Cloudflare MoQ Relay is the primary Sprint-0/primary-path transport, but is
  beta and only supports draft-14 and draft-16 today;
* every viewer gets authoritative score/clock/events separately from video;
* live DVR is application-owned, indexed by game timestamp, and made from
  encoded fragments—not dependent on MoQ FETCH (which Cloudflare does not
  currently support);
* Workers and the per-game Durable Object are control/state only—never a
  live-media proxy; and
* a WebRTC-SFU adapter is the explicit compatibility escape hatch if the MoQ
  browser/native proof does not meet the measured acceptance targets.

The success criterion is a usable sideline stream, not universal MoQ purity.
No MVP commitment should be made until Sprint 0 proves actual devices,
browsers, relay version, codec framing, thermal behavior, and network loss.

## 2. Scope and non-goals

MVP: one active soccer camera, H.264/AAC live A/V, private no-account viewing,
one-phone scoring plus independent scorekeeper, authoritative game timeline,
soccer clock/events, a 3-minute target live-DVR index (60-second engineering
floor during early transport work), event-driven replay, viewer saves,
selected-highlight persistence, recovery, and health metrics. A second camera
is contract-ready; contribute-an-angle approval, director mode, and viewer
angle choice follow once the main-timeline path is proven.

Excluded: recruiting, editing. Facebook URL sharing is MVP-adjacent; actual Facebook Live
simulcast is Sprint 6 only.

Included and Prioritized to beat Sideline HD: public discovery, chat/comments, player identity/biometrics, AI
tracking, advanced statistics, tournaments, broad team management, Automated Catch Me Up selection, multicamera
director controls, and archive gap backfill. These are critical for our competitive advantage.

## 3. Reference architecture

```text
                            GAME SESSION
                     authoritative game timeline
                                  │
       ┌──────────────┬───────────┼───────────┬──────────────┐
       │              │           │           │              │
   score / clock    events    camera main  camera angle   audio
       │              │           │           │              │
       └──────────────┴───────────┼───────────┴──────────────┘
                                  │ game timestamp + epoch
                    ┌─────────────┴─────────────┐
                    │                           │
                LIVE EDGE                    HISTORY
                    │                           │
                 MoQ/SFU                indexed rolling cache
                    │                           │
              browser viewer       replay navigation / permanent export
                    │                           │
               destinations                    R2 archive
```

`Game Core` owns the timeline and knows no codec, relay, or destination
details. `Media Registry` maps a timestamp and camera to media group/object
locations. Media transport knows no soccer rules. This separation is a hard
boundary, not merely a deployment preference.

```text
Expo/RN shell                    React/Vite PWA
  └ native CaptureEngine            ├ MoqWebPlayer (feature detected)
  └ native LiveMediaTransport       ├ fallback player/transport adapter
      ├ MoqTransport ──────────► Cloudflare MoQ Relay ──────────► viewers
      └ WebRtcTransport (fallback)► Cloudflare Realtime SFU ───► viewers
              ▲                                         ▲
              │ capability only                         │ media never enters Worker
Workers API ──┴──► Game Durable Object ◄─ WS ───────────┘
                       │ hot, authoritative game state
                       ├── D1: teams/games/index/history
                       └── R2: immutable highlight objects/manifests

Later: relay/SFU subscriber → containerized media gateway → RTMPS destinations
```

### Component boundaries

| Component | Owns | Must not own |
|---|---|---|
| Native CaptureEngine | camera, mic, hardware encode, fragment ring, thermal adaptation | game authority or long-term data |
| LiveMediaTransport | connect/publish/subscribe, live-edge policy, congestion signals | UI or MOQT wire names outside adapter |
| Game DO | ordered score, clock anchor, events, presence and WebSocket fan-out | media payloads/transcoding |
| Workers API | identity, capabilities, CRUD, link resolution, rate limits | persistent live sockets/media relay |
| D1 | durable product metadata and event/highlight index | per-frame/hot clock state |
| R2 | saved CMAF/fMP4 fragments and highlight manifests | mandatory live playback path |
| PWA | playback selection, event timeline, saves, browser capability detection | truth for score/clock |

### Core services

| Service | Responsibility |
|---|---|
| Game Core | authoritative clock, score, events, roles, timeline epoch |
| Media Registry | camera/track registration, capability binding, live publisher health |
| Replay Index | `{gameTs → camera → group/object}` lookup and rolling-window coverage |
| Rolling Cache | bounded local/edge encoded GOP retention; never a permanent clip job |
| Highlight Engine | merges score events, viewer saves, replay activity into canonical moments |
| Archive Reconciler | fills postgame archive gaps from local retained media without delaying live |
| Director | later: approves contributed cameras and publishes presentation choices |
| Simulcast Gateway | later: subscribes once and emits RTMPS Facebook/YouTube renditions |

## 4. Architecture decisions (ADRs)

### ADR-001: MoQ primary, transport adapter mandatory — **accepted conditionally**

Cloudflare’s relay is beta, supports drafts 14/16 while IETF transport work is
still active, and Cloudflare does not yet support draft-18 globally.  Implement
`LiveMediaTransport`, `MediaPublisher`, `MediaSubscription`, and
`ReplayResolver`; pin one tested relay/draft/package profile in runtime config.
The adapter owns mapping application tracks to provider names, token placement,
and media framing.  It exposes normalized `edge`, `keyframe`, `dropped`,
`congestion`, and `fatal` events.

**Rejected:** letting UI/domain code use MOQT messages directly; it would turn a
draft/provider upgrade into an app rewrite.  **Exit condition:** retain MoQ as
the default only if Sprint 0 meets the device matrix.  Otherwise ship the same
product on `WebRtcTransport` and keep MoQ behind the feature flag.

### ADR-002: Separate media from game state — **accepted**

Use a named DO `game:{gameId}` as the linearizable authority.  Its WebSocket
channel distributes snapshots and ordered deltas; it stores `{epoch, sequence,
clockAnchor}` before acknowledgement.  State is small, reliable, and usable
when video degrades to nothing.  The video timebase is correlated to the game
event's `captureTsMs`, not treated as authority.

### ADR-003: Application replay before native MoQ FETCH — **accepted**

Cloudflare’s current matrix has no FETCH family.  The broadcaster retains
encoded, keyframe-aligned CMAF/fMP4 fragments.  A replay request resolves to a
short manifest/object sequence supplied independently of the live subscription.
Later `MoqReplayResolver` may choose an MOQT FETCH cache without changing viewer
UX or APIs.

### ADR-004: H.264 Baseline/Main + AAC initially — **accepted pending spike**

Start 1280×720/30 FPS, constrained baseline or broadly-decoding Main profile,
2–3.5 Mbps target, IDR every 1 second, AAC-LC mono 48 kHz/64–96 kbps.  Actual
codec string and fMP4/CMAF packaging must pass `VideoDecoder.isConfigSupported`
on the target matrix.  AVC is the pragmatic common denominator; do not choose
HEVC/AV1 for MVP.  Prefer an independently decodable fragment at every GOP.
Test LOC-compatible frame packaging—an active IETF draft that models a GOP as a
group beginning with the IDR—as a Sprint-0 candidate, not a commitment.

### ADR-005: External destinations run outside Workers — **accepted**

There is no documented Cloudflare MoQ-to-RTMP bridge.  A long-running gateway
must subscribe, demux/decode if overlaying, encode H.264/AAC FLV, and publish
RTMPS.  Run it as a dedicated container/service (or validate a managed bridge),
not a Worker/DO. `BroadcastDestination` isolates Facebook/YouTube credentials,
start/stop, health, and retry semantics.  Facebook sharing of private viewer and
highlight URLs comes first.

### ADR-006: Game timeline is the product boundary — **accepted**

Every meaningful action has `{gameId, epoch, gameTimestampMs}`. Game Core
assigns event time; media producers continuously correlate encoded PTS to that
same game timeline. A goal is therefore addressable as both a domain event and
a media location across every camera. Wall-clock arrival time is diagnostic
only, never the durable replay key.

**Rejected:** score/event timestamps that only describe UI state, or media
timestamps treated as independent clocks. Those alternatives prevent reliable
event replay, synchronized angles, Catch Me Up, and viewer-save clustering.

### ADR-007: Replay navigation and permanent clips are separate — **accepted**

Replay reads an existing rolling media window while live subscriptions continue.
It creates no MP4, transcode, R2 object, or rendering job. Clip is an explicit
save/share/export action that materializes a durable asset afterward. `LIVE`
always jumps directly to the newest decodable group.

### ADR-008: Live freshness and archive completeness are separate — **accepted**

After a disconnect, live resumes at the newest keyframe and discards stale
queued media. Independently, Archive Reconciler may upload a locally retained
gap after the game. Archive backfill may never consume the queue, bandwidth, or
latency budget reserved for current live media and state.

### ADR-009: Contributed cameras are demand-adaptive — **accepted for post-MVP**

An approved parent phone publishes as a camera source in the same game epoch;
it is not made a team manager or RTMP operator. Main camera remains selected
quality. Unselected angles advertise a low-quality preview and increase quality
only when a viewer/director requests them. Each phone retains a local
high-quality ring so a synchronized alternate-angle replay does not require
continuous high-bitrate upload from every device.

## 5. Repository and packages

### Web deployment topology

The viewer/control-plane web application is deployed to Netlify as a static
Vite site. Netlify builds `apps/viewer` and injects the public
`VITE_API_URL`; it does not proxy live media. Browser API calls go directly to
the Cloudflare Worker, and browser MoQ/WebTransport sessions go directly to
the capability-scoped Cloudflare relay endpoint.

```text
Netlify CDN/PWA
   ├── HTTPS/JSON → Cloudflare Worker → D1 + Game Durable Object
   └── WebTransport/MoQ ─────────────→ Cloudflare MoQ relay
```

The Netlify site may host organizer setup, game links, postgame timelines,
contributor approval, and director controls as those web sprints land. It is a
presentation/control client, not a media gateway. API CORS, signed capabilities,
and private-link policy remain enforced by the Worker.

Current deploy contract:

```text
base:    apps/viewer
build:   npm run build
publish: dist
public:  VITE_API_URL=https://bleachers-api.austintaylorodell.workers.dev
```

The repository `netlify.toml` contains this configuration and an SPA fallback.
Production deployment must apply pending D1 migrations and deploy the Worker
before enabling UI features that depend on them.

```text
apps/
  broadcaster/                 Expo shell; iOS/Android native modules
  viewer/                      Vite React PWA
  api/                         Cloudflare Worker + Game Durable Object
  media-gateway/               Sprint-6 container, not Worker
packages/
  domain/                      IDs, events, score/clock reducer, schemas
  protocol/                    track names, envelopes, media manifest types
  transport/                   interfaces + MoQ/WebRTC implementations
  replay/                      ring index, resolver contracts, manifests
  ui/                          shared tokens/icons only; no native media
  test-fixtures/               deterministic game/event/media fixtures
infra/
  wrangler/ migrations/ terraform-or-pulumi/
docs/
```

Use TypeScript strict mode and schema validation at every external boundary.
Native code remains in `apps/broadcaster/ios` and `android`, bridged through a
small TurboModule/JNI/Swift interface.  Do not put media packet handling in JS.

## 6. Protocol and track contract

### Naming

Full namespace fields are `("sports", gameId)` and the opaque track name is the
remaining suffix (for example, `media/main/video`). This deliberately matches
the product namespace exactly and avoids broad/prefix authorization surprises.
`epoch` changes on a new broadcast attempt but is carried in every envelope and
media init/config metadata; subscribers reject an old epoch. The slash form
below is a logical display name; the adapter turns it into the provider's MOQT
namespace/name encoding.

| Logical full track | Producer | Format / semantics |
|---|---|---|
| `sports/{gameId}/{epoch}/media/main/video` | active broadcaster | H.264 encoded fragments; groups = GOP, objects = ordered fragment/sample units |
| `.../media/main/audio` | broadcaster | AAC frames/fragments correlated to video clock |
| `.../media/{cameraId}/video` | later camera | same contract; low-priority unless selected |
| `.../state/score` | Game DO bridge | compact reliable snapshot/delta envelope |
| `.../state/clock` | Game DO bridge | anchor/correction envelope |
| `.../events/game` | Game DO bridge | append-only ordered domain events |
| `.../events/highlight` | API/DO | highlight readiness/status events |
| `.../replay/{eventId}` | replay service | optional future transient replay track; never required MVP |
| `.../presence/viewers` | Game DO | aggregate only, never identity to viewers |
| `.../control/broadcaster` | Game DO | reliable authenticated commands/health acknowledgements |

State/events travel by DO WebSocket in MVP; mirror into MoQ data tracks only if
the tested client supports it cleanly.  Their logical tracks preserve a future
single-transport path but are not a reason to delay reliable state. Do not put
names, team metadata, location, or youth identifiers in relay-visible media
object properties.

### Envelope

All control/state payloads use JSON for debugability initially:

```ts
type Envelope<T> = {
  v: 1; gameId: UUID; epoch: number; sequence: number;
  emittedAtMs: number; producerId: UUID; type: string; body: T;
};
```

`sequence` is monotonic per epoch and every command has `commandId` (UUID).
Receivers apply only a contiguous sequence or request a snapshot.  Unknown
versions/events are ignored and logged; invalid envelopes are rejected.

`GameEvent` contains `id`, `kind` (`goal|save|foul|highlight|period_start|
period_end|clock_adjusted`), `gameTimeMs`, `captureTsMs`, `homeScore`,
`awayScore`, optional actor label, `source`, and `replayStatus`.  Score is an
absolute snapshot, never inferred from deltas alone.

### Timeline correlation and media index

`gameTimestampMs` is monotonic within an epoch. Broadcaster time correlation is
recorded at every IDR and whenever the clock starts, pauses, resumes, or is
corrected:

```ts
type MediaLocation = {
  gameId: UUID; epoch: number; cameraId: string;
  gameTimestampMs: number; encodedPtsUs: number;
  groupId: bigint; objectId: bigint; keyframe: boolean;
  rendition: 'selected' | 'preview'; codecConfigId: string;
};
```

The `Replay Index` stores keyframe anchors and contiguous object ranges, not
decoded frames. On a `GOAL` at `31:14.220`, it resolves each available camera to
`31:02.220 → 31:22.220`; a viewer may choose one angle or a synchronized
multiview presentation. Viewer saves and replay requests carry the same game
timestamp, allowing a Highlight Engine to cluster nearby actions into one
popular moment.

### Priority and discard policy

| Class | Payload | Rule |
|---:|---|---|
| 1 | control / clock corrections | reliable, latest wins only where idempotent |
| 2 | score/events | reliable and ordered; snapshot on gap |
| 3 | audio | bounded 250 ms queue; drop obsolete frames |
| 4 | video keyframes | protect newest IDR and codec config |
| 5 | selected live video | deadline ~150 ms; drop rather than queue |
| 6 | alternate preview | first to suspend/degrade |
| 7 | telemetry | sampled/batched; never contends with state |

The scheduler keeps a `liveEdgeDeadlineMs`; anything that cannot arrive/usefully
decode before it is discarded.  Recovery always publishes/subscribes from the
newest keyframe; stale video is never drained.

## 7. Replay design

`FragmentRing` indexes encoded fragments `{startGameTs,endGameTs,
keyframeStart, codecConfigId, localHandle}` for a 3-minute MVP target and a
5-minute design ceiling (60 seconds is only the early transport-spike floor).
It is memory/disk bounded; eviction cannot remove a fragment covered by an
in-flight replay or materialization job.

1. Event at capture time T is committed by the DO immediately; `ReplayJob`
   creates window `[T-12s, min(now,T+8s)]` and reports `pending`.
2. Once the post-roll ends (or a user opens it), the device/service assembles
   only complete GOP-aligned fragments into `ReplayManifest v1`. Availability
   starts as soon as a decodable pre-roll through current live point exists;
   it extends to +8 seconds asynchronously.
3. Viewer keeps its live subscription/decoder alive, opens an independent
   `ReplaySource`, and plays the manifest. `LIVE` switches to the latest
   decodable live keyframe, clears replay decode queue, and reports edge delta.
4. A selected replay is uploaded as immutable R2 objects plus manifest; D1 holds
   the index. R2 is never required for the first replay.

### Live DVR navigation

`↶10` resolves `liveEdge - 10 seconds`; selecting an event resolves its
pre/post-roll window. The replay decoder/subscription is separate from live;
`LIVE` discards replay decode state and seeks the newest available keyframe.
Neither operation creates a permanent video asset.

### Catch Me Up

For a late viewer, `Catch Me Up` constructs a short sequence of existing replay
windows from score events, highlights, and clustered viewer saves, then returns
to live. Initial selection is deterministic—no AI required. It is eligible once
the timeline index and event replay meet their latency target; it must never
delay live startup or require a postgame render.

**Implementation spike decision:** prove whether a handset can serve fragment
bytes directly to a relay/ephemeral replay track.  If not, use a low-latency
authenticated upload of fragment windows to R2/origin. That adds cost but keeps
the promised two-second marker-to-first-frame target measurable. Replays may
start with fewer than 8 seconds of post-roll; UI labels "replay developing".

`SaveMoment` records a viewer vote `{eventId|captureTs, window}`.  A DO applies
an idempotent time-bucket key (`gameId:epoch:round(captureTs/5s)`) and counts
unique anonymous viewer-session hashes; threshold or admin action creates one
canonical highlight, merging nearby saves.

## 8. Data model

```sql
users(id, auth_subject UNIQUE, created_at, deleted_at)
organizations(id, name, created_at)
memberships(org_id, user_id, role, PRIMARY KEY(org_id,user_id))
teams(id, org_id, name, sport CHECK(sport='soccer'), created_at, archived_at)
games(id, org_id, home_team_id, away_team_id, scheduled_at, status,
      privacy DEFAULT 'unlisted', created_by, created_at, ended_at)
game_epochs(game_id, epoch, relay_profile, started_at, ended_at,
            broadcaster_device_id, PRIMARY KEY(game_id,epoch))
viewer_links(id, game_id, token_hash, scopes, expires_at, revoked_at, created_by)
game_events(id, game_id, epoch, sequence, kind, game_time_ms, capture_ts_ms,
            payload_json, actor_id, created_at, UNIQUE(game_id,epoch,sequence))
media_tracks(id, game_id, epoch, camera_id, kind, publisher_session_id,
             rendition, status, started_at, ended_at)
media_keyframes(game_id, epoch, camera_id, game_ts_ms, encoded_pts_us,
                group_id, object_id, codec_config_id,
                PRIMARY KEY(game_id,epoch,camera_id,game_ts_ms))
camera_contributions(id, game_id, epoch, camera_id, requester_id, status,
                     approved_by, created_at, approved_at)
replay_requests(id, game_id, epoch, viewer_session_hash, source_event_id,
                target_game_ts_ms, camera_id, created_at)
highlights(id, game_id, epoch, source_event_id, start_capture_ts_ms,
           end_capture_ts_ms, status, r2_manifest_key, save_count, created_at,
           deleted_at)
moment_saves(id, highlight_bucket_key, viewer_session_hash, created_at,
             UNIQUE(highlight_bucket_key,viewer_session_hash))
archive_gaps(id, game_id, epoch, camera_id, start_game_ts_ms, end_game_ts_ms,
             local_handle, status, r2_manifest_key, created_at, reconciled_at)
broadcast_destinations(id, game_id, type, encrypted_config_ref, status,
                       external_broadcast_id, created_at)
stream_sessions(id, game_id, epoch, started_at, ended_at, disconnect_count,
                health_summary_json)
audit_log(id, org_id, actor_id, action, subject_type, subject_id, occurred_at)
```

Foreign keys/indexes: `games(org_id,scheduled_at)`,
`game_events(game_id,epoch,sequence)`, `highlights(game_id,created_at)`, and
expiration indexes for links/sessions. D1 is the durable projection; the DO
persists event snapshots during play and flushes idempotently by epoch/sequence.

## 9. API and capability model

All REST endpoints are versioned `/v1`; mutable requests include
`Idempotency-Key`; standard errors are `{code,message,requestId}`.

| Route | Principal | Result |
|---|---|---|
| `POST /teams`, `POST /games` | signed organizer | team/game |
| `POST /games/{id}/viewer-links` | organizer | opaque signed viewer URL |
| `GET /watch/{opaque}` | anonymous link holder | bootstrap: game display + short subscriber/state capability |
| `POST /games/{id}/broadcast-sessions` | broadcaster | epoch, publish capability, relay profile |
| `POST /games/{id}/camera-contributions` | invited parent | pending camera contribution request |
| `POST /games/{id}/camera-contributions/{id}/approve` | organizer/director | camera capability and assigned camera ID |
| `POST /games/{id}/director` | director | selected camera/presentation decision |
| `POST /games/{id}/scorekeeper-sessions` | organizer | scorekeeper capability |
| `POST /games/{id}/commands` | broadcaster/scorekeeper | accepted event + sequence |
| `GET /games/{id}/events?after=` | permitted viewer | ordered history/snapshot |
| `POST /games/{id}/moments` | permitted viewer | deduplicated save acknowledgement |
| `POST /games/{id}/catch-up` | permitted viewer | ordered replay windows from timeline moments |
| `GET /replays/{eventId}` | permitted viewer | short replay manifest capability |
| `POST /highlights/{id}/delete` | org admin | tombstone + async R2 deletion |

Capabilities are compact signed JWT/PASETO-style bearer tokens with `sub`,
`gameId`, `epoch`, `scopes`, `jti`, `exp`, and link/session binding.  Scopes are
`watch:state`, `watch:media`, `publish:main`, `publish:angle`, `score:write`,
`director:write`, `replay:read`, and `admin:recording`. The Worker exchanges the opaque URL once for a 10-minute
subscriber token; publisher tokens last 5 minutes and refresh while foreground.
Use one capability per client, short expiry, revocation lookup/bloom cache, and
redacted logs—Cloudflare documents relay tokens in URL paths can reach logs.

## 10. State machines

### Broadcaster

`IDLE → permissions → preview → preparing_session → connecting → live →
reconnecting → live`; terminal `ending → ended` or `failed`.

`live` substates: `healthy | constrained | audio_state | state_only` and
`foreground | interrupted | background_grace`. Start is enabled only after
camera/mic/thermal/storage preflight and capability acquisition. An interruption
stops camera safely, emits status, retains clock authority, retries on return;
no hidden background capture. Network failure freezes outgoing media queues,
maintains newest IDR/ring, refreshes capability, reconnects with jittered
backoff, announces a new `streamGeneration`, and resumes from live edge.

### Viewer

`bootstrap → capability_check → connecting_state + connecting_media → live`;
media may be `unsupported`, while state remains usable. `live ↔ replaying`;
`reconnecting → live` always discards old decode buffers and seeks latest IDR.
`ended → postgame` loads durable event/highlight data.  The state socket requests
a snapshot on epoch/sequence mismatch.  A permanent media failure presents the
fallback transport where available—not a silent spinning player.

## 11. Quality, reconnection, and clocks

Use a conservative control loop every 1 second using packet loss, RTT,
send-queue age, encoded FPS, dropped-frame count, decoder queue, battery,
thermal state, and measured edge lag. Change one rung at a time with hysteresis:

`1080/720 → 720 1.5 Mbps → 540 900 kbps → 360 500 kbps → 15 fps → audio+state
→ state only`.  Upgrade only after 10 seconds stable; downgrade after sustained
2 seconds congestion/queue deadline breach. Keyframes/config are sent after
each rung change.

Viewer compatibility ladder: (A) direct WebTransport + WebCodecs MoQ, the
premium <1-second path; (B) MoQ client WebSocket fallback with tight discard
deadlines but no low-latency promise; (C) authenticated LL-HLS H.264/AAC native
`<video playsinline>` compatibility rendition when enabled; (D) state-only.
Each viewer probes transport, H.264 video/audio decoder configuration, actual
relay connection and audio output, then records its tier. Start browser video
muted; audible Safari playback needs user activation. Tier C needs a separate
packaging/gateway feasibility decision and is not a free fallback from a
MoQ-only relay.

Clock authority is DO state `{running, period, accumulatedMs, anchorUnixMs}`;
clients render from local monotonic time and reconcile gently. `pause/resume/set`
is a sequenced command, not a timer interval, so DO hibernation cannot corrupt
time. Target event propagation <500 ms is measured command-tap to PWA receipt.

### One-phone scoring and contributed angles

The broadcaster UI supports `OUR GOAL`, `THEIR GOAL`, `SAVE`, and `HIGHLIGHT`
without leaving the camera. One tap atomically updates score, creates the event,
records its game timestamp, bookmarks replay, and updates state/overlays. A
dedicated scorekeeper remains an optional advanced role.

Later, a parent opens an approved QR/private contribution link and requests a
camera role. Director approves or rejects it; approved camera IDs publish under
the active epoch. Default quality allocation is:

```text
main selected:      720p/selected ladder
unselected angles:  low-bitrate preview
selected alternate: promoted on subscriber/director interest
```

### Live-first recovery and archive reconciliation

On a cellular loss, live reconnects at current edge and records an
`archive_gap` range. The device may later upload retained GOPs through a
background, rate-limited reconciliation job. Live viewers never wait while
missing historical media is backfilled.

## 12. Security and privacy threat model

| Threat | Mitigation |
|---|---|
| link forwarding/replay | opaque high-entropy links, short capability exchange, expiry/revoke, optional max sessions |
| token exposure in URLs/logs | per-client short token, no query strings, scrub logs/analytics/referrers, `Referrer-Policy: no-referrer` |
| unauthorized score/control | role scopes, session-bound commands, server-side DO authorization, idempotency and audit trail |
| publisher hijack | short publish capability, device/session binding, one active main publisher, rotation on reconnect |
| replay/highlight disclosure | same game authorization, private R2 keys, signed retrieval, deletion propagation/lifecycle |
| malicious events/replay range | schema/range validation, rate limits, server-derived capture bounds |
| abuse/DoS | WAF/rate limits, capability verification before DO upgrade, per-game viewer caps and backpressure |
| youth exposure | unlisted default; no public locations, names optional, no chat/recognition, admin deletion/export workflow |
| telemetry privacy | coarse network metrics, rotating anonymous viewer ID, no raw IP/location/device identifiers in product analytics |

Security tests include capability tampering, revoked link, cross-game resource
access, duplicate/reordered commands, replay authorization, token-log scan, and
deletion verification. Obtain counsel review for COPPA/FERPA/state league rules;
this design is not legal compliance advice.

## 13. Observability and SLO evidence

Correlate `gameId, epoch, streamGeneration, publisherSessionId, viewerSessionId`
(viewer ID privacy-preserving) across traces.  Emit: startup time, capture→encode,
publish queue, relay-to-decode, decode→render, live-edge lag, event tap→viewer,
replay request→first frame, ring coverage, reconnect attempts/duration,
quality-rung/thermal/battery, state gaps, media-index lag/coverage,
event→media-correlation error, Catch Me Up completion, camera promotion state,
archive-gap age, and destination health.

Dashboards: per-game operations view; aggregate SLO view segmented by OS/browser,
carrier/network type, relay profile and app version; privacy/deletion jobs.
Alerts: no publisher heartbeat, state sequence stalls, p95 edge lag >2 s,
replay availability >5 s, elevated crash/thermal or capability failures.  Use
synthetic relay compatibility tests on each pinned draft before release.

## 14. Test strategy

* **Unit:** score/clock reducer, event sequencing/idempotency, token scopes,
  ring eviction/window selection, replay manifest construction, quality policy.
* **Contract:** generated API schemas; each `LiveMediaTransport` must pass the
  same publish/subscribe/reconnect/edge tests.
* **DO integration:** concurrent scorekeeper commands, hibernation/restart,
  WebSocket snapshot recovery, D1 projection retries.
* **Media integration:** golden H.264/AAC fragments across Android/iOS and
  Chrome/Edge/Firefox/Safari, event-to-capture correlation, decoder reset.
* **Network chaos:** loss, reorder, bandwidth clamp, captive portal, airplane
  mode, relay reset and IP/cell-Wi-Fi handoff. Assert state remains current and
  stale video is discarded.
* **Field/UX:** timed <30-second setup and <3-second viewer start, sunlight,
  gloves/one-hand controls, 90-minute thermal/battery runs, interruption tests.
* **Security/performance:** pen test capability/link boundaries, load DO state
  fan-out and replay saves, soak a game with viewers.  Real-field acceptance,
  not emulator-only, is release gating.

## 15. Dependency graph

```text
S0 timeline + transport proof ──┬── S1 Game Core + links ──┬── S2 one-phone broadcast
                                 │                           ├── S3 indexed live DVR/event replay
                                 │                           │    ├── S4 highlights + Catch Me Up
                                 │                           │    └── S5 field recovery + archive gaps
                                 ├── S6 media-gateway feasibility ─► external destinations
                                 └── S8 contributed-angle prototype
S1 + S2 + S3 + S4 + S5 + S6 ─────────────────────────────────► S7 pilot
```

## 16. Sprint backlog and acceptance criteria

### Sprint 0 — Transport spike (2 weeks; go/no-go) **(Completed)**

1. Establish Game Timeline v1: DO epoch/clock anchor, monotonic game timestamp,
   media PTS correlation record, and timestamp→group/object Replay Index fixture.
2. Native iOS and Android H.264/AAC capture/encode → chosen MoQ draft relay;
   browser WebTransport/WebCodecs receive/render path.
3. Instrument timestamp chain and test 720p30, 1–5% loss, 200 ms RTT,
   0.5–3 Mbps, reconnect; document device/browser table including current iOS
   Safari.
4. Validate fMP4/CMAF/elementary framing, keyframe join, capabilities and a
   browser transport fallback (WebRTC SFU or supported alternate).
5. Prototype a 3-minute indexed GOP ring, `↶10`, and event timestamp→replay
   navigation while the live subscription advances independently.

**Exit:** two real phone models/platforms to two target browsers achieve median
<1 s and p95 <1.5 s good-network edge lag; state remains <500 ms; a goal has
a resolvable media location across the tested camera; reconnect jumps live; and
replay first frame ≤2 s. Otherwise record cause and choose the fallback
transport before S1.

### Sprint 1 — Game foundation (2 weeks) **(Completed)**

Team/game CRUD, organizer auth, opaque expiring links, Game Core DO state
socket, scorekeeper join, one-phone score/clock/goal/save/highlight commands,
event timeline with game timestamps, D1 durable projection/audit, and the first
Netlify deployment of the viewer/control-plane shell.

**Accept:** anonymous private link has current state in <3 s; two scorekeepers
cannot create divergent state; event p95 propagation <500 ms; revoked link and
cross-game requests fail; Netlify production build reaches the Worker with the
configured API origin while MoQ media remains a direct browser→relay path.

### Sprint 2 — Real broadcast (3 weeks) **(Completed)**

Native broadcaster flow, preflight, one-tap Start Live, adaptive encoder,
viewer player, health UI, camera/encoder recovery, reconnection and
no-stale-edge rules. Ensure score/event controls remain usable over camera.

**Accept:** trained organizer starts in <30 s; viewer starts <3 s on supported
path; quality ladder maintains state during imposed congestion; temporary outage
automatically resumes current live edge.

### Sprint 3 — Replay (3 weeks) **(Completed)**

Three-minute target ring buffer, timestamp correlation, event bookmark/replay
navigation, concurrent live/replay player behavior, return-to-live, anonymous
Save Moment merge, and a deterministic Catch Me Up sequence spike.

**Accept:** 3-minute coverage target (≥60 s minimum on constrained early
devices); goal tap shows `T−12s` decodable pre-roll within ~2 s; live
subscription/state stays current during replay; LIVE never plays stale backlog;
duplicate saves merge; Catch Me Up can chain existing event windows without a
render job.

### Sprint 4 — Persistence (2 weeks) **(Completed)**

R2 immutable selected highlights/manifests, D1 index, postgame page, private
sharing, retention configuration, archive-gap reconciliation, and admin
deletion.

**Accept:** selected highlight remains playable after game; deletion revokes
delivery and completes storage cleanup; no raw recording required by default.

### Sprint 5 — Field hardening (3 weeks) **(In Progress)**

Carrier matrices, thermal/battery, 90-minute games, phone call/app interruption,
Wi-Fi↔cell handoff, adverse loss/throughput, live-first encoder recovery,
archive-gap backfill isolation, operational playbook.

**Accept:** no state divergence; recovery after every tested temporary break;
documented supported device/network envelope; field targets are met in 80%+ of
measured good-condition sessions before pilot.

### Sprint 6 — Distribution (2–3 weeks) **(Completed)**

Ship URL sharing first.  Separately spike and then build containerized
MoQ/SFU-subscriber→RTMPS `BroadcastDestination`, secure destination credential
vault, lifecycle/health, score/clock compositor.  Add Facebook only after its
current API/permissions are verified; reuse adapter for YouTube later.

**Accept:** phone publishes once; gateway can start/stop/retry destination
without affecting primary stream; overlay correctness and destination failure
isolation verified. This is explicitly non-blocking for pilot.

### Sprint 7 — Pilot (4 weeks)

Onboarding, consent/admin controls, instrumentation review, support runbook and
5–10 invited teams across real matches.

**Accept:** metrics prove setup/viewer/latency/replay/recovery targets or yield
a prioritized remediation list; zero unresolved privacy/security P0s; pilot
admins can delete recordings/highlights.

### Sprint 8 — Contributed angles (post-pilot feature flag)

QR/private join flow, admin approval, `publish:angle` capabilities, low-rate
preview rendition, interest-driven promotion, director choice, and synchronized
event replay across main plus one alternate camera.

**Accept:** an approved parent joins without a team-management account; no
viewer selects the angle → it remains preview quality; selection promotes it
without interrupting main; one event resolves aligned replay locations on both
cameras. This sprint is not a dependency for the first pilot.

### Sprint 9 — AI Tracking & Advanced Statistics

Integrate player identity/biometrics, real-time AI ball and player tracking, and automated advanced statistics generation.

**Accept:** AI models successfully track primary action and key players without manual input; statistics are surfaced in real-time to the timeline and viewer UI.

### Sprint 10 — Advanced Highlights & Automated Catch Me Up

Implement automated Catch Me Up selection driven by AI and viewer saves. Build out chat/comments, public game discovery, and advanced team management features.

**Accept:** Late viewers automatically receive an intelligent Catch Me Up reel. Public games are searchable, and viewers can interact via real-time chat/comments.

### Sprint 11 — Tournaments & Broad Team Management

Support multi-game tournament brackets, broad team management across seasons, and complex event structures.

**Accept:** Organizers can create tournaments, link multiple games, and users can track progression across brackets seamlessly.

### Sprint 12 — Cloudflare Jev-Powered Decision Layer

Incorporate Jev as a real-time AI decision fabric for multi-camera broadcasting and game intelligence. Jev acts as an AI Assistant Director (recommendation-only initially) and does NOT process raw video directly. It consumes compact structured metadata from separate vision, audio, and game-state systems.

Target architecture:
Camera/video/audio/game state
→ lightweight CV / vision / OCR / audio analysis
→ normalized per-camera metadata
→ Cloudflare Worker
→ Jev decisions
→ broadcaster UI, automation, clips, notifications, or escalation

**Accept:** Telemetry schema is implemented, Worker endpoints consume metadata, Jev models ingest telemetry to produce reliable switching, highlighting, and operational recommendations without processing raw media.

### Website follow-on backlog (after current MVP path)

1. **Organizer setup:** authenticated team creation, team/game dashboard, game
   link issuance, and lifecycle controls.
2. **Contributor approval:** QR/private contribution request, organizer approve/
   reject, camera capability issuance, and contribution health.
3. **Director surface:** camera roster, selected presentation camera, preview
   quality policy, and synchronized multi-angle event replay.

These features require Worker authorization and D1/DO contracts first. A
Netlify deploy alone does not make them available, and no website feature may
proxy or wrap the working MoQ media session.

## 17. Sprint-0 parallel work packets

| Lane | Owner/output | Depends on |
|---|---|---|
| A — iOS native ingest | Swift capture/VideoToolbox encoder + fragment callback benchmark | relay profile only |
| B — Android native ingest | CameraX/MediaCodec encoder + same benchmark | relay profile only |
| C — browser player | WebTransport/WebCodecs MoQ player, capability matrix and fallback selector | relay profile/framing fixture |
| D — relay/protocol | pin draft, token-mint test service, namespace/framing interop harness | Cloudflare account |
| E — measurement/chaos | timestamp schema, network impairment scripts, latency dashboard/report | fixture endpoints |
| F — timeline/replay feasibility | game timestamp correlation, 3-minute GOP ring index, event→media lookup and local replay spike | native fragment fixture + Game Core fixture |
| G — game core | clock anchor/event schema, timeline reducer, media-location contract fixture | no media dependency |

Integrate A+B+C+E into one end-to-end run; D is a prerequisite for their hosted
test, while F and G can run against recorded encoded fixtures. Assign one integrator
to decide the profile/fallback from the common acceptance report—parallel lanes
must not independently choose different drafts or framing.

## Sources

1. Cloudflare, [Media over QUIC](https://developers.cloudflare.com/moq/) (accessed September 2026): beta relay, supported drafts, isolated relay scope and URL-token warning.
2. Cloudflare, [MoQ Feature Matrix](https://developers.cloudflare.com/moq/feature-matrix/) (accessed September 2026): current absent FETCH, GOAWAY and SUBSCRIBE_UPDATE.
3. IETF, [draft-ietf-moq-transport](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/) (active Internet-Draft, accessed September 2026): MOQT object model, QUIC/WebTransport, priority, authorization and draft volatility.
4. Cloudflare, [Durable Objects](https://developers.cloudflare.com/durable-objects/) (accessed September 2026): globally named stateful objects, strongly consistent attached storage and WebSocket hibernation.
5. Cloudflare, [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) (accessed September 2026).
6. MDN, [WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API) and [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) (accessed September 2026).
7. MDN, [Codec selection](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection) (accessed September 2026): AVC compatibility and exact WebCodecs codec configuration.
8. Cloudflare, [Realtime SFU](https://developers.cloudflare.com/realtime/sfu/) (accessed September 2026): compatibility fallback surface.
9. Cloudflare, [Stream simulcasting](https://developers.cloudflare.com/stream/stream-live/simulcasting/) (accessed September 2026): third-party RTMP destination capability.
10. IETF, [Low Overhead Container for MoQ](https://datatracker.ietf.org/doc/draft-ietf-moq-loc/) and [C4M authorization](https://datatracker.ietf.org/doc/draft-ietf-moq-c4m/) (active Internet-Drafts, accessed September 2026): candidate packaging and authorization designs, neither committed for MVP.
