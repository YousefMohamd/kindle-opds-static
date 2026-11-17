# OCR conversion — architecture

RliBook turns a scanned book (PDF/JPG/PNG) into a text EPUB three
ways, in priority order. **The client-side converter is the durable
core and the best path; the cloud queue is a temporary quality
booster only; the bot's `/convert` is the no-browser path for
people who prefer Telegram.**

## 1. The three paths (priority order)

| # | Path | Where it runs | Quality | Needs |
| --- | --- | --- | --- | --- |
| 1 | **Client-side converter** — `/site/convert/` | The user's own browser (phone/computer) | Standard | Nothing — no server, no account, no card, no expiry |
| 2 | **Cloud enhancement queue** — same page, optional | Free GPU box (Kaggle / Colab / HF ZeroGPU) | Enhanced | An operator-configured URL (Settings on the page) |
| 3 | **Bot `/convert`** — Telegram | Same cloud converter, via the bot | Enhanced | Linked Kindle email; gated to e-reader devices; 3/day (+3/referral) |

Path 1 always works and never stops. Path 2 only improves the
result; if the cloud is down, slow, or out of quota, the page
keeps the path-1 EPUB and says so in one line — automatic silent
fallback. Path 3 exists for users who never open the website:
the bot sends the finished EPUB to the linked Kindle email ONLY
(never as a Telegram document, never available for download).

## 2. Language detection + routing table

Per-page script detection on OCR output: Arabic Unicode range
U+0600–U+06FF (plus presentation forms) vs Latin A–Z. Thresholds
(shared by the bot `src/ocr-lang.ts`, the client
`site/convert/ocr-client.js`, and the converter `server.py`):
`ARABIC_SHARE 0.7`, `LATIN_SHARE 0.3`, `MIN_LETTERS 10`,
`DIACRITIC_DENSITY 0.1`.

| Page script | Engine (cloud tier) | Client tier runs | Notes |
| --- | --- | --- | --- |
| Latin | **PP-OCRv6** (PaddleOCR) | Tesseract `eng` | Best English: ~4.5% CER vs ~18% Tesseract on the same community benchmark |
| Arabic, clean modern | **Baseer** (Qwen2.5-VL-3B fine-tune) | Tesseract `ara` | Lowest WER 0.25 on Misraj-DocOCR (400 pp.). **Weights are NOT publicly released** (no Misraj model repo; the paper points at the baseerocr.com SaaS) — so `CONVERTER_BASEER_MODEL` is empty by default and Baseer reports unavailable in `/health` until an operator supplies weights |
| Arabic, diacritic-rich classical | **Qari-OCR v0.2** (Qwen2-VL-2B fine-tune) | Tesseract `ara` | CER 0.061 / WER 0.160 **on its OWN 200-page diacritic-rich test set only** — do NOT quote 0.061 as a general Arabic figure (same model: WER 0.76 on Misraj-DocOCR). Verified live on Hugging Face 2026-11-16: `NAMAA-Space/Qari-OCR-0.2.2.1-VL-2B-Instruct` (public, PEFT adapter) |
| Mixed (both scripts) | Both, merged by script | Tesseract `ara+eng`, merged by script | `routePage` returns `also: "pp-ocrv6"` |
| Any (user override) | `/convertar` → Baseer, `/convertclassical` → Qari, `/converten` → PP-OCRv6 | Language select on the page | A Latin page under `ar-classical` still goes to PP-OCRv6 |

**Corrections enforced in code** (do not reintroduce):
- PaddleOCR-VL is ~94.5% on OmniDocBench v1.5 (all languages,
  not Arabic-only). **The 96.33% figure was NOT confirmed — never
  quote it.** (Guarded by a test in `test/ocr-lang.test.ts`.)
- Baidu Unlimited-OCR is **NOT** the Arabic champion: its Arabic
  is poor on historical scans (60–80% on 1890s Naskh, stray CJK
  glyphs) and its "99%/92% Arabic" figures are unverified
  (secondary summary, not the model card).
