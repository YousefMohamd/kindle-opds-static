# RliBook compatibility checklist (Block 11c)

The user's rule: **the tools, the plan, and everything executed in the
project must support all versions and every e-reader device and any
device, old or new.** This document is the checklist, the audit of the
existing pages against it, and the exact fixes still needed.

## The checklist

A page (or tool output) is compatible when ALL of these hold:

| # | Rule | Why |
|---|------|-----|
| C1 | **Kindle browser is the baseline** — old Kindle (2012–2016 firmware, experimental browser) and new Kindle must both render the page. | The user reads on Kindle; the old browser is the weakest device in the project. |
| C2 | **KOReader, Kobo, Boox, Tolino** — the OPDS catalogs work in KOReader; the HTML pages must render in Kobo/Boox/Tolino browsers too (same old-WebKit baseline as C1). | "Every e-reader device", not just Kindle. |
| C3 | **iPad, mobile, desktop** — the same pages, no app, no install. | The site is the universal front-end. |
| C4 | **No ES2022-only JavaScript** — and in practice no ES2015+ feature without a guard: no arrow functions, no `async/await`, no optional chaining, no spread, no `Promise.finally`, no `String.normalize` unless guarded. Plain ES5-style JS + `fetch` with an XHR/`<noscript>` fallback. | Old Kindle browsers predate ES2015; an unguarded modern call throws and the whole page dies. |
| C5 | **No framework, no build step, no CDN** — plain HTML/CSS/JS only, zero external resources (no Google Fonts, no JS library). | A CDN or webfont the Kindle cannot fetch breaks the page; a framework is weight the device cannot afford. |
| C6 | **Small files** — CSS < 10 KB, each HTML page < 20 KB, images downscaled (header logo ≤ 10 KB, large logo ≤ 100 KB). No page may require downloading tens of MB to work. | E-ink devices are slow and memory-poor; the search page's 66 MB shard download (see F5) is the one breach. |
| C7 | **No feature that requires a new browser** — no `position: sticky`, no CSS grid/flex layout dependency, no `backdrop-filter`, no `var()`-only styling (custom properties are fine as progressive enhancement, never as the only way to set a colour). Layout must survive without flexbox. | Old WebKit implements flexbox partially or not at all. |
| C8 | **No colour emoji as the only signal** — 📚 📰 📧 ⚑ and similar must never carry meaning alone; old Kindle firmware has no colour-emoji font and shows tofu boxes. Text labels always accompany them (or replace them). | A button that is only an emoji is unreadable on an old Kindle. |
| C9 | **Works without JavaScript where possible** — search results, book pages and newest books are server-rendered HTML (`/book`, `/new`); a page that needs JS shows an honest fallback (link to raw JSON / a server page) instead of a white page. | The Kindle browser's JS engine is the first thing to fail. |
| C10 | **Arabic-first, RTL, system fonts only** — `lang="ar" dir="rtl"`, no webfont download; brand fonts (Cabinet Grotesk Light, Cintarini) are named first in the stack with system fallbacks. | Webfonts are a large download that may fail on e-readers. |
| C11 | **No book files on our server, legal sources only, rlibook.tech only** (pages.dev as fallback) — never yousefmohamed.studio. | Project-wide rule, checked here because a compat "fix" must never add a hosted file or a new domain. |

New files built under Block 11c already meet this checklist by
construction: `site/assets/rlibook.css` (6.3 KB, plain CSS, no
framework, no webfont), `site/stats/index.html` (10.5 KB, ES5-style
script, `fetch` guarded, `<noscript>` fallback, logo 10 KB), the
stats endpoint (JSON only, no client weight). The shared stylesheet
is the single source for the button, card, header and search-box
styles — pages that cannot link it (server-rendered Functions pages)
copy the same values by hand.

## Audit of the existing pages (checked 2026-11-14)

### `/` — `index.html` (root) — MOSTLY COMPLIANT
- No JavaScript, simple CSS, 3.4 KB, no external resources. Passes C4–C7, C9–C11.
- **F1 (C8, minor):** emoji in headings — `📚` in `<h1>` (`index.html:27`), `📰` in the newspapers heading (`index.html:52`). Old Kindle shows tofu boxes. The text next to them still reads fine, so this is cosmetic, not breaking.
- **Fix F1:** drop the emoji or keep them only beside a full text label (they already sit beside text — removing them is the safe one-line change). Owner: the agent who owns `index.html` (not Block 11c).

### `/book` — `functions/book.js` — COMPLIANT except emoji
- No client JavaScript, minimal inline CSS, tiny page, server-rendered — built for the Kindle browser. Passes C1–C7, C9–C11.
- **F2 (C8, minor):** `📚` in the page heading (`functions/book.js:191`), `📧` on every send button (`:311`, `:346`), `⚑` flag marker (`:336`, `:340`). On an old Kindle the send button may show a tofu box before the words "أرسل إلى جهازي" — the words are there, so the button still works, but the flag marker `⚑` is a bare symbol whose meaning is lost if the glyph is missing.
- **Fix F2:** remove `📚`/`📧` (the text label is enough) and replace the bare `⚑` with the word "تجاري" (already present as "⚑ تجاري" — dropping the glyph keeps the meaning). Owner: the agent who owns `functions/book.js` (not Block 11c — do not edit).

