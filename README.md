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
- Telegram: POSTPONED until technician replies. No Telegram bot, no group reading,
  no auto-import. Manual path only: user downloads from Telegram, uploads to Drive,
  then Drive-detection script (future, separate approval, Drive OAuth/Secret) picks it up.
- Drive files: user confirms they cannot be deleted. Download links remain Drive uc?id.
- Search limit: first 100 matches, substring in title or author, case-insensitive.
