# RliBook Block 15 — Tools / Extensions: review + decision

Date: 2026-11-14. Owner: Block 15 (website). The tools page is
`site/tools/index.html`. The bot change is NOT built here — see the v4.8.43
follow-up in `~/workspace/blocks-open-questions.md`.

## The decision (made at build time)

**ONE command collecting all tools, with internal buttons. Zero exclusive
buttons.** The placeholder name "/extension" is dropped; the proposed command
is `/tools` (label: الأدوات).

Reasoning: none of these tools runs inside the bot — the bot can only link to
a tool's own page/repo or show its steps. A button per tool would add 5+
top-level buttons that are all just links, and each tool is used rarely, one
at a time, by a different device owner. One command keeps the bot menu clean
and groups "things that prepare books for your reader" in one place. No tool
was judged frequent or central enough to earn its own top-level button — not
even Shamela/Turath, because it is a website you open in a browser, not a
bot action.

## Per-tool verification (all checked 2026-11-14, every link curl → 200)

### 1. RCloud — EXCLUDED, does not fit RliBook
- Verified: https://att.github.io/rcloud/ (200) + Journal of Data Science
  article (RCloud — Collaborative Visualization and Analysis Platform).
- What it actually is: an open-source, web-based collaborative data-analysis
  platform — R notebooks (cells in R/Python/Markdown) for statistics,
  visualisation and dashboards; notebooks stored as GitHub gists; public
  instance at rcloud.social. Licence: MIT (per GitPlanet record).
- Verdict: **exclude**. It is for documentation/analytics of R code, not for
  reading books, preparing book files, or anything a reader does. The user's
  note ("R notebooks in the cloud — for documentation/analytics only") is
  accurate, and "documentation/analytics only" is exactly why it has no place
  on a reading site. Not listed on the tools page. Decision: not inside the
  one command either.

### 2. shamela-epub-exporter — INCLUDED as a function, via its successor Turath
- Verified: https://github.com/yshalsager/shamela-epub-exporter (200, fetched
  2026-11-14). **Archived, no longer maintained.** README warning, in the
  author's own words: "This tool is no longer maintained, use
  https://app.turath.io/ to download EPUBs directly instead."
  Licence: **GPL-3.0**. 26 stars, 194 commits, created 2025-12-30.
  Was a browser extension + desktop/Android app: paste Shamela book URLs/IDs,
  get EPUB3 RTL files locally (bulk queue, TOC, footnotes, local .bok converter).
- The brief said this was "the NEWEST, replacing the old abandoned
  shamela2epub" — that was true when it was written, but verification shows
  this tool is now ALSO abandoned/archived. Listing the extension as a live
  tool would send users to dead software.
- Verified successor: https://app.turath.io/ (200, fetched 2026-11-14) —
  مكتبة تراث: 8,609 books, 3,192 authors, 40 sections, web app + desktop app,
  EPUB downloads directly.
- Verdict: **include the function (Shamela → EPUB) via Turath** on the tools
  page; link the archived repo only as a "do not install" note with its
  licence. Decision: inside the one `/tools` command (button: "الشاملة ← EPUB").

### 3. kindle-clock (mattzzw) — EXCLUDED, outside the reading scope
- Verified: https://github.com/mattzzw/kindle-clock (200, fetched 2026-11-14).
  KUAL extension that turns a jailbroken Kindle Paperwhite into a clock +
  weather display (updates every minute, suspends to RAM between updates,
  hourly ntpdate sync). Requires: jailbreak + KUAL + MRInstaller (fbink).
  Install: copy files to `/mnt/us/extensions/clock`, open KUAL → Clock; stop
  only by force reboot (hold power ~10 s). **No licence file in the repo.**
  Author's own status: "in early development"; battery "a couple of days at
  best" (author's calculation: ~8 days max on 1600 mAh, and he runs it from a
  power supply). 75 stars, last substantive work 2019-era.
- Verdict: **exclude**. It does not help reading at all — it stops the Kindle
  being a reader and turns it into a wall clock, at the cost of the battery
  (days instead of weeks) and a jailbreak-only install. It is a fun project
  for a spare Kindle, not a reading tool. Not listed on the tools page.
  Decision: not inside the one command either. (If the user later wants a
  "spare-Kindle projects" corner, this is the first candidate — recorded here
  so it is not re-researched from scratch.)

### 4. OCR — INCLUDED (two routes: KOReader + computer)
- KOReader built-in OCR verified:
  https://github.com/koreader/koreader/wiki/Dictionary-support (200) and
  https://github.com/koreader/koreader/wiki/Installation-on-Kindle-devices
  (200, via search result). KOReader has a built-in Tesseract OCR engine for
  scanned PDF/DJVU pages. Current KOReader uses Tesseract **5.3.4** data
  files (per koreader commit 5c9fdbc).
- Exact steps (from the wiki): (1) download language data for Tesseract
  4.00+ (e.g. `eng.traineddata`, `ara.traineddata`) into
  `koreader/data/tessdata`; (2) for languages other than English/Chinese,
  add the ISO 3-letter codes to `DKOPTREADER_CONFIG_DOC_LANGS_CODE` in
  `koreader/defaults.custom.lua`, e.g.
  `DKOPTREADER_CONFIG_DOC_LANGS_CODE = {"ara", "eng"}`. (The older user guide
  says `defaults.lua`; the wiki says `defaults.custom.lua` — the latter is
  the correct modern file, and it is what the page tells users.)