- The user does **NOT** have the Azure $100 Student credit — do
  not assume it. Free GPU actually available: Kaggle 30 h/week
  (published quota), Colab best-effort T4, HF ZeroGPU 5 min/day.
  Heroku is CPU-only and needs a card — not on the critical path.

**Honest limits of the client probe:** Tesseract strips tashkeel,
so `isDiacriticRich()` on Tesseract output is always false — the
client cannot detect diacritic richness; the `ar-classical`
override is the reliable path. (Same for the converter's probe:
it probes with PP-OCRv6 first unless the override forces a VLM.)

## 3. The converter service (cloud tier)

`converter/` in the bot deliverable (NOT copied into the bot repo —
same convention as round 1). `server.py` (FastAPI-style stdlib
server, v4.8.46): keeps the WS-G `/convert` protocol + EPUB
builder; adds per-page routing, the engine fallback chain
Baseer → PaddleOCR-VL → PP-OCRv6, content-hash caching
(`CONVERTER_CACHE_DIR`, `<sha256>.epub`, 1024 MB cap,
oldest-evicted-first — one conversion serves every later reader),
a daily page quota (`CONVERTER_DAILY_PAGE_BUDGET`, 0 = unlimited,
fails fast with a message pointing at the client-side converter),
`/health` (engines + quota + cache + enhance flag), and the
`/enhance` queue (disabled by default; `CONVERTER_ENHANCE_ENABLED=1`,
`CONVERTER_ENHANCE_DAILY_MAX` 20; cache-hit returns the EPUB at
once, otherwise 202 + `GET /enhance/<id>` polling; the EPUB is
served once, then dropped from memory).

The callback to the bot carries `quality` (`"enhanced"` unless
the engines are `["stub"]`), `engine` (joined, e.g.
`baseer+pp-ocrv6`), and `language`. Nothing is ever permanently
deleted; no file is hosted (metadata + streaming only).

### Running it on a free GPU box

```bash
# Kaggle notebook / batch job, or a Colab cell (T4):
pip install -r converter/requirements-vlm.txt   # torch + transformers + peft
CONVERTER_SECRET=<generated, never committed> python3 converter/server.py
# expose the port (Kaggle: public URL via the notebook; Colab: ngrok/localtunnel
# or the Colab-provided URL) and paste it into the convert page's Settings.
```

Qari loads as base Qwen2-VL + PEFT adapter (fallback built in);
Baseer stays unavailable until weights are supplied
(`CONVERTER_BASEER_MODEL`). PP-OCRv6 / PaddleOCR-VL run on CPU
too (slowly) — the GPU is what makes them practical.

## 4. The client-side converter (the core)

`/site/convert/`: `index.html` (Arabic RTL) + `convert-app.js`
+ `ocr-client.js` + `vendor/` (pdf.js 4.10.38, Tesseract.js
5.1.1, single-file core, `ara`+`eng` traineddata — **no CDN at
runtime**, ~11.3 MB) + `convert.test.mjs` (44 checks) +
`README.md` (operator setup). JSZip is shared from
`/site/reader/vendor/`.

Flow: file (≤ 10 MB) → SHA-256 (IndexedDB key) → pdf.js renders
one page at a time (200 DPI default, max 300, canvas capped at
~3500 px long side and released after each page) → Tesseract.js
in its own Web Worker (`ara+eng` auto, `ara`/`eng` forced) →
per-page script + route label → EPUB in-browser (RTL per Arabic
page, chapter split on الفصل/الباب/المقدمة/Chapter headings, TOC,
`dc:language` ar/en — mixed books take the majority script's
language, same as the converter, because `mixed` is not a valid
BCP47 tag) → download. Progress is saved to IndexedDB after
every page: re-select the same file and only missing pages run.

**Two real bugs found by the headless-browser test and fixed:**
1. Tesseract.js `corePath` must be a **directory** — the worker
   appends `tesseract-core-simd-lstm.wasm.js` (single-file core).
   A file path to the split `.js`+`.wasm` core hangs worker init
   forever (core `.js` fetched, no `.wasm`, no `eng` traineddata,
   stuck >300 s). Fixed 2026-11-16, proven by `probe-tess.mjs`.
