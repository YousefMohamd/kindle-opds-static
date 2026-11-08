# Telegram group-join report (slow join, v0.4.6)

Run at 2026-11-08T03:27:08.107884+00:00 — batch: up to 3 groups per run, every 12 h (~6 groups/day).

Joined: 0 | already a member: 0 | failed: 0 | stopped by a flood wait on @All_kinds_Books_Lib (49211s)

## Flood wait

Telegram rate-limited the account on @All_kinds_Books_Lib (49211s). The run stopped immediately; the wait is recorded in `join-state.json` (until 2026-11-08T17:07:18.965551+00:00) and the next scheduled run retries after it expires.

## Overall progress

- joined: 0
- already_member: 0
- pending: 167
- failed: 0
- flood_wait: 1
- total groups: 168

The newly joined groups are indexed by the same run's API backfill step (`tbi api-backfill --channel <name> --backfill --backfill-block 3000`) and published with the catalogue; see `index-report.md` for the indexed posts.
