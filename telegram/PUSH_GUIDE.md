# Publishing the Telegram merge into kindle-opds-static (v0.3)

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
before it exists.

## What gets pushed (the delta)

| Path in the repo | What it is |
|---|---|
| `telegram/` | The tool v0.3.0 (code, `channels.yaml`, tests, README, this guide) + the seed `index.db` |
| `.github/workflows/telegram-sync.yml` | The scheduled sync (daily 03:00 UTC + manual) |
| `site/telegram/index.html` | The Telegram search page |
| `_redirects` | `/telegram/*` → `/site/telegram/*` (200 rewrite) |
| `.gitignore` | Telegram-only ignore rules (scoped to `telegram/` + `site/telegram.new/`) |
| `README.md` | OPDS content unchanged + Telegram section appended |

Nothing else in the repo changes. The OPDS files (`index.xml`,
`khazendar/`, `sahwa/`, `electronic/`, `hindawi/`, `doab/`,
`functions/`) are **not** in this push.

## Step 1 — finish the local run, then prepare the seed

On the Mac, in the folder with the finished local run
(`~/Downloads/telegram-book-index`):

```bash
# 1. Stop the run if it is still going (Ctrl+C — committed channels are safe).
# 2. Copy the new v0.3.0 tool over it, keeping your index.db:
#    (unzip telegram-book-index.zip, copy its kindle-opds-static/telegram/
#    contents over the folder — do NOT overwrite index.db)
# 3. Optional, so the site works immediately instead of after the first
#    sync: build the static data once, locally:
cd ~/Downloads/telegram-book-index
.venv/bin/python -m tbi.cli export-static --db index.db --out site
#    (writes site/index.json + copies index-report.md into site/)
```

`index.db` is the seed: the scheduled job never does a full walk, it
refuses to run without `telegram/index.db` in the repo and only fetches
new posts + backfill blocks from it.

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
# then the seed + the locally built static data:
cp ~/Downloads/telegram-book-index/index.db telegram/index.db
cp ~/Downloads/telegram-book-index/index-report.md telegram/index-report.md
cp ~/Downloads/telegram-book-index/site/index.json site/telegram/index.json
cp ~/Downloads/telegram-book-index/site/index-report.md site/telegram/index-report.md
git status        # check: only the delta paths above are new/changed
git add telegram/ .github/workflows/telegram-sync.yml site/telegram/ \
  _redirects .gitignore README.md
git commit -m "Telegram book index v0.3.0 — merged into kindle-opds-static (tool in telegram/, section at /telegram/, backfill in blocks, priority search)"
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

Then push the **seed `index.db`** (and the report) separately with
plain git from the Mac (a multi-MB binary is safer that way than
through the connector):

```bash
git clone https://github.com/YousefMohamd/kindle-opds-static.git
cd kindle-opds-static
cp ~/Downloads/telegram-book-index/index.db telegram/index.db
cp ~/Downloads/telegram-book-index/index-report.md telegram/index-report.md
git add telegram/index.db telegram/index-report.md
git commit -m "[telegram-seed] local index.db — scheduled sync resumes from here"
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
`yousefmohamed.studio`, no custom/temporary domain.

## Step 4 — verify

1. GitHub → repo → Actions → run the `telegram-sync` workflow once
   manually (`workflow_dispatch`) and watch it go green. It runs
   `tbi index --backfill --backfill-block 3000`, rebuilds the site,
   validates it, and commits the updated `telegram/index.db` +
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
   the last-good site live and commits only the updated report — check
   the report for the reason, then re-run manually. Once the report
   shows every channel complete, the workflow can be switched to
   `tbi index --new-only` (leaving it on `--backfill` is also fine).

## Notes

- **This merge DOES push to `kindle-opds-static`** — that is the
  decided merge target. Never push to `BattOpt` (separate project).
- `telegram/index.db` **is** committed by design (the sync seed:
  public-channel metadata only — no account, no private chats).
  `exports/` and `result.json` are gitignored and must never be
  committed.
- `remaining.yaml` (the local run's 3000-post cap config) is **not**
  part of this merge — `--backfill` replaces it: the 3000-post cap is
  now a per-run block in the scheduled job, not a one-off config.
- No Telegram API credentials exist anywhere in this repo by design.
- Phase 2 (Telegram bot front end) is not part of this build — see
  README "Bot limits" for what it will do later.
