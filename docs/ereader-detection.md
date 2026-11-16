# RliBook — E-Reader Detection: STRICT PLAN (Workstream E)

- **Date:** 2026-11-16
- **Base commit:** `4cb61d3` (GitHub main, `YousefMohamd/kindle-opds-static`, fetched live 2026-11-16)
- **Status:** Plan written FIRST, then implemented to it. Nothing in this plan is deployed by the build itself — the zip is a push block for the operator, same as the Kindle-delivery build.
- **Repo copy:** `docs/ereader-detection.md` (same text; the repo copy is canonical for the code).

## 0. What this feature is, in one paragraph

The User-Agent substring check that already exists (`Kindle`, `Kobo`, `eReader`, `EBRD`, `PocketBook` in `functions/kindle/[[path]].js`) stops being a Kindle-only layout switch and becomes a **per-family feature**: each detected family gets the delivery path that actually works on its hardware. Kindle keeps the phone → Send-to-Kindle flow, because its browser cannot download EPUBs. Kobo and PocketBook get a **direct-download flow on the device itself**, because their browsers can save an EPUB straight into the library. The generic tokens (`eReader`, `EBRD`) get a labelled try-direct flow. The token budget and caps do not change: the UA never gates a download, only the layout and the instructions.

## 1. Evidence ladder — read this before believing any claim below

Every claim in §2 carries one of these labels:

- **VERIFIED (device test)** — observed on a real device by the project (the Kindle EPUB block, 2026-11-12 screenshot).
- **VERIFIED (manual)** — stated in the manufacturer's own user manual.
- **VERIFIED (independent)** — stated by two or more independent sources that agree (a project doc, a forum device report, a manual).
- **ASSUMED** — one source only, or inferred from a related fact. The code must not present it as certain.
- **UNVERIFIED** — no source found. The code must say so on the page, or not claim it at all.

Sources consulted 2026-11-16 (all free, public):

