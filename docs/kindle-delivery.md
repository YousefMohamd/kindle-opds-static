# RliBook — Kindle Delivery (operator doc)

How a stock-Kindle owner (no KOReader) gets books from RliBook,
without depending on Send-to-Kindle email. Built 2026-11-16 from
`rlibook-kindle-delivery-design.md` (§7.2–7.4). Nothing here is
deployed by the build itself — this is the checklist for the
operator (Yousef) to run through at deploy time.

## The flow, in one paragraph

The Kindle browser **cannot download EPUBs** — Amazon blocks it by
design ("Invalid File Type"), and nothing on our side fixes that.
So the site never offers a direct EPUB download to the Kindle
browser. Instead every book card's primary button is **"📥 احصل
على الكتاب على جهازك"** ("Get on Kindle"), which opens the
delivery page `/kindle/get`. That page mints a **10-minute,
single-book short link** (`/k/<code>`) the user opens on their
phone/computer, downloads the file there, and uploads it at
`amazon.com/sendtokindle` — Amazon converts it and delivers it to
the Kindle library. Fallbacks: a plain-HTML in-browser reader
(`/read`, EPUB only, no JS) and the Send-to-Kindle email
(unchanged, demoted to a secondary link).

## Step 0 — Cloudflare dashboard (do this FIRST, before testing)

All free-plan, in the Cloudflare dashboard for the `rlibook.tech`
zone. Nothing in the code can substitute for these — Bot Fight
Mode and Browser Integrity Check run at the edge, before any Pages
Function executes.

1. **Security → Bots → Bot Fight Mode → OFF.** BFM issues
   CPU-intensive JS challenges the ES5 Kindle browser cannot pass,
   and on the free plan no rule can exempt anything from BFM
   (Super Bot Fight Mode + Skip is Pro, $20/mo — ruled out).
2. **Browser Integrity Check → OFF for the Kindle paths.**
   Rules → Configuration Rules → `URI Path starts with /book` OR
   `/kindle/` OR `/api/` → Browser Integrity Check: Off. BIC is on
   by default and challenges visitors "without a user agent or with
   a non-standard user agent" — the Kindle's UA is non-standard.
   If scoping proves fiddly, turning BIC off zone-wide is
   acceptable for this site (no login or payment surface).
