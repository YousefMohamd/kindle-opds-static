# Cloudflare OPDS - preparation only, NOT published yet
- Static catalog: copy ~/workspace/kindle-quiet-prep/static-opds/* into Pages output root,
  so /khazendar/index.xml, /sahwa/index.xml, /electronic/index.xml are live.
- Search indexes: this folder's <lib>/search-index.json (khazendar 6392, sahwa 1593,
  electronic 10552 - counts match static catalog exactly, built 2026-11-04 from static XML).
- Search: Pages Functions in functions/<lib>/opds/search.js handle /<lib>/opds/search?q=...
  OpenSearch description: <lib>/opds-search.xml, template /<lib>/opds/search?q={searchTerms}.
  NOTE: static index.xml files do NOT yet contain a search link - add
  <link rel="search" type="application/opensearchdescription+xml" href="opds-search.xml"/>
  to each library's index.xml before publishing, or KOReader will not show search.
- Mac servers 8000/8001/8002 stay ON until: one Cloudflare host test + one download
  per library from Cloudflare + separate user approval to stop Mac servers.
- Telegram: MERGED (v0.3, 2026-11-07) — the Telegram book index lives in
  this repo now: tool in telegram/, published section at
  kindle-opds-static.pages.dev/telegram/ (see "Telegram book index"
  below). No Telegram bot yet (Phase 2), no group reading without a
  Desktop export. Manual path only: user downloads from Telegram,
  uploads to Drive, then the Drive-detection script (future, separate
  approval, Drive OAuth/Secret) picks it up.
- Drive files: user confirms they cannot be deleted. Download links remain Drive uc?id.
- Search limit: first 100 matches, substring in title or author, case-insensitive.

## Telegram book index

- Live at https://kindle-opds-static.pages.dev/telegram/ — a static
  Arabic-first search page over the books shared in public Telegram
  channels (metadata only: title, format, size, post link — no book
  files are hosted or downloaded). The page is served from
  site/telegram/ in this repo; the root `_redirects` file rewrites
  /telegram/* to /site/telegram/* (200), because this repo's Pages
  project serves the repo root.
- Tool: telegram/ (the `tbi` CLI, Python, no API credentials, no
  Telegram login, no always-on server). Config:
  telegram/channels.yaml — 43 active channels; 168 groups need a
  Telegram Desktop JSON export each; 10 dead handles; 6 private invite
  links; 8 channels dropped for having 0 book files (their history
  stays in the DB).
- Scheduled sync: .github/workflows/telegram-sync.yml — daily 03:00
  UTC + manual runs. Each run backfills one block of 3000 posts per
  not-yet-complete channel (newest first), then switches to new-only
  sync once every channel is complete. Every run writes
  telegram/index-report.md (published at /telegram/index-report.md).
- Priority search: `tbi search-channel --channel X --query "..."` runs
  a targeted server-side search in one channel and returns the post
  link immediately when found (indexing that post); when nothing is
  found it queues a priority backfill request, and the next scheduled
  run backfills that channel first. The search page shows a "not in
  the index yet" state that points to the Telegram bot (Phase 2).
- Bot (Phase 2, not built): a Telegram bot as the front-end for adding
  libraries and priority requests. It is a separate account (not the
  user's), only sees chats it is added to, cannot act as the user,
  cannot backfill history before it joined, and cannot be added to
  channels the user does not own. See telegram/README.md for the full
  limits.
- Details: telegram/README.md and telegram/PUSH_GUIDE.md.