| # | Source | What it establishes |
|---|---|---|
| S1 | Project record: Kindle "Invalid File Type" dialog, WhatsApp screenshot 2026-11-12; `docs/kindle-delivery.md`; `functions/book.js` header | Kindle browser refuses EPUB/PDF downloads; MOBI downloads; AZW3 hits the same error (BicBucStriim #287). VERIFIED (device test). |
| S2 | https://www.shishobooks.com/docs/0.4.0/ereader-browser | "A Kindle's browser downloads only MOBI and AZW3, and refuses EPUB, PDF… When the request's User-Agent contains `Kindle/`…"; "When the request's User-Agent contains `Kobo`, EPUB and CBZ download links use generated KePubs". Independent confirmation of S1 + the `Kobo` UA token. |
| S3 | https://grumpy.blog/en/kindle_paperwhite_browser/ | Real Kindle Paperwhite HTTP UA: `Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+`. |
| S4 | https://www.mangaconverter.com/tools/send-to-kobo | "The Kobo browser is a genuine one and downloads files properly"; "Kobo runs no receiving email service, so there is no address to send to"; browser at Settings → Beta features → Web browser; KEPUB native, plain EPUB opens. |
| S5 | https://www.mobileread.com/forums/showpost.php?s=758c0346e3a741bdf1287d7c616b1c5a&p=3140000&postcount=14 | MobileRead device report: "downloading a book with the [Kobo] browser will get it added to the library." |
| S6 | https://github.com/cgillinger/colophon/blob/HEAD/docs/kobo-sync-implementation-guide.md | Real Kobo UA (sync API): `Kobo Touch 0390/4.45.23684`. Note: this is the sync UA, not a captured browser UA. |
| S7 | https://deepwiki.com/welsot/kobo.gg/3.2-e-reader-optimized-routes | Independent project detects e-readers by UA containing "kobo" or "kindle" (case-insensitive) and serves a lightweight page. Precedent for the `Kobo` token. |
| S8 | https://www.usermanuals.au/pocketbook/inkpad-2/manual?p=78 | PocketBook InkPad 2 manual: "using the built-in web browser to download books directly"; Send-to-PocketBook to `username@pbsync.com`; formats incl. EPUB, PDF, MOBI. VERIFIED (manual). |
| S9 | https://manualmachine.com/pocketbook/colorlux/1716038-user-manual/ | PocketBook Color Lux manual: browser with a downloads history; book formats PDF, EPUB, FB2, DOC, DOCX, TXT, DjVu, RTF, HTML, MOBI. VERIFIED (manual). |
| S10 | https://www.inksky.org/post/pocketbook-tools-cloud-guide/ | Send-to-PocketBook email; PocketBook Cloud web upload; Dropbox; "I can browse it directly from the device, download any file with a tap." |
| S11 | http://thadafinser.github.io/UserAgentParserComparison/v3/detected/general/device-types.html | Real PocketBook UA in a UA-parser dataset: `Mozilla/5.0 (Linux like Android; en_US) AppleWebKit/534.34 PocketBook/515 (screen 600x800; FW W515.4.4.540) Mobile`. |
| S12 | https://www.getpocketbook.au/shop/p/pocketbook-verse | PocketBook Verse: 25 formats incl. EPUB, PDF, MOBI, AZW, AZW3, DOC, DOCX, TXT, FB2; built-in browser; PocketBook Cloud; OverDrive via browser. |
| S13 | https://www.desertcart.ec/products/386961024-pocketbook-inkpad-lite-e-book-reader-mist-grey (PocketBook FAQ section) | "Browser. Download books directly from your PocketBook device using a built-in web browser (**only for touch screen models**)." |
| S14 | Repo `docs/qurans.md` + project memory | KOReader: Kindle = jailbreak only; Kobo = installable with no jailbreak; PocketBook = installable. |
| S15 | Repo `docs/kindle-delivery.md` | Amazon removed "Download & transfer via USB" on 2025-02-26; Send-to-Kindle email + Send-to-Kindle for Web accept EPUB/PDF/DOC/DOCX/TXT. |

**What was searched for and NOT found (2026-11-16):** no device, manual, forum post, or UA dataset entry for a device whose User-Agent contains `EBRD` — the only `EBRD` on the web is the European Bank for Reconstruction and Development. No device whose UA contains the literal string `eReader` was found either. Both tokens stay in the matcher for backward compatibility (§4), but neither is a verified device family.

## 2. Per-family table — the strict contract

### 2.1 Kindle (Amazon) — VERIFIED

| Aspect | Claim | Evidence |
|---|---|---|
| Browser | WebKit, ES5-level; HTTP UA contains `Kindle/3.0+` | S3, S1 |
| File download in browser | **Cannot** download EPUB or PDF ("Invalid File Type" dialog, by Amazon design). MOBI downloads; AZW3 is refused like EPUB. | S1 VERIFIED (device test), S2 |
| Email | **Yes** — Send to Kindle (personal `@kindle.com` address, sender must be on the Amazon approved list) + Send to Kindle for Web (`amazon.com/sendtokindle`) | S15, project (tested end-to-end) |
| USB | **No** — Amazon removed "Download & transfer via USB" 2025-02-26 | S15 |
| KOReader | Jailbreak only | S14 |
| Formats the device reads | EPUB (via Send to Kindle conversion), PDF, MOBI, AZW3, TXT | S15, S1 |

**What the feature gives this family:** the existing flow, unchanged — `/kindle/` entry page with the Kindle banner and the 4-step summary; `/kindle/get` mints a 10-minute single-book short link (`/k/<code>`) that the user opens on a phone/computer, downloads there, and uploads at `amazon.com/sendtokindle`; reader (`/read`, EPUB only) and the Send-to-Kindle email as fallbacks.

**Access control:** UA substring `Kindle` gates the entry-page layout and banner only. It never gates the download: the short link must be openable from any modern browser (the phone/computer half of the flow).

**Abuse bounds:** same as the gated-delivery design — 10-minute single-book tokens, mint caps 20/day per IP / 5/day anonymous / 20/day fingerprinted, flag denylist (403 for flagged books, every UA). See §5.

**EXPLICITLY REFUSES:** it does not bypass Amazon's EPUB-download block; it does not prove the visitor is a Kindle; it does not host files; it does not push to the device without the user's Amazon login.

### 2.2 Kobo (Rakuten Kobo) — VERIFIED (independent)

| Aspect | Claim | Evidence |
|---|---|---|
| Browser | Built-in web browser under Settings → Beta features → Web browser | S4 |
| File download in browser | **Can** download EPUB/PDF directly; the file lands in the device library | S4, S5 VERIFIED (independent) |
| Email | **No** — Kobo runs no receiving email service; there is no address to send to | S4 |
| USB | **Yes** — copy EPUB/PDF to the device as a USB drive | S4, project knowledge |
| KOReader | **Yes, no jailbreak** | S14 |
| Formats the device reads natively | EPUB (KEPUB preferred, plain EPUB opens), PDF, MOBI, TXT, HTML, RTF, CBZ, CBR. **Not** DOC/DOCX, **not** AZW3 natively | S4 + Elipsa 2E spec (via search); DOC/AZW3 exclusion is ASSUMED from the format lists, not device-tested |

**What the feature gives this family:** a **direct-download flow on the device itself** — on `/kindle/get`, the short link is presented as a link to tap *here, on the Kobo*: the EPUB downloads straight into the library. Steps: (1) tap the short link on this device; (2) the book appears in the library; (3) fallback: open the same link on a phone/computer and copy via USB. The `amazon.com/sendtokindle` link and the Send-to-Kindle email link are **hidden** for Kobo — both are Kindle-only and showing them would be a step that is certain to fail (email: there is no Kobo address to send to). `/kindle/` shows a Kobo banner and the direct-download summary. The reader link stays (EPUB only).

**Access control:** UA substring `Kobo` gates the layout/instructions only. The short link itself is the same token-gated `/k/<code>` as for Kindle (same mint, same caps).

**Abuse bounds:** same as §5. Note the direct-download path does **not** weaken the bounds: the file still arrives only through the 10-minute token-gated short link; there is no open file URL.

**EXPLICITLY REFUSES:** it does not send by email (no such service exists); it does not convert EPUB→KEPUB (plain EPUB opens natively; KEPUB is an optimisation, not a requirement); it does not prove the visitor is a Kobo; it does not use Kobo's sync API (no `api_endpoint` change, no Kobo account — that is a different, larger feature, out of scope).

### 2.3 PocketBook — VERIFIED (manual)

| Aspect | Claim | Evidence |
|---|---|---|
| Browser | Built-in browser with a downloads history | S9 VERIFIED (manual) |
| File download in browser | **Can** download books directly ("using the built-in web browser to download books directly") | S8 VERIFIED (manual), S10 |
| Email | **Yes, its own** — Send-to-PocketBook, `username@pbsync.com`; plus PocketBook Cloud web upload and Dropbox | S8, S10 |
| USB | **Yes** — drag-and-drop as a USB drive | S8, S13 |
| KOReader | **Yes, no jailbreak** | S14 |
| Formats the device reads natively | EPUB, PDF, MOBI, AZW, AZW3, DOC, DOCX, TXT, FB2, DJVU, HTML, RTF, CHM | S9, S12 VERIFIED (manual/spec) |

**What the feature gives this family:** the same **direct-download flow** as Kobo — tap the short link on the device, the book lands in the library; USB fallback. Two honest notes on the page: (a) direct browser download is documented **only for touch-screen models** (S13) — non-touch models use the USB fallback; (b) our email link is Kindle-only and is therefore hidden — PocketBook's own Send-to-PocketBook address belongs to the user, not to us, and this site does not send to it (that would need the user's PocketBook address, which we do not ask for).

