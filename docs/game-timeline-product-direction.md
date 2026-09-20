# Product Direction — The Synchronized Game Timeline

## Product thesis

The game is the product; video is one synchronized data source inside it.

Every score, clock change, event, camera object, audio frame, replay request,
and viewer save belongs to `{gameId, epoch, gameTimestampMs}`. This is the
product invariant that makes the experience distinct from a conventional live
stream with separate scoring and clipping tools.

## The defining experience

```text
12'          19'             27'            NOW
────⚽───────────⭐───────────────⚽──────────────●

↶10     CATCH ME UP     LIVE     SAVE MOMENT
MAIN | GOAL CAM | SIDELINE
```

* **Live DVR:** replay is navigation of retained encoded media, not a clip job.
* **Event replay:** selecting `GOAL 31:14` opens roughly `31:02 → 31:22`.
* **Catch Me Up:** late viewers watch selected existing event windows, then
  arrive at live edge; no AI or MP4 render is required initially.
* **One-phone game control:** scoring creates score state, a timeline event,
  replay bookmark, and social-overlay input in one action.
* **Contribute an Angle:** approved parents join a camera source, not a sports
  management system. Cameras share the same replay timestamp.

## Non-negotiable rules

1. Live freshness wins. Never transmit missing or queued historical video ahead
   of current edge after reconnect.
2. Archive completeness is separate. Retained missing ranges may backfill after
   the game without consuming the live budget.
3. Replay and clip export are separate. A replay reads indexed rolling GOPs;
   only save/share materializes a permanent asset.
4. State survives media degradation. Score/clock/events are P0 and remain
   current through every quality rung.
5. Anonymous spectators are first-class. Private browser links require no app,
   account, roster claim, or public game discovery.

## MVP decision

MVP is not “basic stream, then replay later.” It includes Game Timeline v1 and
indexed rolling replay from the first transport milestone. The engineering
floor is 60 seconds of retained media; the MVP product target is three minutes,
with a five-minute architectural ceiling.

Catch Me Up, camera contribution, director mode, selective angle promotion, and
archive reconciliation are sequenced extensions of the same invariant. They do
not change the core model later.
