# Telegram group-join report (slow join, v0.4.6)

Run at 2026-11-28T19:22:35.299807+00:00 — batch: up to 2 groups per run, every 12 h (~4 groups/day).

Joined: 1 | already a member: 0 | failed: 1

## Newly joined

- @ahn2323 — folder: added

## Failed (recorded, never retried automatically)

- @alanbyawardmsr: join failed: The authorization key (session file) was used under two different IP addresses simultaneously, and can no longer be used. Use the same session exclusively, or use different sessions (caused by JoinChannelRequest)

To retry one, set its `status` back to `pending` in `join-state.json`.

## Overall progress

- joined: 36
- already_member: 31
- pending: 102
- failed: 3
- flood_wait: 0
- total groups: 172

The newly joined groups are indexed by the same run's API backfill step (`tbi api-backfill --channel <name> --backfill --backfill-block 3000`) and published with the catalogue; see `index-report.md` for the indexed posts.
