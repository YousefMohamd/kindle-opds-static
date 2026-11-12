# /catalog/ — dictionary download page (RliBook)

Live route (after deploy): https://rlibook.tech/catalog/
Direct file: https://rlibook.tech/catalog/RliBook-Catalog.mobi

## What it is

The dictionary download page — the FIRST GATEWAY the Home file v3
(RliBook-Home-ar.epub / RliBook-Home-en.epub) links to. The user taps
"حمّل القاموس / Download the dictionary" in Home, lands here, taps the
big link, and the .mobi downloads directly in the browser (the browser
accepts .MOBI files; it blocks .EPUB/.PDF — that is why the dictionary
is a .mobi, not an .epub).

## Files

- `index.html` — the download page (bilingual, Arabic-first, no JS).
  Links to `RliBook-Catalog.mobi` (relative), the bot, /book, /new, /.
- `RliBook-Catalog.mobi` — the dictionary file itself, served as a
  plain static file. Current copy: the v3.1 test build
  (405,343 bytes, SHA256
  76e1a80dc71f81d0ea9b229aa95e3ba5b79f22d5a358272b0d55586cea14491f),
  copied from ~/workspace/rlibook-catalog-dict-test/RliBook-Catalog-Test.mobi.

## Why a static file (not a Function / KV / D1)

- 405 KB is far under Cloudflare Pages' 25 MB per-file limit.
- No Function, no KV binding, no D1, no extra moving part: the file is
  served as-is with its normal MIME type.
- The URL is STABLE: when the dictionary is rebuilt, replace this one
  file (same name) and the Home button, the download page, and every
  saved link keep working.

## Deploy (NOT done — needs a commit + push)

From the repo root:

    git add catalog/
    git commit -m "[catalog] dictionary download page + .mobi (Home v3 gateway)"
    git push

Then verify live:

    curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://rlibook.tech/catalog/
    curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" https://rlibook.tech/catalog/RliBook-Catalog.mobi

Expect 200 for both. The .mobi should come back with a mobipocket
content type (or application/octet-stream — either downloads fine).

## Updating the dictionary later

1. Rebuild the dictionary (bot/dict build).
2. Replace `catalog/RliBook-Catalog.mobi` with the new file (same name).
3. Commit + push. Nothing else changes — no Home rebuild needed.
4. The bot ALSO sends the new dictionary automatically on Telegram
   (that is the automatic update path stated in Home v3); this page is
   the re-download path (no USB needed).