**Access control / abuse bounds:** same as Kobo (§2.2, §5).

**EXPLICITLY REFUSES:** it does not send to the user's `@pbsync.com` address; it does not prove the visitor is a PocketBook; it does not sync via PocketBook Cloud (no account, no API); it does not host files.

### 2.4 "eReader" (generic token) — UNVERIFIED as a device

| Aspect | Claim | Evidence |
|---|---|---|
| Browser / download / email / USB / KOReader | **Unknown.** No device was found whose UA contains the literal string `eReader`. | Searches 2026-11-16: none |
| What the token is | A generic word kept from the original matcher as a best-effort catch-all | Original code + `ua.test.mjs` §2 |

**What the feature gives this family:** a **labelled try-direct flow** — the page says plainly, in Arabic, that the exact device has not been verified ("لم نتحقق من جهازك تحديدًا — جرّب التنزيل المباشر أولًا") and offers: (1) tap the short link on the device and see if it downloads; (2) if it does not, open the same link on a phone/computer and copy via USB. No email link, no Send-to-Kindle link (both are Kindle-only). The reader link stays.

**Access control / abuse bounds:** same as §5. The generic flow grants nothing extra: same token, same caps.

**EXPLICITLY REFUSES:** it does not claim to know what the device is; it does not claim direct download works on it; it does not claim any email/USB capability for it.