2. JS `RegExp \b` is ASCII-only, so it can never match after an
   Arabic word — Arabic chapter headings (الفصل/الباب) never
   matched `CHAPTER_RE`. Replaced with an explicit
   `(?:[\s.:–-]|$)` separator and added مقدمة/المقدمة/خاتمة/الخاتمة.
   Also fixed: `cleanOcrText` now strips Tesseract control chars
   (`\f` page separators), and a stray block-scoped `canvases`
   variable that threw a `ReferenceError` at the end of every run.

## 5. What was tested live (and how many times)

All of it on this VM, 2026-11-16 (no GPU available — the GPU
engines were never run; see §6).

- **Real scans, Tesseract binary 5.3.4** (Arabic 19th-c. Cairo
  Naskh `Alf-Layla-Cairo` p. n10 + English Pride & Prejudice
  preface `prideprejudice00aust` p. n15, Internet Archive):
  Arabic CER ~0.64 / word-hit 0.61 (poor); English CER ~0.35 /
  word-hit 0.88 (good). Ground truth: IA `_djvu.txt` (itself
  imperfect OCR, so figures are approximate).
- **Clean rendered pages** (correct method: `arabic_reshaper`
  only, right-anchored): modern Arabic PERFECT 4/4 lines, English
  PERFECT 4/4, diacritic-rich Fatiha words perfect with **all
  tashkeel stripped** (→ the client probe limit in §2).
- **Tesseract.js v5 in Node**: ar-scan 7.7 s (poor, same as
  binary), en-scan 6.0 s (good), clean pages 0.7–0.9 s (perfect).
- **Client page end-to-end in headless Chromium (Playwright)** —
  `tests/e2e-convert.mjs`, run **twice** (first run found the two
  bugs above; second run clean): **15/15 checks, ~19 s** —
  both real scans OCR'd with the right script/engine labels
  (p.1 Arabic → baseer, 1110 chars; p.2 English → pp-ocrv6,
  1714 chars), EPUB downloaded and structurally valid
  (mimetype, OPF, nav, RTL chapter, real text), IndexedDB
  resume works (re-select → 2/2 at once, no re-OCR), zero
  page/console/request errors.
- **Probe** `tests/probe-tess.mjs` (worker init + canvas OCR):
  pass, ~4.5 s ("السلام عليكم / Hello world" recognised).
- **Node logic**: `site/convert/convert.test.mjs` **68/68**;
  bot `test/convert.test.ts` + `test/ocr-lang.test.ts`
  **56/56**; bot `tsc --noEmit` clean.
