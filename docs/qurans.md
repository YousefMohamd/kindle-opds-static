# Qurans — Block 13 (RliBook)

## The tool (verified 2026-11-14)

**zeeyado/quran-ebook** — open source, **GPL-3.0**, public repo, not archived.

- Repo: https://github.com/zeeyado/quran-ebook
- **Releases: https://github.com/zeeyado/quran-ebook/releases/latest**
  (verified: redirects to the latest release **v0.10.0**, published 2026-03-19;
  152 EPUB assets; direct download URLs verified with HTTP 200, e.g.
  `https://github.com/zeeyado/quran-ebook/releases/download/v0.10.0/quran_hafs_kfgqpc_inline_ar.epub`)
- Description: "A configurable Quran ebook generator with correct Arabic
  rendering." Pre-built EPUBs in **42 languages**, best used in KOReader.

## What it provides

- **Formats (per translation, up to 3 + Arabic-only):**
  - **Bilingual** — Arabic + translation together, ayah by ayah. For studying
    or reading with a translation side by side.
  - **Interactive** — Arabic only; tap an ayah number marker to see the
    translation in a footnote popup. For reading Arabic with occasional
    reference to the translation.
  - **Word-by-Word** — each Arabic word with its meaning directly below,
    then a full sentence translation after each ayah. 8 languages have
    native word-level glosses; all translations also have an English-gloss
    WBW variant (plus an Indonesian gloss for Malay).
  - **Arabic-only** — continuous flowing text, no translation (identical
    layout to Interactive).
- **Narration:** all released EPUBs are **Hafs 'an 'Asim**, anchored to the
  Madinah Mushaf (1405 AH / **604 pages**). **Warsh 'an Nafi'** is an
  **experimental** Arabic-only build (6,214 ayahs, Madani numbering;
  no calligraphic surah headers, single waqf marker type, dictionaries
  keyed to Hafs so lookups misalign in 50 surahs; no bilingual/interactive/
  WBW for Warsh yet).
- **Tafsir: 20 tafsirs in 6 languages, EMBEDDED in the Quran file
  (WS1 2026-11-16, supersedes the old plugin route):** each tafsir is
  built into a Quran EPUB as endnotes (one note per commentary chunk;
  every ayah number links to its note, EPUB3 noteref/footnote). The
  user downloads ONE file — «المصحف + التفسير» — opens it, taps any
  ayah number, and reads the tafsir. No plugin, no ZIP, no install
  steps; works on a stock Kindle, in KOReader, or any EPUB reader.
  The 19 combined files (all tafsirs except Kurdish) are prebuilt
  once, offline, by `tools/build-quran-tafsir.py` (Python stdlib
  only: parses the StarDict set, injects the notes, verifies every
  link) and published as GitHub Release assets on the RliBook repo
  under tag `quran-tafsir-v1` — nothing hosted on our server.
  The old route still exists for KOReader users who already use it:
  each tafsir is ALSO a StarDict dictionary (`koreader/data/dict/`,
  read by the Quran Helper plugin on long-press) — but it is no
  longer what the bot or the page recommends. **The user chooses
  the tafsir they like**; Warsh has no combined build (its ayah
  numbering differs from the Hafs numbering the tafsir keys use),
  and Kurdish has none (no Kurdish Quran edition in the catalogue):
  - Arabic (7): al-Muyassar, al-Sa'di, al-Baghawi, Ibn Kathir, al-Wasit
    (Tantawi), al-Qurtubi, al-Tabari
  - English (3): Tazkirul Quran (Wahiduddin Khan), Ibn Kathir (Abridged),
    Ma'ariful Qur'an (Mufti Shafi)
  - Urdu (4): Tazkir ul Quran (Wahiduddin Khan), Bayan ul Quran (Israr
    Ahmad), Ibn Kathir, Fi Zilal al-Quran (Qutb)
  - Bengali (4): Ahsanul Bayaan, Abu Bakr Zakaria, Fathul Majid, Ibn Kathir
  - Russian (1): al-Sa'di; Kurdish (1): Rebar
  - Tafsir zips live in the upstream repo under `release/` and are fetched
    from `raw.githubusercontent.com/zeeyado/quran-ebook/main/release/
    quran_tafsir_<name>_v1.1.zip` (verified 200). Sizes taken from the
    upstream README table.
  - Two upstream facts the build had to handle: an abridged tafsir may
    not cover every ayah — Ibn Kathir (English) has 6,231/6,236 (no
    Al-Fil) and Tazkirul Quran 5,784/6,236 — uncovered ayahs simply
    get no link; and the fragments are HTML, not XHTML (bare `<br>`,
    unquoted attributes, a custom `<quran ref=/S/A>` cross-reference
    element, one `<b<` typo) — the builder normalises them.
