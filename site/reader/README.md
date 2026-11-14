# RliBook Reader + PWA — Block 11b

The reader (Block 5) and the installable / offline app (Block 6).
Plain HTML/CSS/JS, no framework, no build step — the page must also
open in the Kindle browser.

## Files

| File | What it is |
|---|---|
| `site/reader/index.html` | The reader page |
| `site/reader/reader.js` | Reader: epub.js, Warm Light, fonts, highlights, progress, offline save, login UI |
| `site/reader/reader-lib.js` | Pure logic (URL contract, allowlist, Warm Light maths) — shared with the tests |
| `site/reader/auth.js` | Login: Google + Telegram (via the bot) |
| `site/reader/config.js` | Login config (public values only — no secrets, ever) |
| `site/reader/reader.css` | Brand styling |
| `site/reader/vendor/` | epub.js 0.3.93 + JSZip 3.10.1, vendored (see `vendor/VENDOR.md`) |
| `site/manifest.webmanifest` | PWA manifest (name RliBook, logo icons, brand colours) |
| `site/sw.js` | Service worker: cache-first app shell, network-first books |
| `site/icons/` | `logo-1024.jpg` (web logo) + PWA icons (192 / 512 / 512 maskable / apple-touch 180), cut from the user's own logo (`RliBook.jpg`). The source file has a black bar + pale strip at its far right edge (x≈4292+); the icons use the clean artwork (x 0–4290) so the bar is gone. |

## The "Read online" link (for the /book owner)

The reader opens from ONE tap on the /book "Read online" button.
The button links to the reader with the book in the query string
(build it with `RliReaderLib.buildReaderUrl` — same rules, tested):

```
/site/reader/?lib=hindawi&id=13028368&title=...&author=...
/site/reader/?lib=khazendar&id=<drive id>&title=...          (sahwa / electronic same way)
/site/reader/?lib=doab&id=<url-encoded full file URL>&title=...
/site/reader/?lib=tg&h=<handle>&p=<post>&f=epub&title=...    (Telegram: via /api/dl-token)
/site/reader/?src=<url-encoded https URL>                   (allowlisted hosts only, see reader-lib.js)
/site/reader/?demo=1                                        (sample book: /files/RliBook-Home-en.epub)
```

Only EPUB opens in the reader. A PDF/DOC link gets an honest page
("the reader opens EPUB books — use Send to my device instead").
Flagged Telegram books never reach the reader (the token endpoint
returns 403 and the reader points at the bot).

**Drive honesty:** Google Drive's download endpoint does not always
send CORS headers, so a Drive book may refuse to open in the browser
even though the file is fine. The reader says so in one line and
points at «Send to my device» (email). Hindawi (hindawi.org →
safahat.org) and the Block 2 proxy are the reliable in-browser paths.

## Features

- **Warm Light** — on/off button + Brightness and Warmth sliders.
  Warms the page itself (epub.js theme) plus a warm overlay.
- **3 fonts** — Default (device font), Amiri, Noto Naskh Arabic.
  Arabic + English. Web fonts fall back to the device font offline.
- **Highlight (Kindle-style)** — select text → Highlight → pick a
  colour (yellow / green / blue / pink). Saved on the device,
  re-applied when the book reopens, listed under "My Highlights"
  (tap to jump to it, Delete to remove it).
  **Login rule:** tapping Highlight while logged out shows one line —
  "Highlight needs login — tap Log in above." — and does not create
  the highlight. Reading is never blocked.
- **Reading progress** — saved on the device on every page turn and
  restored on reopen; the % bar needs epub.js locations (generated
  in the background after opening).
- **Offline** — when a book opens, a copy is saved on the device
  (IndexedDB) in the background. The status line then says "This
  book is saved on your device — you can read it offline." The
  service worker caches the reader + the book as a backup.
  If the browser has no IndexedDB (old Kindle browser), offline
  saving is unavailable and reading stays online-only.
- **Login** — Google (Google Identity Services) + Telegram (Login
  Widget via @RliBook_bot, plus a bot deep link). Apple login is NOT
  built: it needs a paid Apple Developer membership ($99/year).
  See "Login setup" below. Reading without login works; login only
  unlocks Highlight and (later) sync.

## Login setup (needs the coordinator / user — no code change beyond config)

1. **Google** (free, no card): Google Cloud Console → OAuth client ID
   (Web) → authorised origin `https://rlibook.tech` → paste the client
   ID into `site/reader/config.js` (`GOOGLE_CLIENT_ID`). Until then
   the Google button says "Google login is not set up yet".
2. **Telegram**: in BotFather, `/setdomain` → `rlibook.tech` for
   @RliBook_bot, or the widget shows Telegram's own error and only
   the bot link works. The bot must also handle `?start=login`
   (bot owner) and verify the widget payload server-side before the
   sync endpoint trusts it — the reader marks Telegram sessions
   `verified:false` until then.
3. **Sync**: highlights/progress are queued locally and POSTed to
   `/api/reading-sync` when logged in. That endpoint does not exist
   yet: until it does, the reader reports "Saved on this device.
   Account sync is not live yet" and keeps the queue. Nothing is lost.

## PWA

- Manifest: `site/manifest.webmanifest` (name RliBook, brand colours,
  logo icons). "Add to Home Screen" works from the reader's install
  button (beforeinstallprompt) and, on iPhone/iPad, via Share →
  Add to Home Screen (a one-line hint is shown).
- Service worker: `site/sw.js`, scope `/site/` — it covers the reader
  and the Telegram section, not the whole site. A whole-site worker
  (`/sw.js`) needs a file at the repo root, outside this block's
  ownership; recorded as an open question.
- **Home-page wiring (NOT done here — index.html belongs to another
  owner):** add to `<head>`:
  `<link rel="manifest" href="/site/manifest.webmanifest">` and
  `<meta name="theme-color" content="#93D4EF">`, plus register the
  worker with `navigator.serviceWorker.register("/site/sw.js",
  {scope:"/site/"})`. The reader page already does all three itself.
- **No Tauri desktop app** (needs an install + a build the user must
  run). The PWA covers desktop via the browser; Tauri is recorded as
  an open question for later.

## Tests

```sh
node site/reader/reader.test.mjs   # URL contract, allowlist, Warm Light, fonts, book keys
node functions/book.test.mjs       # repo tests — run before/after any change
node functions/new.test.mjs
node functions/api/send-to-kindle.test.mjs
node functions/api/tg-search.test.mjs
```

## Local check (render + highlight + offline)

```sh
cd <repo root> && python3 -m http.server 8130
# open http://localhost:8130/site/reader/?demo=1
#   - the sample book renders, Previous/Next turn pages
#   - Warm Light on: the page turns warm; Brightness/Warmth sliders move it
#   - select text -> Highlight while logged out -> one-line login notice
#   - DevTools > Application > Service Workers: /site/sw.js active,
#     Cache Storage holds the reader shell after first load
```

A real render check with the Gutenberg public-domain EPUB
(`Pride and Prejudice`, pg1342.epub) was done the same way via a
local copy served from the same server — see the block report for
the result. Hindawi EPUBs could not be fetched with curl (Cloudflare
"Just a moment" challenge); a real browser usually passes it, but
that is unverified — the reader reports a plain error if the library
sends a web page instead of the book file.