### 2.5 "EBRD" (legacy token) — UNVERIFIED, no known device

| Aspect | Claim | Evidence |
|---|---|---|
| Device | **None found.** `EBRD` on the web is only the European Bank for Reconstruction and Development. | Searches 2026-11-16: none |

**What the feature gives this family:** exactly the generic try-direct flow of §2.4 — the token maps to the `generic` family in code, never to a named device, and the page never prints the word "EBRD" to the user (it would mean nothing to them).

**Removal rule (strict, dated):** the UA-logging action in §7 runs for two weeks. If no real request carrying `EBRD` is observed in that window, the token is **removed from the matcher** in the next cleanup (it matches nothing real and only widens the spoof surface). If a real `EBRD` UA *is* observed, it is added to the test fixtures verbatim and this section is rewritten with the real device. Until then the token is legacy, not a family.

**EXPLICITLY REFUSES:** everything §2.4 refuses, plus: it refuses to present `EBRD` as a device family anywhere (code, docs, or UI).

## 3. Detection design

- **Matcher (unchanged contract):** `isEReaderUA(ua)` — case-insensitive substring match on `["Kindle", "Kobo", "eReader", "EBRD", "PocketBook"]`. A substring, never an exact UA: firmware variations must not lock a real device out. Empty/missing UA → no match. Fire tablets (Silk UA, no `Kindle/`) → no match, by design (S2).
- **Family classifier (new):** `detectEReaderFamily(ua)` returns `"kindle" | "kobo" | "pocketbook" | "generic" | null`. Priority order: Kindle → Kobo → PocketBook → `eReader`/`EBRD` → generic. Order matters only for spoofed UAs that contain two tokens (no real device UA contains two); the order is documented in code, not silently assumed.
- **Family metadata (new, exported for tests):** `EREADER_FAMILIES` — per family: Arabic label, `delivery` (`"phone"` for Kindle, `"direct"` for Kobo/PocketBook, `"direct-try"` for generic), `directDownload` (false / true / `"try"`), `email` (Kindle-only), `usb`, `koreader`, and `nativeFormats` (Kobo: epub/pdf/mobi/txt; PocketBook: epub/pdf/mobi/azw3/doc/docx/txt; Kindle/generic: not applicable — Kindle goes through Amazon conversion, generic is unknown). Format notes on the delivery page are driven by this table, not by per-family `if` chains scattered through the page.
- **Where detection runs:** server-side, in the Pages Functions (`/kindle/` entry page, `/kindle/get`, `/book` banner). No JavaScript: e-ink browsers are ES5-level and the pages must work with JS off (existing constraint, kept).
- **What detection never does:** it never blocks a page (a non-matching UA gets the standard layout + note, never a block page); it never gates a download; it never identifies a person (UA string only, no IP logging in this feature — the §7 logging action logs UA strings only, same as the Kindle-delivery doc).

## 4. Per-page behaviour (the implementation contract)

### 4.1 `GET /kindle/` — entry page (`functions/kindle/[[path]].js`, `kindleEntryPage`)

| Family | Banner | Steps shown |
|---|---|---|
| Kindle | "أنت على جهاز Kindle — هذه الصفحة مخصصة لجهازك." | Existing 4 steps (phone → sendtokindle). Unchanged. |
| Kobo | "أنت على جهاز Kobo — يمكنك تنزيل الكتب مباشرة على جهازك." | Direct-download summary: search → open the delivery page → tap the short link on the Kobo → book in the library; USB fallback; browser is under Settings → Beta features → Web browser. |
| PocketBook | "أنت على جهاز PocketBook — يمكنك تنزيل الكتب مباشرة على جهازك." | Direct-download summary + note that direct download is documented for touch-screen models; USB fallback. |
| Generic | "يبدو أنك على قارئ إلكتروني." + "لم نتحقق من جهازك تحديدًا." | Try-direct summary + USB fallback. |
| None (desktop/phone/other) | Standard note (unchanged) | Kindle 4-step summary (unchanged — the desktop visitor is usually the phone/computer half of the Kindle flow). |

Plain HTML, no JS, `cache-control: no-store` (unchanged).

### 4.2 `GET /kindle/get` — delivery page (`functions/kindle/get.js`)

