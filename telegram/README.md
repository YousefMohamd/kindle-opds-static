# telegram-book-index (v0.4.7 — merged into kindle-opds-static)

Standalone index of **books shared in public Telegram channels and groups**,
so you can search across all of them by title or author.

```text
tbi index                      # index every source in channels.yaml
tbi search "ألف ليلة وليلة"    # search across all sources
tbi search "Hemingway" --format pdf
tbi sources                    # show sources and how far each was indexed
tbi search-channel --channel ekraly --query "Dune"   # targeted search + priority queue
tbi api-backfill --channel ekraly   # OPTIONAL, manual-only: full history via the API
tbi join-groups                      # SCHEDULED-ONLY, slow: join a few groups per run + add them to the 📚كتب folder
tbi submit-book --source https://t.me/testchan/42 --title "Dune"   # index one book
```

**No Telegram API credentials by default. No server. No background process.**
On-demand CLI only: it opens a local SQLite file, does its work, exits.
The API backfill (below) is an **optional, manual-only** path — it needs
credentials, but only as GitHub Actions secrets, and it never runs on a
schedule.

This tool lives **inside the main project repo**
[`YousefMohamd/kindle-opds-static`](https://github.com/YousefMohamd/kindle-opds-static)
under `telegram/` (tool + config), with its published section at
[`kindle-opds-static.pages.dev/telegram/`](https://kindle-opds-static.pages.dev/telegram/)
(`site/telegram/` in the repo, reached through the root `_redirects`
rewrite — the repo's Pages project serves the repo root, so the
Telegram section is a sub-path of the same site, not a new site or
domain). The same index is also published as a **static site** (search
page + run report, no server) by a scheduled GitHub Actions job — see
[Cloud publish](#cloud-publish-static-site-daily-sync) below. The site
is the read-only front end; the CLI stays the only way data gets in.

## How it works

There are two kinds of sources, because Telegram gives them two different
surfaces:

| Source | How it is indexed |
|---|---|
| **Public channel** (`t.me/…`) | Live scrape of the public web preview (`t.me/s/…`), newest → oldest via `?before=` paging. |
| **Public group** (`t.me/…`) | **Not live-scraped** — groups have no public preview. Indexed from a **Telegram Desktop JSON export** (see below). |

Every result is **metadata only** — filename, format, size, source, date,
and the `t.me` permalink. The file itself is obtained in Telegram; the
index never downloads books.

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -e .
# or: pip install -r requirements.txt
# for the optional API backfill only: pip install -e ".[api]"  (adds Telethon)
```

Requires Python 3.9+, `beautifulsoup4`, `pyyaml`. Telethon is an
optional dependency, only for the manual-only API backfill (below).

## Usage

1. Edit `channels.yaml` — add channel links and group exports:

```yaml
channels:
  - https://t.me/durov
  - t.me/telegram        # plain names and @handles work too
groups:
  - name: "Old Arabic Books"
    export: ~/exports/old-arabic-books/result.json
```

2. Index everything:

```bash
tbi index --config channels.yaml
```

Every run writes `index-report.md` next to the DB (channels indexed,
posts, book files, failures with reasons, duration, zero-book
channels, dropped and low-density channels, backfill status, giants) —
the same format as the published report.

3. Search:

```bash
tbi search "Dune"
tbi search "القراءة المثمرة" --format epub
tbi search "Hemingway" --source "Old Arabic Books" --limit 20
```

4. Check coverage:

```bash
tbi sources
tbi classify https://t.me/some-channel https://t.me/some-group
```

5. Incremental, full, and backfill runs (what the scheduled job uses):

```bash
tbi index --new-only   # only posts newer than the stored newest per channel
tbi index --full       # force a full walk, ignoring stored progress
tbi index --backfill --backfill-block 3000   # new posts first, then one
                                             # 3000-post block below the oldest
                                             # indexed post per channel
tbi index --report path/to/report.md   # report location (default: next to the DB)
```

`--new-only` is the daily-sync shape: it never backfills a giant's
history. `--backfill` is the scheduled job's shape (see
[Backfill in blocks](#backfill-in-blocks) below): it also fetches new
posts, plus one capped block of older history per channel per run, so
deep history fills in over successive runs instead of one giant walk.
A first run (no prior state) is a full walk by definition. A run where
**every** source errors exits 1 so a scheduled job stops instead of
publishing nothing new; a partial run (some channels failed) still
exits 0 and publishes what succeeded.

6. Targeted search + priority queue (see [Priority search](#priority-search)):

```bash
tbi search-channel --channel ekraly --query "Dune"
```

7. Build the static site data and check it before publishing:

```bash
tbi export-static --db index.db --out site   # writes site/index.json (+ report)
tbi validate --db index.db --json site/index.json   # DB non-empty, schema + FTS OK, JSON valid
```

## Backfill in blocks

The local first run was capped at the 3000 newest posts per channel
(the 3 giants alone — ekraly 211k, roayati 289k, Sumarians 306k posts —
would take ~22 hours uncapped). `--backfill` finishes that history
gradually, one block per scheduled run per channel:

- **Block size:** 3000 posts per channel per run by default
  (`--backfill-block N` overrides it). The size is a CLI flag, not a
  config setting — the workflow passes it explicitly.
- **Order within a channel:** newest → oldest. Each run first picks up
  posts newer than the stored newest (so the daily sync never misses
  new books), then walks one block below the stored oldest.
- **Completion rule:** a channel is **complete** when a backfill block
  reaches post 1, or when the block returns fewer than the block size
  (the preview is exhausted — it stopped serving posts). The report
  records per-channel backfill status (block posts, oldest reached,
  complete / more remain).
- **After completion:** a backfill run on a complete channel only checks
  for new posts — the same work as `--new-only` — so the workflow can
  be switched to `tbi index --new-only` once the report shows every
  channel complete. Leaving it on `--backfill` is harmless and is the
  default, because a newly-added channel then backfills automatically.
- **Priority first:** channels with pending priority requests (see
  below) are walked before the rest, in request order.

## Priority search

A user asks for a book that is not indexed yet — maybe its channel's
deep history is still being backfilled, or the channel was never added.
The priority path (design + hooks in this version; the bot front-end is
Phase 2):

1. **Targeted search:** `tbi search-channel --channel X --query "..."`
   runs the channel's own server-side search (`?q=<title>`, capped to
   roughly one screen of results) and returns the post link immediately
   when found — **indexing that post** into the DB, so the next search
   finds it locally.
2. **Queue when not found:** when the server-side search finds nothing,
   the (channel, query) pair is queued as a **priority request** in the
   DB (`priority_requests` table — metadata only, never a file). A
   duplicate request for the same book in the same channel is ignored.
3. **Backfill with priority:** the next scheduled `--backfill` run walks
   channels with pending requests first. After a channel's block, any
   pending request whose query now has a hit in that channel is
   **resolved** (the book is indexed, the request is done).
4. **The search page** shows a "not in the index yet" state when a query
   returns zero hits, explaining the book may be in a channel whose
   history is still backfilling, and pointing to the bot (Phase 2) for
   a priority request.

The bot itself is Phase 2 — see [Bot limits](#bot-limits-phase-2-not-built)
below. Until then, a priority request is made by running
`tbi search-channel` (or by the bot once it exists); the queue, the
ordering, and the resolution are already in the tool.

## Telegram API history backfill (optional, manual-only)

The web preview cannot see groups at all, and it has a coverage ceiling
on large channels. The MTProto API (Telethon) can read a channel or
group's **full message history** — including the old posts the preview
never serves. `tbi api-backfill` is that path. It is **optional and
manual-only**: the daily scheduled job never uses it, and it runs only
when the owner starts it.

**Privacy model (hard condition, set by the owner):**
- Credentials (`api_id`, `api_hash`, session string) live **only as
  GitHub Actions secrets** — encrypted by GitHub, managed only by the
  repo owner. They are **never in the repo, never in any file that
  gets pushed, never in any log, never in the zip**. The code only
  reads them from environment variables (`TELEGRAM_API_ID`,
  `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING`) and never prints
  them.
- The API job is **manual-only** (workflow_dispatch, no schedule), so
  nothing runs continuously tied to the owner's account.
- It reads **only configured channels/groups** (`channels.yaml`) —
  never the owner's personal chats. A handle that is not in the config
  is refused, and a resolved entity that turns out to be a person is
  refused too.
- **Metadata only, legal sources only, no file downloads** — the same
  rule as the preview scraper. Each API message becomes the same
  `Post` row the preview walk writes (same title/author parsing, same
  dedup keys), so the two paths produce identical index rows.
- Flood waits are honoured (backoff + resume from the same offset),
  and the walk is resumable (new posts first, then one backfill block
  below the oldest, like `tbi index --backfill`).

**Setup (once, by the owner):**
1. Create `api_id` / `api_hash` at https://my.telegram.org — log in,
   "API development tools", create an app, copy the two values.
2. Run the login script **once, on the owner's own Mac** (it needs the
   owner's phone + the login code Telegram sends — never run it from
   an agent or CI):
   ```bash
   cd telegram
   pip install -e ".[api]"
   python3 scripts/create_session.py
   ```
   It prints ONE line: the session string. It never writes it to any
   file. Paste that line into the GitHub secret
   `TELEGRAM_SESSION_STRING` — and nowhere else.
3. Add the three secrets in the repo: GitHub → Settings → Secrets and
   variables → Actions → New repository secret:
   `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING`.
4. Run it manually: GitHub → repo → Actions → `telegram-api-backfill`
   → Run workflow (optional channel input, backfill or new-only mode).
   Or locally:
   ```bash
   export TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_SESSION_STRING=...
   tbi api-backfill --channel ekraly            # one configured source
   tbi api-backfill --backfill --backfill-block 3000   # all configured
   tbi api-backfill --new-only                   # only new posts
   tbi api-backfill --full --channel somegroup   # full history, one source
   ```
   A `--channel` that is not in `channels.yaml` is refused. To
   API-index a group, add it under `groups:` in `channels.yaml` with
   its name (the handle, e.g. `EBook_Library`) — no export file is
   needed for the API path.

**Submit one book (individual indexing):**
```bash
tbi submit-book --source https://t.me/testchan/42 --title "Dune" \
  --author "Frank Herbert" --format epub --size 1200000
tbi submit-book --source https://example.com/books/dune.pdf --title "Dune" --format pdf
```
The book is indexed with its source recorded (a `t.me` post link or
an external URL — anything else is rejected), so it is searchable and
published like any other indexed book. The bot (Phase 2) will call
this when a user submits a book. No file is downloaded or hosted —
metadata + source link only. Submitting the same book twice does not
duplicate it, and a book already in the index from another source is
reported as such. An external source is stored under a `submitted`
source named after its domain.

## Slow group joining (scheduled, v0.4.6)

The API can only read a group's history once the owner is a member of
it — and the owner is a member of only ~5% of the 168 configured
groups. `tbi join-groups` closes that gap, slowly and safely, with no
terminal work from the owner: the scheduled workflow
(`.github/workflows/telegram-join-groups.yml`, every 12 hours) joins
up to **3 pending groups per run**, waits **60–120 s between joins**,
adds each joined group to the owner's Telegram chat folder **📚كتب**,
then indexes each newly joined group with the API backfill and
publishes. That is ~6 groups a day, so the full sweep takes ~4 weeks
— the owner only checks `join-state.json` / `join-report.md` in the
repo every few days.

**Why so slow:** joining is the most rate-limited thing a Telegram
account can do. Joining ~160 groups in one go would trigger a flood
wait and could restrict the owner's account, so this job never
hurries. A **flood wait stops the run immediately** — no more groups
are attempted, the wait (group + seconds + until-when) is recorded in
`join-state.json`, and the next scheduled run attempts nothing until
the wait has expired.

**How it works:**
- `join-state.json` (committed to the repo, so it survives the
  ephemeral GitHub runners) holds one entry per group: `status`
  (`pending` / `joined` / `already_member` / `failed` / `flood_wait`),
  `joined_at`, `fail_reason`, `flood_wait_seconds`, `attempts`, and the
  folder-step outcome — plus the run settings (folder title, batch
  size, delay range) and any active flood wait.
- Membership is checked **first** (never a redundant join request);
  a group he is already in is marked `already_member` and still added
  to the folder. A handle that resolves to a person is refused.
- One group's failure (not found, private, needs admin approval, …)
  is recorded with its reason and the run moves on. A `failed` group
  is never retried automatically — to retry one, set its `status`
  back to `pending` in `join-state.json`.
- The folder step is best-effort: when the folder is missing it is
  logged and skipped (never created automatically — the owner made it,
  the tool only adds to it).
- A run that joins nothing (all failed, a flood wait, or the sweep is
  done) still commits the updated `join-state.json` + `join-report.md`
  and does not fail — the live site is untouched in that case.
- A group whose backfill fails after joining stays `joined` in the
  state; the manual `telegram-api-backfill` (all sources) picks it up
  on a later run.

**Checking progress:** open `telegram/join-state.json` in the repo
(count the statuses) or `telegram/join-report.md` (the last run's
record). **Manual trigger:** GitHub → repo → Actions →
`telegram-join-groups` → Run workflow (optional `batch` input,
default 3). Locally, with the API secrets exported:
```bash
tbi join-groups --batch 3   # batch / delay / folder default to the state file
```

## Cloud publish (static site, daily sync)

GitHub is **storage only** (config + `index.db.gz` + generated static
files). Cloudflare Pages (free) serves the **repo root** of
`kindle-opds-static` on the free `pages.dev` address — the OPDS catalog
at `/` and the Telegram section at `/telegram/` (via the root
`_redirects` rewrite to `site/telegram/`). No custom/temporary domain,
no new repo, no new Pages project, no server, no Mac involved after the
seed is pushed.

- **Schedule:** `.github/workflows/telegram-sync.yml` runs daily at
  03:00 UTC (plus manual `workflow_dispatch`). It checks out,
  decompresses the seed (`gunzip telegram/index.db.gz`), installs the
  tool from `telegram/`, runs
  `tbi index --backfill --backfill-block 3000`, builds the site into
  `site/telegram.new/`, validates it with `tbi validate`, and only then
  swaps it into `site/telegram/`, re-compresses the seed
  (`gzip -f telegram/index.db`), and commits + pushes
  `telegram/index.db.gz`, `telegram/index-report.md`, and `site/telegram/`.
- **Seed (compressed):** the scheduled job never does a full walk — it
  refuses to run without `telegram/index.db.gz` in the repo. Push the
  local index once, compressed (see `PUSH_GUIDE.md`); the job resumes
  from it. The seed is stored **compressed** because the raw
  `index.db` is ~26 MB and Cloudflare Pages refuses files over 25 MB —
  a raw `index.db` in the repo breaks the deployment and leaves
  `/telegram/` on a 404 (that is what happened on 2026-11-07). The
  raw `.db` is never committed; locally the tool still uses `index.db`
  (the workflows decompress/compress it at the edges). A 26.9 MB seed
  compresses to ~6.2 MB (gzip, ~23% — measured 2026-11-07 on a
  62,806-post DB of the same schema).
- **API backfill (manual-only):** `.github/workflows/telegram-api-backfill.yml`
  runs only on manual dispatch (optional channel input, backfill or
  new-only mode), uses the three GitHub secrets, and publishes the
  same way (validate → atomic swap → commit). The daily preview job
  stays the default and never uses the API.
- **Protection layer:** per-channel try/except with retries (already
  in the scraper); DB validated before any publish; atomic publish
  (staging `site/telegram.new/` → `site/telegram/` only if validation
  passes); the last-good `site/telegram/` stays live on failure and
  the failure is recorded in `index-report.md` (committed on its own);
  one run at a time (`concurrency`); 1.5 s delay per channel,
  sequential — no parallel workers, Telegram is never hammered. The
  report lists failures, zero-book channels (with a `HUGE FOR NOTHING`
  flag for channels with ≥1000 posts and no books), dropped channels,
  low-density channels (fewer than 1 book file per 100 posts), backfill
  status, and giants (newest post id ≥50,000 with a full-walk time
  estimate).
- **Timeouts + failure save (v0.4.2):** the first manual run
  (2026-11-07) failed after 1h 40m when the Index step hit its old
  100-minute limit mid-channel (`@twinkling4`, ~540 posts into its
  block) — and lost ALL its progress (~33,900 posts / ~9,100 book
  files) because the DB is only committed at the end and the timeout
  kill skips the tool's report, so no commit landed at all. The Index
  step now allows 300 minutes and the job 360 (GitHub's per-job
  maximum); the block stays 3000. The failure step now saves progress
  instead of only a report: it checkpoints the Store's WAL into
  `index.db` (without this the saved file would be near-empty — the
  WAL holds the committed rows), validates the DB, and commits the
  compressed seed (`index.db.gz`) + report, so the next run resumes
  instead of restarting. The last-good site is never touched on
  failure.
- **API `offset_id=None` fix (v0.4.3):** the first manual API
  backfill (2026-11-07) failed on ALL 43 channels in ~90s with
  `TypeError: '>' not supported between instances of 'int' and
  'NoneType'` and indexed nothing. Cause: `iter_api_posts` passed
  `offset_id=None` to Telethon on the first chunk of every channel,
  and real Telethon does `offset_id = max(offset_id, max_id)` with
  `max_id` defaulting to 0 — so `max(None, 0)` raises. The fake
  client in the tests treated `None` as "no offset", so the tests
  passed and the bug shipped. Fix: `offset_id` is now always an int
  (`0` = start from the newest, Telethon's default), and the fake
  client now mimics Telethon's `max(offset_id, 0)` so the regression
  is caught (reverting the fix fails 6 tests).
- **First group via the API (v0.4.4):** EBook_Library is the first
  group active in `channels.yaml` — via the API only (the owner is a
  member, so Telethon reads its history; no Desktop export is
  configured, and the API does not need one). The preview sync skips
  API-only groups (no export) instead of marking them "error" on the
  missing export. The other 167 groups stay commented out until each
  is verified the same way.
- **All groups via the API (v0.4.5):** the remaining 167 groups are
  now active too — all 168 groups in `channels.yaml`, none with a
  Desktop export. EBook_Library proved the API reads group history
  in production (v0.4.4 run: 3000 posts / 2000 book files). A group
  the owner is not a member of fails per-group in the api-backfill
  run (recorded in the report; the run continues) and needs joining
  first, or a Desktop export. The 10 dead handles and 6 private
  invite links stay inactive (not group entries).
- **Rebase before push (v0.4.7):** the full api-backfill run
  42406045618 (2026-11-07) ran 1h22m and failed at the final push —
  the owner had pushed v0.4.6 mid-run, so the workflow's plain `git
  push` was rejected (non-fast-forward) and the run's commit was lost
  (the runner is ephemeral). All three workflows now run `git pull
  --rebase --autostash origin main` before every push (Publish,
  join-state, and failure-save), so a code push during a run no
  longer fails the publish; the failure-save push is retried once
  after a rebase. A rebase conflict fails loudly instead of pushing
  or skipping, and force-push is never used. `--autostash` is
  required in the failure-save: the progress files are uncommitted
  there, and a plain rebase refuses with unstaged changes (verified
  in a shallow clone).
- **The site:** `site/telegram/index.html` is a single static page
  (Arabic-first, RTL) that loads `index.json` and searches client-side
  — no server, no external dependencies. It has the same Arabic
  normalization as the CLI (tashkeel stripped, alef unified, ة→ه,
  ى→ي), plus format/source filters, and per-result source, format,
  size, and post link, with a link to `index-report.md` and back to
  the main catalog (`../`). A search with zero hits shows the "not in
  the index yet" state (see Priority search).
- **Phase 2 (not built):** a Telegram bot as the publishing front end —
  users add their own libraries, sync status, notifications. See
  [Bot limits](#bot-limits-phase-2-not-built) below.

## Bot limits (Phase 2 — not built)

The bot is **not built in this version**; these are the documented
limits it must follow, so the design is fixed before any code exists:

- **Separate account.** The bot is its own Telegram account, not the
  user's. It only sees chats it is added to (as member/admin); it
  cannot see other channels/groups or the user's personal chats, cannot
  act as the user, and cannot backfill history from before it joined.
  It cannot be added to channels the user does not own — so it does
  **not** replace the preview fetcher for the 43 channels; its role is
  the front-end (users add their own libraries, priority requests,
  sync status, notifications). A userbot acting as the user's account
  is NOT the bot — the API backfill is a separate, manual-only,
  owner-controlled path (see "Telegram API history backfill" above);
  the bot itself never acts as the user.
- **Only t.me links.** The bot accepts only Telegram links
  (`t.me/<handle>`); anything else is rejected.
- **Validation before accepting a channel.** The bot checks the channel
  is public and contains book files in Kindle-compatible formats
  (EPUB, MOBI, AZW3, KFX, PDF, TXT — the same set the indexer counts)
  by sampling the newest posts. A minimum book-file threshold applies;
  below it the channel is rejected with the reason.
- **Token is a server-side secret.** The bot token is never in the repo,
  never in any committed file, and never in the published site. Anyone
  can copy the code but cannot impersonate the bot without its token.
- **Admin commands are restricted** to the owner's Telegram user ID.
- **Rate-limit additions** (five channels per user per day — the stability-sized cap).
- **Metadata only, legal sources only.** The bot never forwards or
  redistributes files; it records links and metadata, and only for
  legal sources (public-domain / licensed / the user's own files).

## Indexing a group: Telegram Desktop export

Public groups have no `t.me/s/` preview, so the only API-free path is an
export. In **Telegram Desktop**:

1. Open the group.
2. Top-right menu (⋯) → **Export chat history**.
3. Format: **JSON**. Tick **include media files** if you want the files
   saved locally alongside the export (the index records the file path).
4. Export, then put the `result.json` path in `channels.yaml` under `groups`.

Re-export and re-run `tbi index` whenever you want fresh results. The
parser follows the Telegram Desktop JSON export format
(`name`/`type`/`id`/`messages[]` with `file`, `mime_type`, `media_type`,
`date_unixtime`, entity-list `text`); it was built against the documented
shape and a realistic fixture — **please verify it against one real
export** and open an issue if your export differs.

## What the index stores

SQLite (`index.db` by default) with FTS5 full-text search over
title / author / filename / caption:

- `sources` — kind, name, status, oldest/newest post id reached, coverage note.
- `posts` — one row per post (unique per source + post id).
- `files` — one row per book file (EPUB, MOBI, AZW3, KFX, PDF, TXT), with
  parsed title/author and a dedup key so the same book shared in several
  sources counts once as a book (each share is still listed in search).
- `priority_requests` — one row per priority request (channel, query,
  status pending/resolved, timestamps). Metadata only — never a file.
- `submitted` sources — books added one-by-one with
  `tbi submit-book` (an external URL is stored under a source named
  after its domain); same `posts`/`files` rows as scraped books, so
  they are searchable and published identically.

## Dropped and low-density channels

- **Dropped (8):** arabicEread, Bookkn, Maktademia, Motamayezon7,
  booksguy, eBookRoom, Ebookspdfdownload, premium_ebooks — 0 book files
  each in the full first run (2026-11-06), two of them after 1000+
  posts for nothing (eBookRoom 1670, premium_ebooks 1172). They were
  moved out of the active config in v0.3 (recorded in the `# Dropped`
  section of `channels.yaml` and in the report); **their history stays
  in `index.db` and remains searchable** — they are simply not fetched
  anymore. To re-add one, move its line back to `channels:`.
- **Low-density (kept active, flagged in the report):**
  mamachegucoloringforkids (1718 posts, 1 book file) and
  ancientegyptianmagazines (1469 posts, 14 book files) — fewer than 1
  book file per 100 posts. They stay active for now; if they stay this
  sparse they are the next drop candidates.

## Honest limitations (verified, not assumed)

- **Groups are export-only.** `t.me/s/<group>` redirects to an info card
  with no messages — verified live 2026-11-06 on `@jazz223k` and others.
  A single known group post (`t.me/<group>/<id>`, incl. the embed widget)
  also returns no content. MTProto + `api_id`/`api_hash` + a login can
  read groups live — that is the optional, manual-only API backfill
  (see "Telegram API history backfill" above): credentials only as
  GitHub Actions secrets, owner-only, never in the repo, and the job
  runs only when the owner starts it, so nothing runs continuously
  tied to the account. The default (preview + export) path still uses
  **no API credentials at all**. **Real-world split (verified 2026-11-06,
  corrected counts — batch 1, 29 sources, plus batch 2, 207 new
  sources): 236 unique sources — 51 walkable channels, 168 groups
  (export-only), 10 dead**, plus 6 private invite links and 1
  non-Telegram website recorded separately. Batch 1 was 10 channels +
  16 groups + 3 dead (8 of the first 27 "groups" turned out to be
  channels on re-check); batch 2 added 41 channels + 152 groups + 7
  dead. So for most book sources the export path is the one that
  matters — live scraping alone covers only the channels.
  `channels.yaml` ships with all of them: the 43 active channels (8
  dropped, see above), and the groups — all 168 API-active since
  v0.4.5 (EBook_Library first in v0.4.4, the remaining 167 in
  v0.4.5), none with a Desktop export. The API reads a group's
  history when the owner is a member; a group he is not a member of
  fails per-group in the api-backfill run (recorded in the report;
  the run continues) and needs joining first, or a Desktop export.
  **EBook_Library is the first group active
  (v0.4.4), via the API** (the owner is a member, so Telethon reads
  its history; no export file is needed for the API path, and the
  preview sync skips API-only groups instead of erroring on the
  missing export). Note: a first-page
  check of the 41 new channels (2026-11-06) found documents on the
  first page of only some of them — several post photos + text links
  instead of files, so their posts index with text but no book files.
  See `telegram-sources-batch2.md` for the per-channel check.
- **Channels: the preview has a coverage ceiling.** `?before=` walks back
  and reached the first post of `@telegram` (460 posts, ids 1–460, verified
  live 2026-11-06), but independent write-ups warn the preview exposes a
  contiguous recent slice on large/old channels. `tbi sources` records the
  oldest post id reached per channel so you can see the actual coverage.
  First run on a large channel takes a while: `@KindleBooksRepository`
  has ~7,700 posts, ~10 minutes at the polite 1.5 s/page pace. Later
  runs are incremental (only new posts) and fast — and an interrupted run
  resumes where it stopped instead of starting the channel over: progress
  is committed every 20 posts, the run prints `[...] @name: N posts so
  far` every 20 posts so the quiet between pages is visibly progress, and
  a Ctrl+C keeps everything indexed so far (verified offline 2026-11-06:
  interrupt after 5 posts kept all 5; the next run resumed below them).
  Deep history is filled in by `--backfill` (one 3000-post block per
  scheduled run per channel), not by one giant uncapped walk.
- **No direct file download.** Documents have no public download link in
  the preview — you get filename, size, type, and the post permalink.
  Open the permalink in Telegram to download. (Photos get short-lived CDN
  links; documents do not.)
- **Filenames can be truncated** in the preview (long titles end with `..`).
- **Server-side search (`?q=`) is capped** to roughly one screen of
  results — the tool walks the history and searches locally instead.
  `tbi search-channel` uses it for one targeted question at a time,
  which is exactly what it is good for.
- **Rate limits:** polite sequential fetching (1.5 s between pages by
  default) works; bursts get HTTP 429. The scraper retries with backoff.
- **HTML changes break scrapers.** The parser is covered by offline
  fixtures of real `t.me/s/` pages; if Telegram changes its markup the
  tests fail loudly instead of silently returning zero results.
- **Document size is parsed from the preview's extra line** (`"12.3 MB"`)
  and **verified live 2026-11-06**: `@KindleBooksRepository` returned
  29 EPUB files in 60 posts with real filenames and sizes (e.g.
  `985.7 KB`, `1.8 MB`). For audio posts the extra line is the artist
  name, not a size, and is stored as such.
- **Arabic search is diacritic-insensitive.** Channel filenames often
  carry full tashkeel (`مُتَوِّنُ`), while users search plain (`متون`).
  The index and the query are both normalized (tashkeel stripped, alef
  forms unified, ة→ه, ى→ي), so plain queries find diacritized titles —
  verified live 2026-11-06 (`متون` → 4 hits in `@KindleBooksRepository`).
  Displayed filenames keep their original diacritics.

## Why the scraper is vendored, not a dependency

The obvious base, `telegram-channel-scraper` (PyPI, MIT, 10 stars),
crashes in proxied environments — httpx chokes on a `NO_PROXY` entry
such as `[::1]` (`InvalidURL: Invalid port: ':1]'`, verified 2026-11-06) —
and its `Media` model has no file-size field, which this tool needs.
The subset required here (fetch a preview page, parse posts, walk
`?before=`) is ~200 lines in `tbi/scrape.py`, covered by fixture tests.
Credit to that project for proving the approach; see
`research_notes/` in the original workspace for the full survey.

## Tests

```bash
pip install pytest
python -m pytest tests/ -q
```

Tests are offline (real `t.me/s/` HTML fixtures + a realistic export
fixture). Live behaviour verified separately — see "Honest limitations".

## License

MIT. See [LICENSE](LICENSE).