- **Full suites, twice on the final tree** (see the final report
  for both runs' numbers): website node tests, bot tsc + vitest,
  converter `tests/test_e2e.py` (**35 checks**: submit/callback/
  cache-hit/quotas/health/`/enhance` 200 + 202 + 404 paths).
- The harness lives in `~/workspace/rlibook-final-ocr/tests/`
  (NOT in the shipped zips). Do not keep it in /tmp — the VM
  wiped /tmp mid-build on 2026-11-16 and the harness had to be
  rebuilt from scratch (scans re-fetched byte-identical from IA).

## 6. What was NOT tested live (with exact live-test steps)

- **Per-page enhancement endpoint + queue — TESTED LIVE
  2026-11-17** (see `rlibook-ocr-enhanced/BUILD.md` for the full
  numbers). `POST /enhance-page` ran on the CPU-only VM with
  PP-OCRv6: the real English scan (`en-scan.jpg`, hint `en`)
  returned 32 lines in ~265 s with mean rec score 0.996 and all
  four must-phrases present ("Miss Austen", "Lydia Bennet",
  "Mr. Goldwin Smith", "Preface") and word precision 0.988 vs
  the book's DJVU text. The Arabic scan (`ar-scan.jpg`, hint
  `ar`) returned HTTP 200 but only the PP-OCRv6 probe text (5
  chars): the routed PaddleOCR-VL fallback failed to download
  its model ("No model source is available"), and the server
  fell back to the probe text instead of 502ing — the fallback
  worked as designed, but the probe (English PP-OCRv6) cannot
  read Arabic, so the Arabic result on CPU is effectively
  empty. A direct `snapshot_download` of PaddleOCR-VL-1.6 from
  Hugging Face then stalled at 51 KB on the ~1.8 GB model file
  (unauthenticated HF LFS is throttled from the VM) and was
  stopped.
  Two honest CPU findings: (1) PaddlePaddle
  3.3's OneDNN path crashes on the PP-OCRv6 detection model
  ("ConvertPirAttribute2RuntimeAttribute not support") — the
  server passes `enable_mkldnn=False` by default
  (`CONVERTER_PADDLE_MKLDNN=1` re-enables it); (2) CPU inference
  is ~4.5 min/page, so the 60 s browser queue timeout will skip
  CPU pages — the GPU path is the real route. The queue wiring
  itself is tested with a mock server
  (`rlibook-ocr-enhanced/tests/test-queue-mock-server.mjs`, 3/3)
  and in Node (`convert.test.mjs` §K, 24 checks): success-replace,
  429 quota-stop, 500/timeout skip-and-continue, oversize never
  sent. The server's own `/enhance-page` tests
  (`server/tests/test_enhance_page.py`, 9 checks, stub engine)
  cover the JSON shape, hints, 415/413/429, quota counters in
  `/health`, CORS, and no-files-left-on-disk.
- **Qari / Baseer / PaddleOCR-VL on a real GPU — still NOT run.**
  Qari could not run on the CPU-only VM in the 10-minute time
  box: the attempt never got past installing torch
  (download.pytorch.org timed out twice), so the ~4 GB Qari
  checkpoint was never even attempted — a 2B VLM needs 12 GB+
  VRAM in any case (see BUILD.md). The VLM
  loader (PEFT adapter fallback) is untested. To test live on a
  Kaggle GPU box, use the ready notebook
  `rlibook-ocr-enhanced/kaggle/ocr-enhance.ipynb` (Colab twin:
  `colab/ocr-enhance-colab.ipynb`):
  1. Upload the `server/` folder as a Kaggle dataset named
     `ocr-enhance-server` (or use the file uploader / a zip URL).
  2. Run the notebook cells in order: install → verify →
     start server → cloudflared tunnel → self-test. The tunnel
     URL is printed in a block — paste it into the converter
     page's Settings.
  3. `curl <url>/health` — expect `qari.available: true`
     (downloads ~4 GB on first run), `baseer.available: false`
     (no public weights — expected), `pp-ocrv6.available: true`.
  4. POST the real scans to `<url>/enhance-page` (hint `ar` /
     `en`) and compare the text against `tests/scans/djvu.txt` /
     `djvu-en.txt` (rough — the DJVU text is itself noisy OCR).
  5. Same from the convert page with the Kaggle URL in Settings:
     convert a scan, watch the Arabic pages gain the "✦ محسّنة"
     marker and the EPUB rebuild in place.
- **Browser page in a real (non-headless) browser** — only the
  headless-Chromium run above; a phone/computer smoke test
  (open `/site/convert/`, convert one scan) is still open.
- **Kindle/Kobo/PocketBook device paths** (from round 2) — still
  device-test-open, unchanged by this work.

## 7. Decisions still open

- **Baseer weights**: not publicly released. Until an operator
  supplies them (or Misraj publishes weights), Arabic clean
  pages fall back Baseer → PaddleOCR-VL → PP-OCRv6 on the cloud
  tier, and the fallback is named in the callback `engine` field.
  No decision needed to ship — the fallback is built.
- **Free-GPU host for the enhancement queue**: Kaggle is the
  standing recommendation (30 h/week, published quota); Colab
  is best-effort and its URL changes per session; HF ZeroGPU
  (5 min/day) is a quick-test only. The operator picks one per
  deployment; the page works fully with none configured.
- **Proxy signing-key rotation** (from round 2) is still pending
  and unrelated to OCR.
