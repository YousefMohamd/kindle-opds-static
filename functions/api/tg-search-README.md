# Telegram-catalog search endpoint — `GET /api/tg-search`

Server-side search over the Telegram catalog (321,448 distinct books,
51 channels + 168 groups) so the bot's `/search` can include Telegram
books. Built 2026-11-12 (Task 2 of 3). **Not deployed yet** — this file
is the deploy + contract reference.

## Contract

```
GET /api/tg-search?q=<query>&limit=<n>&offset=<n>
```

| Param | Required | Default | Notes |
|---|---|---|---|
| `q` | yes | — | Book title and/or author. Empty `q` returns an empty result set (200). |
| `limit` | no | 10 | Clamped 1..50. |
| `offset` | no | 0 | Clamped 0..10000. |

Success (200):
```json
{
  "ok": true,
  "q": "Everyone in This Bank Is a Thief",
  "total": 1,
  "limit": 10,
  "offset": 0,
  "results": [
    {
      "title": "Everyone in This Bank Is a Thief",
      "author": "Benjamin Stevenson",
      "source": "kotobkhana",
      "kind": "channel",
      "formats": ["EPUB"],
      "url": "https://t.me/kotobkhana/7559",
      "flagged": false
    }
  ]
}
```

(Real response from the local test run against the published shard.)

- `title`: display title (original, never normalized).
- `author`: display author, or `null` when unknown.
- `source`: channel/group name; `kind`: `"channel"` or `"group"`.
- `formats`: the format(s) actually available for the linked file
  (Telegram books have one file each, so one element, e.g. `["PDF"]`).
- `url`: the t.me post link (the only way to get the book).
- `flagged`: `true` when the book is flagged/commercial (see below).
- `total`: full match count (may exceed `results.length`).

Errors (JSON `{ ok: false, error }`):
- `503` — `TG_D1` not bound (D1 database missing).
- `500` — search failed (message included).
- `405` — non-GET method.
- Empty `q` is NOT an error (200, empty results).

Search semantics: title AND author, Arabic-normalized (NFKC, strip
tashkeel/tatweel, unify alef/hamza/yeh, `ة->ه`, `ى->ي`, lowercase),
and a leading `ال` stripped from a word when ≥3 chars remain (so
`كاتب` matches `الكاتب`). All query words must appear (FTS5 AND).
If the AND finds nothing, the endpoint retries with the longest word
alone. Results are ordered by FTS5 rank (best match first). Response
is metadata + links only — no book file bytes, ever.

Data-model note: one Telegram post can hold several book files (a
trilogy in one post), so the dedup key is `(url, filename)`, not the
post URL alone — 15 URLs in shard 0 map to 2–3 books each. The D1
schema stores `filename` and enforces `UNIQUE(url, filename)`; the
population script keys its incremental state file the same way.

## Flagged (commercial) books

The endpoint **identifies** flagged books; it does **not** enforce the
cap. For each result it checks the shared KV denylist — the same
mechanism as `functions/api/dl-token.js`: a KV key
`flag:<handle>:<post_id>` means flagged/commercial. Handle + post_id
come from the result's t.me URL. The **bot** enforces the 3/day
successful-flagged-search cap and the invite-unlocks-3-more rule.
If `RLIBOOK_KV` is not bound, or no flag key exists, `flagged` is
`false` — the honest v1 limit ("not flagged" = "not on the denylist").
Block 7 populates the `flag:` keys from the bot's `flags.ts` list;
until then the bot's own `matchFlagged` check on the query remains the
primary flag gate.

## Why D1 (architecture)

| Approach | Verdict |
|---|---|
| Pages Function loads the shards | **No.** Shards are ~19 MiB each (64 MiB total). JSON.parse of 19 MiB is ~40–200 ms CPU; the free tier allows 10 ms/request. |
| HTTP Range fetch of one record | **No.** Verified 2026-11-12: the Pages CDN ignores `Range` and returns the whole file (HTTP 200, full size). |
| Pre-built inverted index (static) | **No.** The word→book index is 13.3 MB, but answering needs the full record, and duplicating it per word is ~250 MB — far over the 16 MiB snapshot-push deploy limit. |
| **D1 + FTS5** | **Yes.** One small indexed query, ~10–100 rows read (5M/day free). Storage ~81 MB for 321k books (500 MB/database cap). The indexer already uses SQLite FTS5, so semantics match. |

Free-tier numbers (Workers Free, verified 2026-11-12):
- D1 reads: 5,000,000 rows/day — a search reads ~10–100 rows.
- D1 writes: 100,000 rows/day — the **only** constraint, and only
  for the initial population (see below). Incremental sync is a few
  thousand rows/day and fits easily.
