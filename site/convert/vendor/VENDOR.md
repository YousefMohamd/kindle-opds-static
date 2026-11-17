# Vendored converter libraries

The client-side converter runs with **no CDN at runtime**: every
library and model file below is served from this directory, so the
page keeps working even if a CDN is unreachable. No code was
modified.

- `pdf.min.mjs` + `pdf.worker.min.mjs` — pdf.js **4.10.38**
  (legacy build, ESM) — renders PDF pages to canvas.
  npm: `pdfjs-dist@4.10.38` — Apache 2.0.
  Source: https://github.com/mozilla/pdf.js
- `tesseract.min.js` + `worker.min.js` — Tesseract.js **5.1.1**
  (UMD main + worker). Tesseract.js spawns its own Web Worker,
  so OCR never blocks the page.
  npm: `tesseract.js@5.1.1` — Apache 2.0.
  Source: https://github.com/naptha/tesseract.js
- `tesseract-core-simd-lstm.wasm.js` — the Tesseract core
  (SIMD + LSTM) that the worker loads. This is the single-file
  build (wasm embedded, 3.9 MB): `corePath` points at this
  directory and the worker appends this filename. The split
  `.js` + `.wasm` pair is deliberately NOT vendored — a file path
  to it hangs worker init (the `.wasm` fetch never resolves
  inside the worker; proven live 2026-11-16). Only this one core
  variant is vendored; the other variants in `tesseract.js-core`
  are not needed.
  npm: `tesseract.js-core@5.1.1` — Apache 2.0.
- `traineddata/ara.traineddata.gz` (725 KB) +
  `traineddata/eng.traineddata.gz` (1.98 MB) — Tesseract language
  data (tessdata_fast), Apache 2.0.
  Source: https://github.com/tesseract-ocr/tessdata_fast

Total: ~8.3 MB. Each file is far under the 25 MB Cloudflare
Pages file limit.

To upgrade: `npm install pdfjs-dist@<v> tesseract.js@<v>` and
copy the same filenames from `node_modules/`, refresh the
traineddata from tessdata_fast, then re-run
`node site/convert/convert.test.mjs` and the headless-browser
end-to-end check in `site/convert/README.md`.
