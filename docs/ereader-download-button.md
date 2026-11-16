# RliBook — E-reader device download button (Workstream 1b)

- **Date:** 2026-11-16
- **Base:** the consolidated website zip (`rlibook-consolidated-website.zip`,
  2026-11-16 ~17:59) — i.e. GitHub main **8f72f0c** PLUS the nine
  smart-vision workstreams merged by hunk (website order B→A→E→F→H→I→C)
  and the WS1/WS2/WS3 follow-ups. It does **NOT** apply directly onto
  live main: main's `functions/book.js` still has the old button order
  (Get primary, email secondary), no `detectEReaderFamily` import, and
  the pre-H Telegram links. Apply the consolidated zips first, then
  this zip, by hunk. (Live main was verified during this build:
  HEAD `8f72f0c`, Kindle-delivery commit `5c4f544` on main, and the
  diff main→consolidated is exactly the known A/H/E/I layers — no
  surprise conflict in the regions touched here.)
- **Status:** built + tested (see §6). Nothing deployed, nothing pushed.
- **Bot version:** unchanged, **4.8.46**. No bot change in this zip.

## 0. What this is, in one paragraph

On a book page (`GET /book`), the download button used to be shown to
every visitor — desktop, mobile, Kindle, Kobo, PocketBook — with the
same generic label. Now it is a **User-Agent gate**: Kobo and
PocketBook visitors get a device-named download button under the email
button (`📥 نزّل الكتاب على جهاز Kobo` / `📥 نزّل الكتاب على جهاز
PocketBook`); a generic e-reader UA gets a labelled try-direct button
(`📥 جرّب تنزيل الكتاب على جهازك`); a Kindle UA keeps the existing
button (`📥 احصل على الكتاب على جهازك`), which is **not** a direct
download — the Kindle browser cannot download EPUBs, so it opens
`/kindle/get`, whose Kindle steps are phone → download → Send to
Kindle for Web. Desktop, mobile, and no-UA visitors see **no
download button at all** — email + reader only, and no `/kindle/get`
link anywhere on their page. The button always points at the delivery
page `/kindle/get` (10-minute token-gated short link, 5/day cap) —
never at a file. Email stays the primary button and stays unlimited.

## 1. How the gate works

- One pure helper in `functions/book.js`, exported for tests:

  ```js
  ereaderDownloadLabel(family) // "kobo" | "pocketbook" | "generic"
                               // | "kindle" -> label, anything else -> ""
  ```

  It takes the family from the existing `detectEReaderFamily(ua)`
  (`functions/kindle/[[path]].js`, Workstream E — unchanged here).
  A card renders its download button only when it has a `/kindle/get`
  link **and** the label is non-empty (`if (getUrl && downloadLabel)`),
  for OPDS cards and Telegram cards alike.
- The family banner on `/book` now quotes the button that actually
  exists (Kobo/PocketBook quote their device label; generic no longer
  quotes a label it does not have).
- The footer note and the Telegram note describe the download **only
  when a download button was actually rendered** on that page
  (`anyDownload` / `tgDownload` flags). A desktop visitor is never
  promised a button that is not there. The footer wording is
  per-family: Kindle keeps the phone → `amazon.com/sendtokindle`
  steps; Kobo/PocketBook/generic get the on-device wording (tap the
  link on the device, file lands in the library; USB fallback).
- `functions/kindle/[[path]].js`: the `/kindle/` entry page's steps
  quote the new button labels for Kobo/PocketBook/generic (two
  one-line strings). Kindle and default (desktop) steps are
  byte-identical — the Kindle label still exists for Kindle UAs.
- `functions/kindle/get.js`: **unchanged**. The button target is the
  same `/kindle/get` URL as before; the delivery page already renders
  direct-download steps for Kobo/PocketBook and phone steps for
  Kindle/default (Workstream E). Token minting, caps, the short link,
  and the flag denylist are identical for every family.
- Format eligibility is **unchanged**: a MOBI/AZW3 book gets no
  download button for any UA (Workstream E §6 known limitation —
  a Kobo could read MOBI directly, but the button is hidden for
  MOBI/AZW3; NOT fixed here). Flagged books get no download button
  for any UA (the flag denylist beats the UA gate).

## 2. HONEST LIMIT — read this before believing the gate