- **KOReader plugin extras:** per-instance word dictionary, grammar
  dictionaries (WBW + syntax + i'rab), surah overviews, juz'/surah name
  in the status bar.

## Reader compatibility (why the page warns)

Upstream README, verified: the EPUBs use embedded Arabic fonts + EPUB3
features most proprietary readers mishandle.

- **KOReader = the full experience** (Android, Kobo, Kindle, PocketBook,
  Linux). Essential settings: Embedded Style/Fonts on, footnote popups on,
  RTL page turns inverted, stable (mushaf) page numbers.
- **Stock Kindle does NOT render Arabic EPUBs correctly** — requires
  jailbreak + KOReader. The page says this plainly so nobody downloads a
  file that does not work on their device. Sending by email does not fix
  it on a stock Kindle.
- Kobo native reader struggles with Arabic — install KOReader (no jailbreak).
- Apple Books: mostly works; some interactive features may not fully work.
- Calibre viewer (Windows/Mac/Linux): mostly works.

## Sourcing + delivery design

**No Quran file is stored on our server — ever.**

- Website page (`site/qurans/index.html`) links to the upstream Releases
  (direct per-edition download URLs) and to the bot. It hosts nothing.
- API (`functions/api/qurans.js`, data in `functions/api/qurans-data.js`):
  curated catalogue of **49 editions in 10 languages** (Arabic Hafs +
  Warsh; English ×5 translators; French, German, Spanish, Turkish, Urdu
  ×2, Indonesian, Russian, Bengali — bilingual/interactive/WBW where the
  release has them) + the 20 tafsirs. Every filename + size was checked
  against the real v0.10.0 asset list at generation time; the generator
  (`/tmp/gen-qurans.mjs`, kept outside the repo) refuses to emit a missing
  file. Filters: `?lang=&format=&narration=`; `?tafsir=<lang>` returns
  tafsirs only. Every tafsir entry carries `combined` (the Quran EPUB
  with that tafsir embedded: file + URL on the RliBook release
  `quran-tafsir-v1`, or null for Kurdish). The full 42-language list
  lives only at the upstream Releases — we do not mirror it.
- OPDS (`functions/opds/qurans.js`): acquisition feed at `/opds/qurans`
  (49 Quran entries + 20 tafsir entries + 19 combined Quran + tafsir
  entries; acquisition links point at the upstream release EPUBs / raw
  tafsir zips / RliBook combined EPUBs). `?lang=` filters. The exact
  file route takes precedence over the `functions/opds/[[fp]].js` catch-all
  in Pages routing — verify live after deploy.
- Bot (v4.8.43+; WS1 2026-11-16): button "اطلب المصحف الالكتروني" under
  "Add or send a book"; questionnaire (language → format → narration
  → tafsir → delivery); a picked tafsir delivers the COMBINED Quran +
  tafsir EPUB (one file, tafsir inside) by email (Kindle/PocketBook)
  or as a Telegram document for USB. Warsh offers "no tafsir" only
  (no combined Warsh build). If the combined file cannot be fetched,
  the plain Quran goes out with the combined download link.

## Files (Block 13)

- `site/qurans/index.html` — the Qurans page (brand colours, Arabic RTL,
  static tables generated from the verified catalogue + JS filters).
  Each tafsir links its combined «المصحف + التفسير» EPUB first, then
  its StarDict ZIP. The JS version check rewrites ONLY upstream
  zeeyado release links — never the combined RliBook release links.
- `functions/api/qurans.js` + `functions/api/qurans-data.js` — JSON catalogue.
- `functions/api/qurans.test.mjs` — 22 checks.
- `functions/opds/qurans.js` — OPDS acquisition feed.
- `functions/opds/qurans.test.mjs` — 12 checks.
- `tools/build-quran-tafsir.py` — builds the 51 combined Quran + tafsir
  EPUBs (Hafs only; every edition × tafsir pair) + `manifest.json`
  (file, size, sha256, release URL) for the `quran-tafsir-v1` release.
- `docs/qurans.md` — this file.

## Open items (also in blocks-open-questions.md)

- `_redirects` needs one line so the page is reachable at `/qurans/`:
  `/qurans/*  /site/qurans/:splat  200` (same pattern as `/newspapers/`).
  Not added here — `_redirects` is concurrently edited by other blocks.
- Add a Qurans entry to the combined catalog `index.xml` (and the
  personal OPDS nav in `functions/opds/[[fp]].js`) so KOReader users
  discover `/opds/qurans` — those files belong to other owners.
- Wire the Quran card link in `site/tools/index.html` to `/qurans/`
  (Block 15 left it unlinked, awaiting this block).
- The front page (index.html, other owner) links to the Qurans page from
  under the newspapers section.
- Regenerate the catalogue when upstream ships a new release (re-run the
  generator against the new tag; do not hand-edit filenames).