- **Token minting unchanged:** same `mintTokenForBook` call, same caps (20/day per IP, 5/day anonymous, 20/day fingerprinted), same 10-minute single-book short link, same flag denylist (403, no token minted), same 503/429/400 behaviour. No new endpoint, no new env var.
- **Kindle / no-UA (default):** the existing page, byte-identical in behaviour — 4 steps, `amazon.com/sendtokindle` link, reader link (EPUB only), email fallback link. All existing `get.test.mjs` assertions keep passing unchanged.
- **Kobo / PocketBook:** direct-download steps — (1) tap the short link *on this device*; the file downloads into the library; (2) open it from the library; (3) fallback: same link on a phone/computer + USB copy. **No** `amazon.com/sendtokindle` link, **no** email link (both Kindle-only). Reader link stays (EPUB only). Format note: if the book's format is in the family's `nativeFormats`, the page says it opens directly; otherwise it says the format may need Calibre/USB conversion (Kobo: DOC/DOCX/AZW3; PocketBook: none of the gated formats — all of epub/pdf/doc/docx/txt/mobi/azw3 are native).
- **Generic:** try-direct steps, labelled unverified; no sendtokindle link, no email link; USB + phone fallback.
- **MOBI/AZW3 note:** the Get button is already hidden for MOBI/AZW3 books on `/book` (Kindle-shaped gating — see §6 open item), so the delivery page's MOBI/AZW3 branches are defensive-only. On the direct families, MOBI downloads directly (native on both); AZW3 downloads directly on PocketBook, needs conversion on Kobo.

### 4.3 `GET /book` — search page (`functions/book.js`)

- A one-line family banner is inserted at the top of user-facing result/no-match/empty-search pages **only** for Kobo, PocketBook, and generic UAs (Kindle and desktop get no new banner — Kindle pages already speak Kindle; desktop is not an e-reader). Example (Kobo): "أنت على جهاز Kobo — اضغط «احصل على الكتاب على جهازك» ثم اضغط الرابط على جهازك، فينزّل الكتاب مباشرة في مكتبتك."
- The primary button label and target (`/kindle/get`) do **not** change: the delivery page, not the button, carries the per-family behaviour. Changing the label would churn the button contract for no user benefit.
- No change to search, ratings, flags, or the <8 KB page-size assertion (the banner appears only on e-reader UAs, and the size test uses no UA).

## 5. Access control & abuse bounds (unchanged, restated strictly)

- **UA IS ROUTING ONLY, NEVER ACCESS CONTROL (2026-11-16).** The UA picks which instructions and which format to offer (EPUB to Kobo/PocketBook, PDF + Send-to-Kindle guidance to Kindle). It proves nothing about the visitor's device, it is self-asserted and trivially spoofed, and it never changes who may download. The user accepted UA spoofing as a non-issue for e-readers (embedded/dumb devices — a regular user cannot exploit the loophole); the gate stays a deterrent + token budget, not a hard block.
- **UA gating stops casual users, not determined abuse.** Any desktop can send `Kindle` in its UA in seconds (`curl -A '...Kindle...'`). The tests assert this spoofability on purpose (`ua.test.mjs` §4) — any future change claiming the UA gate "stops" spoofing must fail that test first.
- **What actually stops bulk abuse:** (a) 10-minute single-book HMAC tokens (`v1.<payload>.<HMAC-SHA256>`); (b) mint caps — 5/day per IP, 5/day anonymous, 5/day fingerprinted (KV counters, fail open without KV); (c) the flag denylist — flagged books 403 on every issuance path, every UA; (d) random 16-char short-link codes with 10-minute KV TTL, one target per code, SINGLE-USE — the /k/ resolver deletes the entry on first successful resolve, so a replay 404s (2026-11-16, reversal of D5); (e) no bare file URLs on the website (OPDS books go through the short link; Telegram books through the signed proxy URL).
- **What the UA gate controls:** entry-page layout + banner, delivery-page instructions, book-page banner. Nothing else.
- **What is never gated by UA:** search, reading, the EPUB download itself (it must be fetchable from a phone/computer for the Kindle flow, and from the device browser for the direct flows), flagged-book refusal.
- **Free-tier budget:** no new KV/D1 writes, no new subrequests, no new env vars, no paid feature. The family classifier is a pure string function (zero cost). Same cost profile as the Kindle-delivery build.