- D1 storage: 5 GB total, 500 MB per database — the catalog is ~81 MB.
- Pages Functions: 100,000 requests/day; this endpoint does one D1
  query + up to `limit` parallel KV gets per request.

## Deploy (exact steps)

Do these in order. Nothing here deploys itself.

### 1. Create the D1 database (once)

```bash
npx wrangler d1 create rlibook-tg
# note the database_id it prints; keep it for step 2 if you use wrangler.toml,
# otherwise the dashboard binding below is enough.
```

### 2. Apply the schema (once)

```bash
wrangler d1 execute rlibook-tg --remote \
  --file functions/api/tg-search-schema.sql
```

### 3. Bind it to the Pages project (once, dashboard)

Cloudflare dashboard → Pages → `kindle-opds-static` → Settings →
Functions → **D1 database bindings** → Add binding:
- Variable name: `TG_D1`
- Database: `rlibook-tg`

Same page → **KV namespace bindings** (if not already there):
- Variable name: `RLIBOOK_KV`
- Namespace: the same one the bot + OPDS feed use (the one holding
  `fp:*`, `priv:*`, `flag:*` keys).

No `wrangler.toml` change is needed — this repo configures bindings
in the dashboard, like the existing Functions.

### 4. Populate D1 (batched, ~7 days on the free tier)

```bash
# Generate batches (newest books first, 2,000 books = ~4,000 rows each):
python3 telegram/tbi/d1_sync.py --full --out-dir d1-batches
# -> 161 batch files for the full catalog (321,448 books).

# Import at most 25 files per day, IN ORDER
# (25 × 2,000 books = 100,000 rows = the daily free-tier write budget):
for f in d1-batches/batch-0001.sql d1-batches/batch-0002.sql; do
  wrangler d1 execute rlibook-tg --remote --file "$f"
done
# (repeat with the next 25 files the next day, and so on.)
```

Files are 2,000 books each on purpose: `wrangler d1 execute --file`
is known to fail with "Network connection lost" on files with 5000+
INSERT statements, so each file stays at 4,000 statements. Day 1
already loads the newest ~50k books, so the endpoint is useful
immediately; the rest follow. There is no paid step.

### 5. Deploy the site (push the repo)

Push `functions/api/tg-search.js` (+ this README + the schema +
`telegram/tbi/d1_sync.py`) to `main` the usual way (snapshot-push).
Pages auto-deploys; the endpoint goes live at
`https://rlibook.tech/api/tg-search`. Verify:

```bash
curl -s "https://rlibook.tech/api/tg-search?q=Everyone%20in%20This%20Bank%20Is%20a%20Thief&limit=3"
```

### 6. Incremental sync (after each daily catalog sync)

```bash
python3 telegram/tbi/d1_sync.py --incremental --out-dir d1-batches \
  --state d1-state.txt
wrangler d1 execute rlibook-tg --remote --file d1-batches/batch-0001.sql
# (append the imported URLs to d1-state.txt — see d1_sync.py --help)
```

## Tests (run before deploying)

```bash
# Endpoint contract + search + flags, against a local SQLite built
# from the real published shard (no network, no production D1/KV):
node functions/api/tg-search.test.mjs
# -> 25 passed, 0 failed (2026-11-12)

# Population script end-to-end (schema + one generated batch -> the
# real endpoint finds the books, normalization matches):
node verify-population.mjs        # (in the task working dir)
```

## What is NOT done yet (improve after building)

- **Bot wiring (separate task, not this endpoint):** the bot's
  `/search` must call `/api/tg-search` in addition to `/opds/search`,
  merge the two result lists, and apply the flagged flow (3/day cap +
  invite-unlocks-3-more) to Telegram flagged results. The endpoint
  only returns `flagged`; the bot enforces the cap.
- **Full D1 population:** the initial load is batched over ~7 days
  (free-tier write limit). The endpoint works on whatever is loaded.
- **Block 7 flag feed:** the `flag:` KV keys are not populated yet;
  until Block 7 runs, `flagged` is false for all results and the bot's
  own `matchFlagged` is the only flag gate.
- **Deletions:** if a Telegram post is deleted, the catalog sync does
  not remove the book from D1 yet. A delete pass is a follow-up.
- **Ranking tuning:** results are FTS5 rank order. If users report
  odd ordering, consider boosting exact-title matches or newest-first.
- **"Did you mean" in the endpoint:** the endpoint retries with the
  longest word only. The bot's own `suggestSearch` handles the rest.