- Language files verified live (curl 200):
  https://github.com/tesseract-ocr/tessdata_fast/raw/main/ara.traineddata and
  .../eng.traineddata (tessdata_fast = the "fast" models the wiki points to).
- OCRmyPDF (computer route) verified: https://pypi.org/project/ocrmypdf/
  (200) and https://ocrmypdf.readthedocs.io/ (200). Licence **MPL-2.0**.
  Adds an invisible searchable text layer to a scanned PDF (wraps Tesseract;
  needs Ghostscript + Tesseract on PATH). Install: Debian/Ubuntu
  `sudo apt install ocrmypdf` (+ `tesseract-ocr-ara tesseract-ocr-eng` for
  Arabic/English packs); macOS `brew install ocrmypdf` (+
  `brew install tesseract-lang` for all language data — formula page curl 200);
  Windows via WSL. Command: `ocrmypdf -l ara+eng input.pdf output.pdf`
  (`--skip-text` for mixed docs, `--redo-ocr` to replace a bad layer).
- Verdict: **include both routes** on the tools page, clearly labelled by
  device (KOReader on the reader vs. computer before transfer). Decision:
  inside the one `/tools` command (button: "OCR — كتب ممسوحة").

### 5. go-comic-converter (celogeek) — INCLUDED
- Verified: https://github.com/celogeek/go-comic-converter (200, fetched
  2026-11-14). Licence: **MIT**. Active: v3.0.0, 140 stars, 458 commits.
- What it does: converts CBZ/CBR/ZIP/RAR/PDF/directory of images into EPUB
  for e-readers — all Kindle, Kobo, reMarkable, Apple Books. Profiles per
  device (e.g. SR = Kindle Standard Resolution 1200x1920); comic/manga
  (right-to-left)/webtoon modes; intelligent crop, double-page split; splits
  output at 200 MB by default (Send-to-Kindle website limit; email limit
  50 MB — use `-limitmb 50` for email).
- Install: `go install github.com/celogeek/go-comic-converter/v3`
  (needs Go; Alpine needs `apk add mupdf-dev` or `-tags nocgo`).
  Use: `go-comic-converter -profile SR -input ~/Download/MyComic.cbz`
  → `MyComic.epub` next to the input.
- Verdict: **include** on the tools page (device: computer). Decision:
  inside the one `/tools` command (button: "قصص مصوّرة ← EPUB").
- Note: Kindle Comic Converter (KCC, ciromattia/kcc, ISC) is a well-known
  alternative with a GUI; it was not in the brief, so it is recorded here
  only, not listed on the page.

### 6. quran-ebook (Quran, Block 13) — NOT rebuilt here, cross-link only
- Owned by Block 13. At build time (2026-11-14) no Qurans page exists yet in
  this repo (searched: no quran* file, no /quran/ path). The tools page
  therefore lists the Quran as a cross-reference card **without a hyperlink**
  (no guessed links) and says its page comes from Block 13. Wiring the real
  link is an open question for the coordinator (see blocks-open-questions.md).
- Decision: NOT a button inside `/tools` either — the Quran is a top-level
  RliBook section owned by Block 13, not a utility. The `/tools` message may
  carry one line pointing at it once its page exists.

### 7. Chess.js (Chess, Block 14) — NOT rebuilt here, cross-link only
- Owned by Block 14 (games; Chess.js in the browser). At build time
  (2026-11-14) no games/chess page exists yet in this repo. Same treatment
  as the Quran: cross-reference card on the tools page, no hyperlink, link to
  be wired when Block 14 lands (open question).
- Decision: NOT a button inside `/tools` — games are their own section owned
  by Block 14.

## Summary table

| Tool | Fits? | On tools page? | Bot: exclusive button or inside `/tools`? |
|---|---|---|---|
| RCloud | No — R data-analysis notebooks | No | Neither |
| Shamela → EPUB (via Turath; extension archived) | Yes | Yes | Inside `/tools` |
| kindle-clock | No — clock, not reading; jailbreak-only, early dev | No | Neither |
| OCR (KOReader + OCRmyPDF) | Yes | Yes | Inside `/tools` |
| go-comic-converter | Yes | Yes | Inside `/tools` |
| Quran (Block 13) | Yes, owned elsewhere | Cross-ref only | Neither (own section) |
| Chess (Block 14) | Yes, owned elsewhere | Cross-ref only | Neither (own section) |

## Rules honoured
- No tool files hosted on our server — every link points at the tool's own
  page/repo. No payment/card anywhere (all tools free + open source).
- No guessed links: every link on the page was curl-checked to 200 on
  2026-11-14 (list in the verification section of the Block 15 report).
  Quran/Chess have no link yet because their pages do not exist — not guessed.
- Brand colours used on the page: Sky Pale #DFF1F4, Sky Light #C4E0EB,
  Sky Blue #93D4EF, Sage #99B6B3, Olive Dark #44402F, Ink #1C2826.
- Each tool states in one line what it is for and which device it needs.