### `/new` — `functions/new.js` — COMPLIANT except emoji
- Same construction as `/book`: no client JS, minimal CSS, server-rendered. Passes C1–C7, C9–C11.
- **F3 (C8, minor):** same emoji as `/book` — `📚` heading (`functions/new.js:183`), `⚑` flag marker (`:266`, `:270`, `:286`).
- **Fix F3:** same as F2. Owner: the agent who owns `functions/new.js`.

### `/newspapers/` — `site/newspapers/index.html` — MOSTLY COMPLIANT
- No JavaScript, static content injected at build time, 1.6 KB, no external resources. Passes C4–C7, C9–C11.
- **F4 (C8, minor):** `📰` in `<h1>` (`site/newspapers/index.html:22`), same cosmetic tofu risk as F1.
- **Fix F4:** drop the `📰` (the heading text "صحف اليوم حسب البلد" is complete without it).

### `/telegram/` — `site/telegram/index.html` — NOT COMPLIANT for old Kindle (the one real gap)
- Small HTML (11 KB), no external resources, no framework. Passes C5–C7, C10–C11.
- **F5 (C4 + C6, BREAKING on old Kindle):** the search script uses unguarded modern JavaScript, and search requires downloading the whole index before it works:
  - `String.prototype.normalize("NFKC")` (`:69`) — ES2015; missing on old Kindle browsers, so the first keystroke throws and search dies.
  - `Promise.all(...).finally(...)` (`:136`) — `.finally` is ES2018; missing on most old WebKits, so the shard load never clears its loading state.
  - Arrow functions, `Map`/`Set`, spread (`[...map.values()]`), `String.includes` (`:81`, `:116`, `:128`, `:151`, `:166`, `:180`, `:204`) — ES2015; any one of them throws on a pre-2016 browser.
  - `fetch` (`:129`, `:224`) with no XHR fallback — the oldest Kindle browsers have no `fetch`; the page then shows only "تعذّر تحميل الفهرس".
  - **Weight:** a search loads all four shards (`index-0.json` … `index-3.json`, ~66 MB total) and `JSON.parse`s them in memory before the first result appears. An old Kindle is slow to download that and may run out of memory.
  - The failure is at least honest (an error line, not a white page), but the page is unusable for search on the oldest devices.
- **Fix F5 (two steps, in order):**
  1. *Small, safe:* rewrite the script in ES5 style (like `site/stats/index.html` already does) — `var`/`function`, `.then(onDone, onDone)` instead of `.finally`, guard `normalize` (skip normalisation when it is missing and fall back to a plain substring match), and an XHR fallback when `fetch` is undefined. This makes the page load and search on old browsers.
  2. *Structural (bigger, separate approval):* stop downloading all shards on old/low-memory browsers — search through the server instead (`GET /api/tg-search`, the D1 endpoint, which returns only the small result set) and keep the shard download only for new browsers. Do not build this inside Block 11c; it needs its own block and a D1 that is fully populated.
- **F6 (design consistency, non-breaking):** the page uses its own inline styles instead of the shared `site/assets/rlibook.css`. One-line fix: add `<link rel="stylesheet" href="/site/assets/rlibook.css">` and drop the duplicated rules — but only together with the F5 rewrite, so the page is not touched twice.

## What was NOT changed here (and why)
Block 11c owns only `site/assets/`, `site/stats/`, `functions/api/stats.js`
and `docs/compatibility.md`. The fixes F1–F6 touch `index.html`,
`functions/book.js`, `functions/new.js`, `site/newspapers/index.html`
and `site/telegram/index.html`, which other agents own — so they are
specified exactly above (file + line + change) instead of applied.
Nothing in this document invents a link, a token, or a number: every
file:line reference was read from the repo on 2026-11-14, and the
live-site check (`curl`, all 200) is in the Block 11c report.

## How to re-check (after the fixes land)
1. `node functions/api/stats.test.mjs` and the other `.test.mjs` files — all must pass.
2. `curl -s -o /dev/null -w "%{http_code}" https://rlibook.tech/` (and `/telegram/`, `/newspapers/`, `/book?q=test`, `/new`, `/stats/`) — all 200.
3. Open `/telegram/` with JavaScript disabled: it must show the honest fallback, not a white page. Open `/stats/` the same way: the `<noscript>` block must link to `/api/stats`.
4. Grep the site for unguarded modern JS: `grep -rn -E "=>|\.finally\(|normalize\(|async |await " site/ functions/book.js functions/new.js` — after F5 the only hits should be inside server-side code or guarded fallbacks.
5. Grep for colour emoji used as the only label: after F1–F4 there should be no `📚|📰|📧` left in headings or buttons.
