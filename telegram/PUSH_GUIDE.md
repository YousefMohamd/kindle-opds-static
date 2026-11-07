# Publishing the Telegram merge into kindle-opds-static (v0.4.6)

**No new repo, no new Pages project, no new domain.** The Telegram
index merges into the existing public repo
[`YousefMohamd/kindle-opds-static`](https://github.com/YousefMohamd/kindle-opds-static)
(already published on Cloudflare Pages at
`kindle-opds-static.pages.dev`), as a new `telegram/` tool directory
plus a published section at `/telegram/`. The existing OPDS deploy
(Drive libraries, Hindawi, DOAB, Wikisource feeds, Pages Functions)
is untouched by this push — the only root files that change are
`README.md` (Telegram section added), the new `_redirects` (rewrites
`/telegram/*` to `/site/telegram/*`), and the new `.gitignore`.

**Do this only AFTER the local run on the Mac has finished** (or been
stopped with Ctrl+C — the channels it committed are safe). The local
`index.db` is the seed the scheduled job resumes from; do not push
before it exists. The seed is stored in the repo **compressed** as
`telegram/index.db.gz` — never the raw `index.db` (see "Why the seed
is compressed" below).

## What gets pushed (the delta)

| Path in the repo | What it is |
|---|---|
| `telegram/` | The tool v0.4.5 (code, `channels.yaml`, tests, README, this guide) + the seed `index.db.gz` (compressed) |
| `.github/workflows/telegram-sync.yml` | The scheduled sync (daily 03:00 UTC + manual) |
| `.github/workflows/telegram-api-backfill.yml` | The manual-only API backfill (no schedule; needs the three GitHub secrets) |
| `site/telegram/index.html` | The Telegram search page |
| `_redirects` | `/telegram/*` → `/site/telegram/*` (200 rewrite) |
| `.gitignore` | Telegram-only ignore rules (scoped to `telegram/` + `site/telegram.new/`) |
| `README.md` | OPDS content unchanged + Telegram section appended |

## Why the seed is compressed (v0.4.1)

The first push (v0.3, commit `1efc245`) put the raw `index.db`
(26,918,912 bytes, ~25.7 MiB) in the repo. Cloudflare Pages refuses
files over **25 MB**, so the Pages deployment for that commit failed
and `/telegram/` stayed on a 404 while the OPDS (`/index.xml`) kept
working. The fix: the repo stores only `telegram/index.db.gz`
(~6.2 MB at the measured ~23% gzip ratio — a 26.9 MB seed compresses
to ~6 MB, well under the limit). Both workflows decompress it at the
start (`gunzip`) and re-compress it before committing (`gzip -f`), so
the tool still uses the raw `index.db` locally and in the runner; only
the stored form is compressed. **Never commit the raw `index.db`
again** — it breaks the deployment the same way. If you already
pushed the raw file, this push removes it from the repo (see the
swap steps in Step 2).

Nothing else in the repo changes. The OPDS files (`index.xml`,
`khazendar/`, `sahwa/`, `electronic/`, `hindawi/`, `doab/`,
`functions/`) are **not** in this push.

## Timeout fix (v0.4.2)

The first manual `telegram-sync` run (2026-11-07) failed after
1h 40m: the Index step hit its old 100-minute limit mid-channel
(`@twinkling4`, ~540 posts into its block) and **nothing was
committed** — the ~33,900 posts / ~9,100 book files that run had
indexed were lost, because the DB is only committed at the end
(Publish step) and the timeout kill skips the tool's report, so the
old failure step (report-only) had nothing to commit either. The
fix, in both workflows:
- **Index step 100 → 300 minutes, job 120 → 360** (GitHub's per-job
  maximum). A full 3000-post backfill of all 43 channels needs
  ~200 minutes at the observed pace. **The block stays 3000.**
- **Failure step saves progress, not just a report:** it checkpoints
  the Store's WAL into `index.db` (WAL mode — committed rows may sit
  in `index.db-wal`, and gzipping the raw `.db` alone would save an
  almost-empty file), validates the DB with `tbi validate`, and
  commits the compressed seed (`telegram/index.db.gz`) + report, so
  the next run resumes instead of restarting. The live site is never
  touched on failure.

## Step 1 — finish the local run, then prepare the seed

On the Mac, in the folder with the finished local run
(`~/Downloads/telegram-book-index`):

```bash
# 1. Stop the run if it is still going (Ctrl+C — committed channels are safe).
# 2. Copy the new v0.4.5 tool over it, keeping your index.db:
#    (unzip telegram-book-index.zip, copy its kindle-opds-static/telegram/
#    contents over the folder — do NOT overwrite index.db)
# 3. Compress the seed (the repo stores only index.db.gz — see above).
#    -k keeps the raw index.db for local use; the .gz is what gets pushed.
cd ~/Downloads/telegram-book-index
gzip -k index.db
ls -la index.db.gz   # expect ~6 MB for the ~27 MB seed
# 4. Optional, so the site works immediately instead of after the first
#    sync: build the static data once, locally:
.venv/bin/python -m tbi.cli export-static --db index.db --out site
#    (writes site/index.json + copies index-report.md into site/)
```

`index.db` is the seed: the scheduled job never does a full walk, it
refuses to run without `telegram/index.db.gz` in the repo and only
fetches new posts + backfill blocks from it (after decompressing it).

## Step 2 — push the delta (pick ONE path)

### Path A — from the Mac with plain git (recommended)

```bash
git clone https://github.com/YousefMohamd/kindle-opds-static.git
cd kindle-opds-static
# copy the merged files in (from the unzipped telegram-book-index.zip):
#   kindle-opds-static/telegram/        -> telegram/
#   kindle-opds-static/.github/         -> .github/
#   kindle-opds-static/site/telegram/   -> site/telegram/
#   kindle-opds-static/_redirects       -> _redirects
#   kindle-opds-static/.gitignore       -> .gitignore
#   kindle-opds-static/README.md        -> README.md
# then the seed (COMPRESSED) + the locally built static data:
cp ~/Downloads/telegram-book-index/index.db.gz telegram/index.db.gz
cp ~/Downloads/telegram-book-index/index-report.md telegram/index-report.md
cp ~/Downloads/telegram-book-index/site/index.json site/telegram/index.json
cp ~/Downloads/telegram-book-index/site/index-report.md site/telegram/index-report.md
# if the raw index.db is in the repo from an earlier push, remove it
# (it breaks the Pages deployment — see "Why the seed is compressed"):
git rm telegram/index.db 2>/dev/null || true
git status        # check: only the delta paths above are new/changed
git add telegram/ .github/workflows/telegram-sync.yml \
  .github/workflows/telegram-api-backfill.yml site/telegram/ \
  _redirects .gitignore README.md
git commit -m "Telegram book index v0.4.5 — merged into kindle-opds-static (tool in telegram/, section at /telegram/, backfill in blocks, priority search)"
git push
```

### Path B — code through the Muse GitHub connector, seed via git

The Muse GitHub App already has access to `kindle-opds-static` (no
repo creation, no new installation needed). In the agent workspace,
with the source dir `~/workspace/kindle-opds-static` and the manifest
`~/workspace/kindle-opds-static-telegram-manifest` (all delta files,
NUL-delimited, written outside the source dir):

```bash
/opt/hatch/bin/github push-files \
  --owner YousefMohamd --repo kindle-opds-static --branch main \
  --message "Telegram book index v0.3.0 — merged into kindle-opds-static (tool in telegram/, section at /telegram/, backfill in blocks, priority search)" \
  --source-dir ~/workspace/kindle-opds-static \
  --paths-file ~/workspace/kindle-opds-static-telegram-manifest
```

Then push the **seed `index.db.gz`** (and the report) separately with
plain git from the Mac (a multi-MB binary is safer that way than
through the connector):

```bash
git clone https://github.com/YousefMohamd/kindle-opds-static.git
cd kindle-opds-static
cp ~/Downloads/telegram-book-index/index.db.gz telegram/index.db.gz
cp ~/Downloads/telegram-book-index/index-report.md telegram/index-report.md
# if the raw index.db is in the repo from an earlier push, remove it:
git rm telegram/index.db 2>/dev/null || true
git add telegram/index.db.gz telegram/index-report.md
git commit -m "[telegram-seed] local index.db.gz (compressed) — scheduled sync resumes from here"
git push
```

After a confirmed push, the agent records the commit SHA in
`~/workspace/kindle-opds-static-telegram.muse-github-snapshot-sync.json`
(sibling of the source dir — never inside the repo).

## Step 3 — Cloudflare Pages (no change needed)

The Pages project for `kindle-opds-static` already exists and serves
the **repo root** — no new project, no build command, no output
directory change. After the push, the Telegram section is live at
`kindle-opds-static.pages.dev/telegram/` (the `_redirects` rewrite
serves `site/telegram/` there). No DNS change, no change to
`yousefmohamed.studio`, no custom/temporary domain. The project is
fully independent of the purchased portfolio domain
`yousefmohamed.studio` and never depends on it — nothing in the
project references or requires it.

## Step 4 — verify

1. GitHub → repo → Actions → run the `telegram-sync` workflow once
   manually (`workflow_dispatch`) and watch it go green. It runs
   `tbi index --backfill --backfill-block 3000`, rebuilds the site,
   validates it, and commits the updated `telegram/index.db.gz` +
   `site/telegram/`.
2. Open `https://kindle-opds-static.pages.dev/telegram/`: the search
   page loads, a query like `متون` returns results, and the
   `index-report.md` link opens the run report. If `/telegram/` does
   not load, try `/site/telegram/` directly — that tells you whether
   the `_redirects` rewrite is the problem (the content is the same).
3. **Check the OPDS deploy still works:** open
   `https://kindle-opds-static.pages.dev/index.xml` and one library
   feed, e.g. `/khazendar/index.xml` — both must load exactly as
   before. The merge does not touch them, but verify anyway.
4. After that the daily 03:00 UTC run takes over. A failed run keeps
   the last-good site live and now also saves its progress (the
   compressed seed + report are committed by the failure step, so the
   next run resumes) — check the report for the reason, then re-run
   manually. Once the report shows every channel complete, the workflow
   can be switched to `tbi index --new-only` (leaving it on
   `--backfill` is also fine).

## v0.4.6 — slow group joining (no Mac step needed)

v0.4.6 adds `telegram-join-groups.yml` (every 12 h, 3 groups per run)
plus `telegram/join-state.json` (all 168 groups, `pending`) and
`tbi join-groups`. It is deployed with the same delta push as above
(the new files are in the zip) — **no terminal work from the owner,
no `git push` from the Mac**: the deploy goes through the GitHub API
and the workflow runs on GitHub's runners. After the push, check
Actions → `telegram-join-groups` → run it once manually (batch 3) and
watch it go green; then check `telegram/join-state.json` in the repo
— the first groups should be `joined` (or `already_member`) and the
folder step recorded. The sweep takes ~4 weeks at ~6 groups/day; a
run that joins nothing still commits the state + report and does not
fail. To retry a `failed` group, set its `status` back to `pending`
in `join-state.json` (see README "Slow group joining").

## Notes

- **This merge DOES push to `kindle-opds-static`** — that is the
  decided merge target. Never push to `BattOpt` (separate project).
- `telegram/index.db.gz` **is** committed by design (the sync seed,
  compressed: public-channel metadata only — no account, no private
  chats). The raw `telegram/index.db` is **never** committed — at
  ~26 MB it exceeds Cloudflare Pages' 25 MB per-file limit and breaks
  the deployment (`/telegram/` 404, 2026-11-07). `exports/` and
  `result.json` are gitignored and must never be committed.
- `remaining.yaml` (the local run's 3000-post cap config) is **not**
  part of this merge — `--backfill` replaces it: the 3000-post cap is
  now a per-run block in the scheduled job, not a one-off config.
- No Telegram API credentials exist anywhere in this repo by design.
- Phase 2 (Telegram bot front end) is not part of this build — see
  README "Bot limits" for what it will do later.
