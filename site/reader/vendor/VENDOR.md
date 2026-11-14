# Vendored reader libraries

The reader uses **epub.js** (free, open-source, BSD-2-Clause) to open
EPUB files in the browser. Both files are vendored here so the reader
works offline and on the Kindle browser with no CDN dependency at
read time. No code was modified.

- `epub.min.js` — epub.js **0.3.93**
  (https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js)
  Source: https://github.com/futurepress/epub.js — BSD-2-Clause.
- `jszip.min.js` — JSZip **3.10.1**, required by epub.js
  (https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js)
  Source: https://github.com/Stuk/jszip — MIT (dual MIT/GPLv3, see the
  header inside the file).

To upgrade: download the new dist files from the same jsDelivr URLs
with the version changed, replace these two files, and re-run
`node site/reader/reader.test.mjs` plus the local render check in
README.md. Keep the two versions in step (epub.js 0.3.x needs
JSZip 3.x as the global `JSZip`).
