# /api/reading-sync — decision: NOT built (Area 2 review, 2026-11-14)

The reader (`site/reader/reader.js`) queues highlights and reading
progress on the device and POSTs them to `/api/reading-sync` when the
user is logged in. That endpoint does not exist, and the reader says
so honestly ("Saved on this device. Account sync is not live yet —
your highlights are safe here") and keeps the queue. Nothing is lost.

## Decision

Do NOT build the endpoint yet. Building it now would be worse than
not having it, for one reason: **there is no verified identity.**

## Why not (each is a blocker, not a polish item)

1. **No server-side identity verification.** Login today is
   client-side only (`site/reader/auth.js`):
   - Google: the ID token is decoded in the browser only to read the
     name/email; it is never verified server-side (and no Google
     client ID is configured — `site/reader/config.js` is empty).
   - Telegram: the Login Widget payload is accepted locally and
     marked `verified: false` — the server must verify it against
     the bot token before any sync trusts it, and that verification
     does not exist anywhere yet.
   - An endpoint that accepts `{ user: { id: "telegram:123" }, items:
     [...] }` at face value lets anyone read or overwrite anyone
     else's highlights and progress by asserting their id. That is a
     privacy and integrity hole, not a missing feature.
2. **No storage decision.** KV vs D1, key/table shape, per-user
   quotas, retention and deletion are all undecided. KV free tier
   allows 1,000 writes/day — a sync write per page turn would blow
   that quickly; D1 needs a schema and a migration. Picking one
   inside a review, without the coordinator, would lock in the
   wrong shape.
3. **No login backend at all.** Google client ID not configured,
   BotFather `/setdomain` step not done, the bot's `?start=login`
   handler not built. There is no account to sync *to* yet.
4. **Current behaviour is already honest and lossless.** The queue
   stays on the device, the reader names the state in one line, and
   nothing the user does today depends on the endpoint existing.

## What is needed to build it later (in order)

1. **Server-side verification (first, non-negotiable):** verify the
   Google ID token (tokeninfo / JWKS) or the Telegram widget payload
   (HMAC with the bot token) inside the Function, using a secret
   stored in Pages — never trust the `user` object the browser sends.
   Until this exists, the endpoint must not exist either.
2. **Storage choice + schema:** D1 table (suggested:
   `user_id, book_key, kind, cfi, text, color, pct, updated_at`) or
   KV keys per user; plus a per-user write limit and a delete path
   (the user must be able to erase their synced data).
3. **Sync protocol:** GET to pull state onto a new device, POST to
   push the queue, last-write-wins per highlight/progress item, and
   an idempotency rule so a retried POST cannot duplicate a
   highlight. The reader currently POSTs the whole queue on every
   queue event with no debounce — that needs a flush debounce and a
   backoff before it talks to a real endpoint.
4. **Login setup steps (user/coordinator):** Google client ID in
   `site/reader/config.js`, BotFather `/setdomain` → rlibook.tech,
   bot `?start=login` handler.
5. **Tests:** unverified user → 401; one user cannot read/write
   another user's items; retry does not duplicate; queue clears
   only on a confirmed store.

## What was checked in this review (no change made)

- The reader degrades correctly today: 404 from the missing
  endpoint keeps the queue and shows the honest line; offline and
  other failures show "will try again later". No reader change was
  needed, and none was made.
- `site/reader/reader-lib.js` keeps `SYNC_ENDPOINT =
  "/api/reading-sync"` so the wiring is ready when the endpoint
  lands.
