# Client-side converter (site/convert/)

The durable core of RliBook OCR: a static page that turns a scanned
book (PDF/JPG/PNG, ≤ 10 MB) into a text EPUB **entirely in the
user's browser**. No server, no account, no card, no expiry — this
path can never be switched off.

**BOT-ONLY (2026-11-16):** this page is opened only via the
Telegram bot's `/convert` command as a Mini App — it is NOT linked
from any public website page (no link from `/site/tools/`). When it
runs inside Telegram, a «📧 أرسله إلى إيميل الكيندل» button appears
next to the download button after the EPUB is built and POSTs
`{ initData, filename, epubBase64 }` to the bot's
`miniapp-convert-send` endpoint, which emails the EPUB to the
user's linked Kindle email (3/day, enforced by the bot). The
download button stays as a fallback. Conversion runs on the END
USER's device — nothing runs on the site owner's device.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page (Arabic RTL). File input, language + DPI settings, progress, result, cloud-enhancement settings. |
| `convert-app.js` | Main thread: pdf.js rendering (one page at a time), Tesseract worker lifecycle, IndexedDB progress/resume, EPUB zip (JSZip), enhancement queue client. |
| `ocr-client.js` | Pure logic, shared with the Node tests: script detection, routing, text cleanup, chapter split, EPUB parts, SHA-256. |
| `enhance-queue.js` | Per-page cloud enhancement queue (pure logic, tested in §K): which pages qualify (Arabic/mixed, or English on override `en`), language hints, POST to `/enhance-page`, silent fallback on any failure/quota/timeout. |
| `convert.test.mjs` | Node tests for `ocr-client.js` + `enhance-queue.js` — `node site/convert/convert.test.mjs` (68 checks). |
| `vendor/` | pdf.js, Tesseract.js (+ core + traineddata). See `vendor/VENDOR.md`. **No CDN at runtime.** JSZip is shared from `/site/reader/vendor/`. |

## How it works

1. **Pick a file.** PDF (via pdf.js) or a single JPG/PNG image.
   The file is hashed (SHA-256) — the hash is the IndexedDB key.
2. **Render** each page to canvas at 200 DPI by default
   (150/200/300, max 300). One page at a time; the canvas is
   released after each page.
3. **OCR** in Tesseract.js's own Web Worker (`ara+eng` in Auto,
   `ara` for Arabic / Classical Arabic, `eng` for English). The
   browser runs Tesseract — NOT the GPU engines (Baseer/Qari/
   PP-OCRv6 are 2–3B VLMs and cannot run in a browser). The
   routing table names those as the *cloud* tier's engines; the
   client maps them to Tesseract langs
   (`tesseractLangsForOverride`).
4. **Route + label** each page by script (Arabic Unicode range
   U+0600–U+06FF vs Latin) — the same thresholds as the bot
   (`src/ocr-lang.ts`) and the converter (`server.py`).
5. **Build the EPUB** in-browser: RTL per Arabic page, chapter
   split on headings (الفصل/الباب/المقدمة/Chapter…), TOC,
   `dc:language` ar/en (mixed books take the majority script's
   language, same as the converter — `mixed` is not a valid
   BCP47 tag for `dc:language`).
6. **Resume:** progress is saved to IndexedDB after every page.
   Close the tab, re-select the same file, and only the missing
   pages run again. A finished file offers the download at once.

## Quality labels

- **Standard quality** — the client-side result. Measured live
  2026-11-16: perfect on clean modern print (Arabic + English,
  4/4 lines exact), good on a real English scan (word-hit 0.88),
  poor on a 19th-century Arabic Naskh scan (word-hit 0.61).
- **Enhanced quality** — the same file re-OCR'd on a free GPU
  box (Baseer / Qari / PP-OCRv6). Only when the user configured
  a cloud URL (Settings on the page, stored in localStorage).
  The page health-checks the URL first; on failure, timeout,
  or quota exhaustion it keeps the standard EPUB and says so
  in one line — automatic silent fallback.

## Cloud enhancement (optional, operator setup)

The enhancement server is the converter in the bot repo
(`converter/server.py` — same deliverable, see
`docs/ocr-conversion.md` §3). Run it on a free GPU box:

- **Kaggle** — 30 GPU h/week (published quota). Notebook or
  batch job, `pip install -r requirements-vlm.txt`, run
  `server.py` with `CONVERTER_SECRET` set, expose the port.
- **Google Colab** — best-effort T4, same commands; the URL
  changes per session, so paste the new URL into the page's
  Settings each time.
- **Hugging Face ZeroGPU** — 5 min/day free, for a quick test
  only (not a daily driver).

Paste the URL into the page (Settings → save → health check).
The server must be reachable from the user's browser (CORS is
open on `/health` and `/enhance` for this purpose; the endpoint
is not a secret — the token budget is enforced server-side and
the EPUB it returns is the user's own file).

## Testing

- Node logic: `node site/convert/convert.test.mjs` — 68 checks.
- Real OCR: Tesseract.js v5 in Node on real Internet Archive
  scans (Arabic 19th-c. Naskh + English Pride & Prejudice) —
  see `docs/ocr-conversion.md` §5.
- Headless-browser end-to-end (the real page, real vendored
  libraries, real 2-page scanned PDF):

```bash
cd ~/workspace/rlibook-final-ocr/tests
python3 -m http.server 8137 --directory ~/workspace/rlibook-final-ocr/base &
node e2e-convert.mjs  # loads /site/convert/, converts scans-2page-a5.pdf
```

The script asserts: both pages OCR'd with the right script
labels, the EPUB downloads, and re-selecting the same file
resumes from IndexedDB instead of re-OCRing. The harness lives
in `~/workspace/rlibook-final-ocr/tests/` (NOT part of the
shipped site): `e2e-convert.mjs`, `probe-tess.mjs`,
`run-web-tests.sh`, `web-tests.txt`, `scans/` (real IA scans +
ground truth), `npm/` (pdfjs-dist, tesseract.js,
playwright-core). NOTE: do not keep the harness in /tmp — the
VM wiped /tmp mid-build on 2026-11-16 and the whole harness
had to be rebuilt from scratch.

## Known limits (honest)

- Tesseract strips tashkeel, so the client probe cannot detect
  diacritic-rich pages — use the «عربي تراثي» option for
  fully-vocalised classical texts (it forces Qari on the cloud
  tier and `ara` locally).
- Old-print Arabic is the weak case for the client engine; that
  is exactly what the enhancement queue is for.
- The page needs JavaScript and ~10 MB of vendored libraries on
  first load (cached afterwards). The Kindle's built-in browser
  is too weak for this page — use a phone or computer, then send
  the EPUB to the Kindle by email or via the bot's `/convert`.
