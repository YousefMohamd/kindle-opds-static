# Telegram group-join report (slow join, v0.4.6)

Run at 2026-11-27T20:30:58.448333+00:00 — batch: up to 2 groups per run, every 12 h (~4 groups/day).

Joined: 1 | already a member: 0 | failed: 1

## Newly joined

- @abo_abdu — folder: added

## Failed (recorded, never retried automatically)

- @ahn1972: join failed: The authorization key (session file) was used under two different IP addresses simultaneously, and can no longer be used. Use the same session exclusively, or use different sessions (caused by JoinChannelRequest)

To retry one, set its `status` back to `pending` in `join-state.json`.

## Overall progress

- joined: 35
- already_member: 31
- pending: 104
- failed: 2
- flood_wait: 0
- total groups: 172

The newly joined groups are indexed by the same run's API backfill step (`tbi api-backfill --channel <name> --backfill --backfill-block 3000`) and published with the catalogue; see `index-report.md` for the indexed posts.
