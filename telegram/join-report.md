# Telegram group-join report (slow join, v0.4.6)

Run at 2026-11-24T07:41:33.445302+00:00 — batch: up to 2 groups per run, every 12 h (~4 groups/day).

Joined: 0 | already a member: 1 | failed: 1

## Already a member (no join sent)

- @scincematerialsMH — folder: added

## Failed (recorded, never retried automatically)

- @ArabicMagazine: join failed: The authorization key (session file) was used under two different IP addresses simultaneously, and can no longer be used. Use the same session exclusively, or use different sessions (caused by JoinChannelRequest)

To retry one, set its `status` back to `pending` in `join-state.json`.

## Overall progress

- joined: 32
- already_member: 29
- pending: 110
- failed: 1
- flood_wait: 0
- total groups: 172

The newly joined groups are indexed by the same run's API backfill step (`tbi api-backfill --channel <name> --backfill --backfill-block 3000`) and published with the catalogue; see `index-report.md` for the indexed posts.