3. **Cache: bypass on the Kindle paths, no Cache Everything.**
   Caching → Cache Rules: a rule **above** any caching rule —
   `URI Path starts with /book` OR `/kindle/` OR `/api/` OR
   `/cdn-cgi/` → Cache eligibility: **Bypass cache**. Verify there
   is **no** "Cache Everything" Page Rule / Cache Rule making HTML
   eligible for cache on `rlibook.tech`; if one exists, delete it
   or narrow it to static assets only. (A Cache-Everything rule
   with an Edge-TTL override is the one configuration in which a
   Cloudflare challenge page CAN be stored at the edge — with the
   `cf_clearance` cookie stripped — producing the "verification
   appears as cache" loop the user reported.)
4. **Rate limiting (free plan: 1 rule):** `URI Path starts with
   /api/dl-token` OR `/api/send-to-kindle` → 10 s period, block
   10 s, threshold deliberately generous (e.g. 30 requests / 10 s
   per IP) — a backstop against token-minting floods, not the main
   abuse control (the KV counters are).
5. **Purge Everything once**, after the changes (Caching →
   Configuration → Purge Everything) — a copy stored before the
   change keeps being served until its old TTL runs out.
6. **Challenge Passage:** leave at Cloudflare's recommended
   15–45 minutes (Security → Settings).

## Verify Step 0 (desktop, no Kindle needed)

```sh
curl -sI https://rlibook.tech/book?q=test
curl -sI -A "<Kindle UA from the logs>" https://rlibook.tech/book?q=test
```

Both must show **no** `cf-mitigated: challenge` header and
`cf-cache-status: DYNAMIC` or `BYPASS` (never `HIT`) on the HTML.
A `HIT` on HTML proves an edge-cache rule exists; a challenge
only with the Kindle UA proves the trigger is UA-based (BIC/BFM),
not caching.

**If the verification still appears on the Kindle:** copy the
**Ray ID** from the page footer, then Security → Events → filter
by that Ray ID — the event row names the product that challenged
(Bot Fight Mode vs Browser Integrity Check vs a WAF custom rule)
and the rule ID. Without a Ray ID, BFM vs BIC cannot be
distinguished — do not guess.

**Kindle-only smoke test after the fix:** open
`https://rlibook.tech/api/kindle-health` on the Kindle — a
plain-text `ok` proves the challenge is gone. If the verification
still appears there, BFM/BIC is still armed somewhere.

## Endpoints

| Route | Input | Output |
|---|---|---|
| `GET /kindle/` | — (+ UA detection) | Entry page; Kindle layout + banner if UA contains `Kindle` (or Kobo/eReader/EBRD/PocketBook), else standard layout + note. Never a block page. `no-store`. |
| `GET /kindle/get?lib=&id=&f=&t=` (or `lib=tg&h=&p=`) | Book identity + format; optional `fp` | `200 text/html` delivery page: 4 numbered steps, short link, `amazon.com/sendtokindle` link, reader + email links. `403` flagged; `429` over daily mint cap; `503` proxy/signing key unconfigured. `no-store`. No JS. |
| `GET /k/<code>` | Random 16-char code | `302` to the stored download target (signed proxy URL for Telegram books, public acquisition URL for OPDS books); `404` unknown/expired. `no-store`. Valid the full 10 minutes (not single-use). |
| `GET /read?lib=&id=` (or `lib=tg&h=&p=`) | Book identity (EPUB only) | `200 text/html` chapter page, `?ch=N` pagination. `403` flagged; `400` non-EPUB; `502`/`413` fetch/size failure. `no-store`. No JS. |
| `GET /api/dl-token?lib=&id=&f=` (extended) | Book identity + format | `200 { ok, token, exp, ttl, url, short }` — `short` is the `/k/<code>` URL; `url` is the signed proxy URL for Telegram books and `null` for OPDS books (see below). Existing `h`/`p` form unchanged. `403` flagged; `429` over cap; `503` not configured. |
| `GET /api/kindle-health` | — | `200 text/plain "ok"`; `no-store`; no KV/D1/env. |

## Access control — what is gated, what is not

- **Gated:** the Kindle entry experience (`/kindle/` layout +
  banner) and the token-issuance budget (mint caps, below).
- **NOT gated:** the EPUB download itself. The signed download
  URL must be fetchable from any modern browser (phone/computer),
  because Send to Kindle for Web requires exactly that. Gating it
  to Kindle UA would break the primary flow.
- **NOT gated:** search, reading, or the site generally.
- **NOT gated by UA, ever:** flagged books. The KV denylist
  (`flag:<handle>:<post_id>`) refuses flagged books in the token
  endpoint, the delivery page, and the reader, for every UA.
- **UA detection** is a case-insensitive substring match on
  `Kindle` (plus `Kobo`, `eReader`, `EBRD`, `PocketBook` as
  best-effort conveniences). It is **trivially spoofable** — any
  desktop browser can send a Kindle UA in seconds — so it is
  layout only, never a security control. What stops bulk abuse is
  the token scheme: 10-minute single-book tokens, per-IP and
  per-user daily caps, and the flag denylist. **Action:** log the
  full UA of requests to `/book` and `/kindle/` for two weeks
  (dashboard: Security → Events, or a KV daily count — UA string
  only, no IP, no personal data), then publish the observed
  strings in the repo and tighten the matcher to what real devices
  actually send. No verified 10th-gen Kindle UA string exists yet;
  do not guess one and match it exactly.

## Protection layers

- **Tokens:** `v1.<payload_b64>.<HMAC-SHA256>` (600 s TTL, one
  book, one format), same scheme the proxy verifies. No change to
  `makeToken` or the token format.
- **Mint caps** (`/api/dl-token`, `/kindle/get` — same
  `mintTokenForBook`): 20/day per IP; 20/day per fingerprint
  (`fp` present); 5/day per IP when anonymous (no `fp`).
  Counters are daily KV keys (`dlt:*:<YYYY-MM-DD>`), refunded on
  failure, non-atomic (same accepted KV race as the email
  endpoint). Refused mints (flag / not configured) never burn
  quota. No KV binding → caps fail open (mint, count nothing).
- **Flag denylist:** every issuance path checks
  `flag:<handle>:<post_id>` first. KV outage → fail **closed**
  for Telegram books (403); OPDS books are PD/CC and never
  flagged.
- **No bare file URLs** on the website any more: `index.html`
  titles link to `/book`, and `/book` cards link only to
  `/kindle/get`, `/read`, or the email endpoint. (The OPDS feed
  itself still carries acquisition links for KOReader — that path
  is unchanged.)
- **Short links:** random 16-char codes, KV `k:<code>` with a
  10-minute TTL, one target per code. The code carries no part of
  the token.
- **Graceful degradation:** signing key unset → honest 503;
  proxy unset → Telegram minting 503, OPDS unaffected; KV outage
  → counters fail open, flag check fails closed (Telegram);
  proxy down → delivery page shows the honest error + the two
  fallbacks.

## OPDS books and the proxy — read this

The Block 2 proxy (`rlibook-download-proxy`, a separate repo)
verifies tokens for **Telegram posts only**: its `verify_token`
requires `p` to be a numeric post id. It cannot serve an OPDS
`lib:id` token today, and the proxy is out of scope for this
build. So, until the proxy gains OPDS support (a proxy-repo
task):

- OPDS short links (`/k/<code>`) redirect to the book's **public
  acquisition URL** (Drive `uc?id=…`, Hindawi, DOAB — the same
  public source the OPDS feed already links to). The gate for
  OPDS books is the short link itself (10-minute KV life + mint
  caps), not the proxy.
- `/api/dl-token` still mints a token for OPDS books (same HMAC
  scheme, `p` = the book-id string) and returns `url: null` —
  there is no signed proxy URL to return yet. The `short` link is
  the OPDS download path.
- Telegram books are unchanged: short links redirect to the
  signed proxy URL, `url` is that URL.

## Free-tier budget (abuse bounds)

Zero D1 writes anywhere in this build (token minting is KV-only:
1 flag read + up to 2 counter ops + 1 short-link write per mint).
KV free tier: 100k reads/day, 1k writes/day (Workers free tier —
verify against the current dashboard at deploy time; if writes
bind, the counters degrade to best-effort). Pages Functions:
100k requests/day free — minting is one lightweight request, no
book fetch (the proxy fetches the file, as today). Resend
100/day is now fallback-only. No Cloudflare paid feature is used.

## Env vars (Pages dashboard — secrets, never in the repo)

- `PROXY_SIGNING_KEY` (required) — same value as the proxy's secret.
- `PROXY_BASE_URL` (required for Telegram books) — e.g.
  `https://rlibook-download.injectcloud.space`. Unset → Telegram
  minting is 503; OPDS minting unaffected.
- `PROXY_TOKEN_TTL_SECONDS` (optional, default 600, clamped 60–3600).
- `RLIBOOK_KV` (optional but recommended) — flag denylist, mint
  counters, short links. Without it: no denylist, no caps, no
  short links (the delivery page shows the target URL itself).

## Files changed / added (build 2026-11-16)

- `functions/api/dl-token.js` — extended: OPDS books (`lib`+`id`),
  mint caps, short-link issue/resolve, `url: null` for OPDS.
  `makeToken` and the token format unchanged.
- `functions/kindle/get.js` — NEW: delivery page `/kindle/get`.
- `functions/k/[code].js` — NEW: short-link resolver `/k/<code>`.
  (A dynamic-segment file — `functions/k.js` alone would match
  only the bare `/k` path, not `/k/<code>`.)
- `functions/read.js` — NEW: plain-HTML reader `/read` (EPUB only).
- `functions/kindle/[[path]].js` — extended: local entry page at
  `/kindle` + `/kindle/`; `no-store` on proxied HTML responses.
- `functions/book.js` — changed: primary button → `/kindle/get`,
  email demoted to a secondary link, footer note rewritten,
  `no-store` everywhere. Search, ratings, flag display unchanged.
- `index.html` — changed: OPDS titles link to `/book` (not the
  file URL); Kindle note rewritten.
- `functions/api/kindle-health.js` — NEW: diagnostic canary.
- `functions/api/send-to-kindle.js` — UNCHANGED (email fallback).
- Tests: `functions/api/dl-token.test.mjs`,
  `functions/kindle/get.test.mjs`, `functions/k.test.mjs`,
  `functions/read.test.mjs`, `functions/api/kindle-health.test.mjs`,
  `functions/kindle/ua.test.mjs` (all new); `functions/book.test.mjs`
  and `functions/kindle/proxy.test.mjs` extended for the new contract.

## Manual / device tests (need the user, one step at a time)

- M1 (dashboard, before deploy): the §"Verify Step 0" curl checks
  + Ray ID + Security Events.
- M2 (Kindle, after BFM off + BIC scoped off + cache bypass +
  purge): open `/api/kindle-health` → plain-text `ok`, no
  verification page.
- M3 (Kindle): search → delivery page → short link typed on the
  phone → EPUB downloads on the phone → upload at
  `amazon.com/sendtokindle` → book appears in the Kindle library.
- M4 (Kindle): plain-HTML reader opens a chapter, next-chapter
  link works, no JS errors (there is no JS to error).
- M5 (phone, negative): opening a `/k/<code>` link after 10
  minutes → 404/expired page, not a download.
- M6 (desktop, negative): minting 21 tokens from one IP in a day
  → 429 on the 21st (anonymous: the 6th mint in a day → 429).

## Open decisions (design §8 — as built)

- D1 (UA-gate tension): gate the entry page + token budget, NOT
  the EPUB download. Built as designed.
- D2 (remove open direct-download links): yes — every website
  download goes through the delivery page. Built as designed.
- D3 (budgets): 5/day anonymous, 20/day fingerprinted, 20/day
  per IP. Built as designed.
- D4 (reader scope): EPUB only in v1. Built as designed.
- D5 (short link): valid the full 10 minutes, not single-use.
  Built as designed.
- D6 (BIC scope): only on the Kindle paths via a Configuration
  Rule (zone-wide off is acceptable if scoping proves fiddly).
  Dashboard-side; see Step 0.
- D7 (Kindle UA): ship on the "Kindle" substring now; capture the
  real UA from logs in the first two weeks. Built as designed.

## What this build does NOT do

- No email as the primary path; no direct EPUB download inside
  the Kindle browser; no JS web reader on the Kindle; no AZW3
  download path; no "Download & transfer via USB" (Amazon removed
  it 2025-02-26); no server-side push without the user's Amazon
  login; no Cloudflare Pro; no strict Kindle-UA-only download
  gate; the bot never downloads books; no book files hosted on
  our server; no PPD/shorteners (the `/k/` link is a convenience
  redirect on our own domain, not a monetised shortener); no
  server-side EPUB→AZW3 conversion.