## 6. Explicit refusals (the whole feature, in one list)

1. It does not prove the visitor's device (UA is self-asserted and spoofable).
2. It does not bypass Amazon's EPUB-download block on Kindle.
3. It does not host book files on our server.
4. It does not send email to Kobo (no such service). A PocketBook `@pbsync.com` address CAN be typed into the book page's email button (the endpoint accepts it, and PocketBook accepts a third-party sender after a one-time confirmation) — the delivery page only names it as guidance, it never links the endpoint there.
5. It does not use Kobo sync / PocketBook Cloud (no accounts, no API keys, no device credentials).
6. It does not convert formats (no EPUB→KEPUB, no server-side conversion).
7. It does not change the token scheme, the caps, the flag denylist, or the short-link TTL.
8. It does not block any visitor from any page.
9. It does not claim `eReader` or `EBRD` are verified devices.
10. It does not claim a Kobo/PocketBook direct download works on every model (PocketBook non-touch models are the known exception; Kobo's browser is a Beta feature that must be enabled).

**Known limitation, NOT fixed in this workstream:** `/book` hides the Get button for MOBI/AZW3 books because the gate is Kindle-shaped (Send-to-Kindle formats). A Kobo/PocketBook user *could* receive a MOBI book directly, but the button is hidden today. Fixing that needs per-family button gating on `/book` plus a catalog check (no MOBI/AZW3 book is in the five indexes today, 2026-11-14 — the branch is defensive-only). Recorded here; not silently fixed, not silently dropped.

## 7. What remains unverified + device tests

| # | Test | Needs |
|---|---|---|
| M7 | Kobo (real device): open `/kindle/`, see the Kobo banner; search → delivery page → tap the short link **on the Kobo** → EPUB in the library | A Kobo + Wi-Fi |
| M8 | PocketBook (real device, touch model): same as M7; plus a non-touch model → USB fallback path | A PocketBook + Wi-Fi |
| M9 | Kobo browser UA: capture the exact `User-Agent` the Kobo browser sends (HTTP header) and add it verbatim to `ua.test.mjs` | M7 device, or a log line |
| M10 | PocketBook browser UA: same capture (the fixture in the tests is from a UA-parser dataset, S11 — real string, but not observed by us) | M8 device, or a log line |
| M11 | Generic: any real UA containing `eReader` or `EBRD` observed in logs → add verbatim + rewrite §2.4/§2.5 with the real device; if none in 2 weeks, remove `EBRD` from the matcher (§2.5) | 2 weeks of UA logging |
| M12 | Regression: Kindle flow unchanged (M3 from the Kindle-delivery doc, re-run after this change) | The user's Kindle |

**UA logging action (from the Kindle-delivery doc, extended):** log the full UA of requests to `/book` and `/kindle/` for two weeks (UA string only, no IP, no personal data), then publish the observed strings in the repo and tighten the matcher to what real devices actually send. No verified 10th-gen Kindle UA string exists yet; do not guess one and match it exactly.

## 8. Files changed (this workstream)

- `functions/kindle/[[path]].js` — `detectEReaderFamily` + `EREADER_FAMILIES` + family-aware `kindleEntryPage`. `isEReaderUA` contract unchanged.
- `functions/kindle/get.js` — family-aware delivery page (direct / try-direct / Kindle branches). Token minting, caps, short links unchanged.
- `functions/book.js` — family banner for Kobo/PocketBook/generic UAs. Button, search, flags unchanged.
- `functions/kindle/ua.test.mjs` — family-classifier tests + real UA fixtures (S3, S6, S11) + spoof/priority tests.
- `functions/kindle/proxy.test.mjs` — entry-page tests per family.
- `functions/kindle/get.test.mjs` — delivery-page tests per family (direct steps, no Kindle-only links for Kobo/PocketBook, format notes).
- `functions/book.test.mjs` — banner tests per family.
- `docs/ereader-detection.md` — repo copy of this plan.
- `docs/kindle-delivery.md` — endpoint table + access-control section updated to point at this plan (no behaviour change).

## 9. Rollback

Every change is presentation + one pure classifier function. Rollback is: revert the four code files and the four test files (single commit, no migration, no KV/D1 state, no env change). The old behaviour (Kindle-only layout for every e-reader UA) returns immediately; no user data is affected.