**The User-Agent gate is a deterrent, not a hard block.** A
User-Agent is a self-asserted string: any desktop browser can send
`Kobo` in its UA and see the Kobo button in seconds. This is pinned
by a test on purpose (`book.test.mjs` M6: a desktop UA with `Kobo`
appended **does** see the button). Do not claim the gate alone
prevents downloads.

What actually bounds abuse — unchanged by this workstream:

1. **10-minute single-book tokens** (`functions/api/dl-token.js`):
   the short link works for one book for 10 minutes, then dies.
2. **5 downloads/day per user** (mint caps: 20/day per IP,
   5/day anonymous, 5/day fingerprinted after Workstream H).
3. **Flag denylist**: flagged books 403 on every issuance path,
   every UA.
4. **No bare file URLs** anywhere on the website (Workstream H).

Two consequences that follow from the design, stated plainly:

- **`/kindle/get` stays reachable by direct URL.** It must be: the
  phone half of the Kindle flow (open the short link on a phone,
  download, upload at Send to Kindle) and the bot's delivery link
  both need it. A desktop user who types a `/kindle/get` URL still
  gets the phone-flow page — still token-gated and capped, but not
  blocked. Removing the button removes the *offer*, not the endpoint.
- **The bot is unchanged.** The bot runs inside Telegram and sees no
  browser User-Agent, so it cannot tell a Kobo from a desktop. Its
  "Download the file" button still points at the same gated
  `/kindle/get` gateway (token + 5/day cap, never a file). Gating
  the bot link by device would need the user to declare their device
  (e.g. a `/mydevice` setting) — a separate decision, not taken here.

## 3. What each visitor sees (book page, one sendable EPUB card)

| Visitor UA | Email button | Download button | Reader button | Footer mentions download? |
|---|---|---|---|---|
| Kobo | ✅ primary | `📥 نزّل الكتاب على جهاز Kobo` | ✅ | ✅ on-device wording, no sendtokindle |
| PocketBook | ✅ primary | `📥 نزّل الكتاب على جهاز PocketBook` | ✅ | ✅ on-device wording, no sendtokindle |
| Generic e-reader (`eReader`/`EBRD`) | ✅ primary | `📥 جرّب تنزيل الكتاب على جهازك` | ✅ | ✅ on-device wording, no sendtokindle |
| Kindle | ✅ primary | `📥 احصل على الكتاب على جهازك` (phone → Send to Kindle) | ✅ | ✅ phone → sendtokindle wording |
| Desktop / mobile / no UA | ✅ primary | — none, no `/kindle/get` link on the page | ✅ | ❌ email only |
| Tolino / Boox | ✅ primary | — none (see §5) | ✅ | ❌ email only |

## 4. Files changed (this workstream)

Website only — merge by hunk on top of the consolidated website zip
(+ WS1/WS2/WS3). No bot change, no new endpoint, no new env var,
no new KV/D1 write, no paid service, no secrets.

- `functions/book.js` — `ereaderDownloadLabel()` + gate on both card
  types + family-aware footer/Telegram notes + banner label quotes.
- `functions/book.test.mjs` — A1/B1/B2/C2/F2/J1/L updated to the
  gate; new section M (M1–M9, incl. the M6 spoof pin).
- `functions/kindle/[[path]].js` — entry-page steps quote the new
  Kobo/PocketBook/generic button labels (2 strings).
- `docs/ereader-download-button.md` — this file.

Interaction with WS3 (merges last): WS3's `book.js`/`book.test.mjs`
are based on the pre-H version (they still parse `t.me` URLs and
have the old button order), so WS3 must be merged **by hunk**, not
by wholesale copy — its metadata hunks (file size / page count line)
do not overlap this workstream's hunks (button rendering, footer
notes, banner), so both coexist. If WS3 were copied wholesale it
would regress the WS-H gated links; that is a merger-order note,
not a change made here.

## 5. Open items / what still needs a decision or a live pass

1. **Kindle keeps its button — confirm.** Kindle UAs keep the
   existing `📥 احصل على الكتاب على جهازك` button because it is the
   phone → Send-to-Kindle path, not a direct download, and it is the
   fallback when email fails. If the user meant Kindle to lose the
   button too (email + reader only), that is a one-line change
   (`ereaderDownloadLabel("kindle")` → `""`) plus a reword of the
   `/kindle/` entry page's Kindle steps, which currently quote that
   button. Ask, do not assume.
2. **Bot link gating — needs a user call.** The bot's download link
   is the same token-gated gateway and is not UA-gated (no UA in
   Telegram). Options: leave it (current), or add a user-declared
   device setting. Not implemented here.
3. **Tolino / Boox get no button.** They are detected as e-readers
   by `isEReaderUA` (WS-I) but `detectEReaderFamily` returns `null`
   for them (no family), so this gate treats them like desktop.
   Follow-up: map them to the `generic` try-direct family (their
   browsers can download), or give them a family of their own.
   Needs a UA capture / verification first — do not guess.
4. **`/kindle/` entry page, default (desktop) steps.** They still
   quote the old `«احصل على الكتاب على جهازك»` label and describe
   the phone flow. A desktop visitor following them from the entry
   page will not find that button on `/book` any more (it exists
   only for e-reader UAs). If the entry page should speak to desktop
   visitors differently, that is a separate reword — not done here.
5. **`site/telegram/index.html` format chips.** They link to
   `/kindle/get` (WS-H) and are a static page with no server-side UA
   detection, so they are unchanged. A desktop visitor there can
   still reach the gateway (token-gated, capped). Same honest limit
   as §2.
6. **Live device tests (need real hardware — not done here):**
   M7 Kobo: open `/book` on the Kobo, see the Kobo button, tap it,
   tap the short link on the device → EPUB in the library.
   M8 PocketBook (touch model): same; non-touch model → USB
   fallback path. M9: capture the exact Kobo/PocketBook browser UA
   strings from a live request and add them verbatim to the test
   fixtures. M10: regression — Kindle flow unchanged (email primary,
   Get button present, phone → sendtokindle steps).

## 6. Tests run (all green, before zipping)

Run from a repo root with the five `search-index.json` files and
`site/telegram/index-0.json` present (Node v24.22.1, no network):

| Suite | Result |
|---|---|
| `functions/book.test.mjs` | **143 passed, 0 failed** (baseline consolidated: 128/0; +15: J1b + M1–M9) |
| `functions/kindle/get.test.mjs` | 51 passed, 0 failed (unchanged — token/cap/delivery-page behaviour intact) |
| `functions/kindle/proxy.test.mjs` | 45 passed, 0 failed (unchanged — covers the entry-page label change) |
| `functions/kindle/ua.test.mjs` | 37 passed, 0 failed (unchanged) |
| `functions/api/dl-token.test.mjs` | 58 passed, 0 failed (unchanged — 10-min token + 5/day cap enforcement intact) |
| `functions/api/tg-search.test.mjs` | 84 passed, 0 failed (unchanged) |
| `functions/api/send-to-kindle.test.mjs` | 133 passed, 0 failed (unchanged) |
| `functions/read.test.mjs` | 99 passed, 0 failed (unchanged) |
| `functions/api/read-token.test.mjs` | 12 passed, 0 failed (unchanged) |

What the new tests pin (section M): Kobo/PocketBook/generic buttons
with device labels under email (M1–M3); Kindle keeps its button +
sendtokindle footer (M4); desktop/iPhone/Android/no-UA get no
`/kindle/get` link and no download wording anywhere (M5/M5b/M5c/L5/L6);
a spoofed desktop UA **does** see the button (M6 — the honest limit,
asserted on purpose); flagged cards get no button even on Kobo (M7);
MOBI cards get no button even on Kobo (M9 — eligibility unchanged).

Pre-existing failures (verified identical on unmodified consolidated
code — not caused by this workstream):

- `functions/api/tg-search.test.mjs` crashes with `ENOENT:
  site/telegram/index-0.json` when run from a directory without the
  `site/telegram/` fixtures — a harness-data gap, not a code failure
  (passes 84/0 once the fixture is present, as above).
- `functions/new.test.mjs` crashes with `ERR_MODULE_NOT_FOUND:
  functions/new.js` and `functions/api/qurans.test.mjs` with
  `ERR_MODULE_NOT_FOUND: functions/api/qurans-data.js` — both source
  files are absent from the consolidated website zip itself, so the
  suites cannot run from that zip. Untouched by this workstream.

## 7. Rollback

Revert the three code/test files (single commit, no migration, no
KV/D1 state, no env change). The old behaviour (one generic Get
button for every visitor) returns immediately; no user data is
affected. The doc file can stay or go — it changes nothing at runtime.
