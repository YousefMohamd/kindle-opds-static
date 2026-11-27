// Cloudflare Pages Function: Telegram-catalog search (RliBook, Task 2).
// Route: GET /api/tg-search?q=...&limit=...&offset=...&source=...
//
//   GET /api/tg-search?q=فن%20التواصل
//     -> 200 { ok: true, q: "فن التواصل", total: 42, limit: 10,
//              offset: 0,
//              coverage: { indexed: 149996, target: 323325, partial: true },
//              results: [
//                { title, author, source, kind, formats, flagged,
//                  size, get, send, read, bot }, ... ] }
//     Each result carries GATED links only: `get` (the /kindle/get
//     delivery page, token-gated + capped), `send` (the Send-to-Kindle
//     email endpoint) and `read` (the browser reader) — or null when
//     the book cannot take that path (flagged books get no links at
//     all). `size` is the book file's size as recorded in the Telegram
//     index (D1 books.size, from the indexer's size_text — e.g. "2.7 MB").
//     It is present only when the index holds a size for the book; a
//     book with no recorded size carries NO `size` key at all (never
//     an invented number, never "0" or "?"). There is NO page count
//     in the index (no `pages` column in D1, no page count in the
//     Telegram shards or the OPDS indexes), so this endpoint never
//     returns one — see functions/book.js formatBookMeta for the
//     display rule (unknown field = omitted).
//     all). A flagged book carries `bot` instead: the bot deep link
//     (https://t.me/RliBook_bot?start=dl_<handle>_<post>_any) the
//     website renders as its single "View in bot" button — the bot
//     shows the book with 🚩 + the source channel link under the
//     3/day flag-query cap and never downloads it. Non-flagged
//     books carry bot: null. The raw t.me post URL is NEVER in a
//     public response: it is a direct, ungated download of
//     the book file, and handing it out would bypass the token gate and
//     the 5/day cap. The bot is the one caller that needs it (its
//     flagged flow points at the source channel): it sends
//     `x-rlibook-bot-key` with the shared secret (env TG_SEARCH_BOT_KEY,
//     same pattern as the converter's CONVERTER_SECRET) and gets `url`
//     back as well.
//   GET /api/tg-search?h=<handle>&p=<post_id>
//     -> 200 { ok: true, book: { title, author, source, kind,
//              formats, flagged, get, send, read } | null, coverage }
//     Single-book lookup by Telegram post (the bot's dl_ deep link
//     resolves the book's format through this instead of trusting
//     the link). The post URL is NOT unique per book (one post can
//     hold several files) — the first row by id wins, and the
//     caller must treat a multi-file post as one format only.
//     A hidden post (owner /hide) returns { ok: true, book: null },
//     the same as an unknown post — the title must not leak through
//     a "removed" notice.
//   GET /api/tg-search?h=drive&p=<Drive file id>
//     -> same shape, for a Drive book (WAVE 7, wave-7 child A).
//     Both lookup forms honor the viewer's ?fp= fingerprint: a
//     private/pending Drive book reads as { book: null } for anyone
//     but its submitter (pending: + owner), exactly like a hidden
//     post — no title leak.
//
// Hidden books (owner-only /hide, Workstream 2b): DIFFERENT from
// flagged. A flagged book is still SHOWN (🚩 badge
// + "View in bot", under the bot's 3/day cap). A hidden book was
// removed by the owner directly (/hide in the bot, or a manual KV
// put of `hidden:<handle>:<post_id>`), and is REMOVED from search
// entirely: the row is dropped from the results AND from `total`
// (adjusted by the hidden rows on the returned page — hidden books
// on later pages still count, so `total` is a visible-on-this-page
// adjustment, not a full recount). User reports NEVER hide: an
// approved report sets `flag:` instead (see below). A hidden book
// never appears on the website or in the bot — no flag marker, no
// link, no "removed" notice (the title itself must not leak
// through a notice). dl-token.js refuses a token for a hidden book
// (403 "hidden"); send-to-kindle.js and read-token.js refuse it too.
//
// Flagged books: the endpoint IDENTIFIES them, it does not
//   GET /api/tg-search?source=EBook_Library&q=...  — same search, but only
//     books whose source (channel/group handle) is exactly EBook_Library.
//     Powers the per-library browse links on /telegram/libraries.html.
//     With source= and no q, returns that library's books (newest first
//     is NOT guaranteed — FTS rank needs a query; empty-q source browse
//     lists by id order, capped by limit).
//   GET /api/tg-search?h=<handle>&p=<post_id>  — single-book lookup
//     (Workstream C): the one book at that post, or { ok: true,
//     book: null } when the post is unknown. The bot's
//     /start dl_<handle>_<post>_any deep link resolves the book's
//     real format through it instead of trusting the link. A post
//     holds one file, so formats has exactly one entry; flagged
//     comes from the same KV denylist as search. Takes precedence
//     over q when both are given (a lookup is not a search).
//     ?h=drive&p=<fileId> is the Drive form of the same lookup
//     (WAVE 7): the one Drive book for that file id, subject to
//     the viewer's ?fp= fingerprint like every other Drive row.
//
// What it searches: the Telegram catalog (321k distinct books from 51
// channels + 168 groups), held in a Cloudflare D1 database (SQLite +
// FTS5). The bot's /search calls this endpoint in addition to the OPDS
// search, so Telegram books finally appear in bot search.
//
// Why D1 (and not the static shards): the Telegram shards are ~19 MiB
// each (64 MiB total) — far too big to fetch + JSON.parse inside a
// free-tier Pages Function (10 ms CPU/request). HTTP Range requests do
// NOT work on Pages (the CDN ignores Range and returns the whole file,
// verified 2026-11-12), so a Function cannot fetch one record out of a
// shard. A pre-built inverted index would need the full book record
// duplicated per word (~250 MiB) to answer without a second lookup.
// D1 + FTS5 is the only approach where the Function sends one small
// query and receives only the small result set.
//
// Search semantics: title AND author, Arabic-normalized (NFKC, strip
// tashkeel/tatweel, unify alef/hamza/yeh forms, ة->ه, ى->ي, Persian
// folds), lowercased, and the definite article "ال" stripped from the front of a word when >=3 chars
// remain (so "كاتب" matches "الكاتب"). The query is split into
// words and run down a LADDER (see ladderQueries): each tier runs
// ONLY when the previous one returned 0 rows; the first hit wins
// and the reply carries `match` (exact|prefix|typo|any|word) naming
// the tier that produced the results (null when nothing matched).
//   Tier 0 exact: all words ANDed as exact phrases (today's search).
//   Tier 0b particle: same AND, with the و/ف/بال/لل prefixes stripped
//     from words whose remainder is >=4 chars (a ladder variant only
//     — the full form already returned 0; NEVER a fold, so 'وردة'
//     stays 'وردة'). Reports match 'exact'.
//   Tier 1 prefix: same AND, last word as an FTS5 prefix `"w1" AND
//     "w2"*` (only when the last word is len>=4 — shorter prefixes
//     are too broad); finds a missing ending.
//   Tier 2 typo: every word truncated to its first 5-6 chars and
//     prefix-matched (`"w1"* AND "w2"*`); finds a mid/late-word
//     substitution (the error must sit past the anchor).
//   Tier 3 OR/any-word: `"w1" OR "w2"`, bm25-ranked (multi-word only);
//     finds a query with one wrong word.
//   Tier 4 longest-word: today's fallback, kept — the longest word
//     alone (skipped for a single-word query: it IS tier 0).
// Format token: a query whose LAST word is a known book format
//   ("بيت الحرير epub") constrains every tier to that ext
//   (see parseFormatToken) — the token is stripped before the
//   ladder runs, and the reply echoes `format: "epub"`.
// Results are ordered by bm25(books_fts, 3.0, 1.0) — title 3x,
// author 1x — instead of f.rank. A non-exact `match` means the
// results are approximate: callers label them 'أقرب النتائج'
// (website index.html status line, bot runSearch) instead of
// presenting them as exact matches.
// Dedup (2026-11-21): the same book is often posted in several
// channels, so one title can come back 3x and eat 3 of the 10 slots.
// The endpoint over-fetches (3x the requested limit, capped at 50)
// and collapses same-title + same-author reposts to the best-ranked
// copy (a clean copy beats a flagged one); a different book that
// merely shares a title (different author) stays. `total` is the raw
// match count, not distinct titles; dedup is per page (offset pages
// can repeat a title shown on an earlier page).
// Source-hiding (2026-11-21): a result's `source` is populated ONLY
// when flagged:true; otherwise it is null. The `h=<handle>` param
// stays in the gated get/send/read links — it is the delivery
// identity (dl-token/send-to-kindle/tg-send resolve the book by
// (h,p,f); the proxy checks the exact triple), not displayed text,
// and stripping it would break every Telegram delivery link.
//
// Drive libraries (WAVE 4, WS8 — two-type model, user decision
// 2026-11-26): a Drive library in D1 `drive_libraries` is PUBLIC
// (everyone sees its books), PRIVATE (only its submitter, by Telegram
// id), or PENDING_PUBLIC (submitter + owner only, while the owner
// reviews the "make public" request). A kind='drive' row whose library
// is NOT in the table (legacy: indexed before the registry existed) is
// treated as PUBLIC. The table itself may not exist yet on an older D1
// (created by the registry SQL); hasDriveRegistry() probes once per
// request and the search falls back to the legacy no-filter queries
// when it is absent, so search can never 500 on a missing table. The
// viewer is identified by ?fp= (the catalog fingerprint): the same KV
// lookup as functions/opds/[[fp]].js — fp:<token> -> { tg_id,
// created_at }. No fp (or an unknown/revoked one) means an anonymous
// viewer: public libraries only. The owner id comes from
// env.RLIBOOK_OWNER_ID (same value as the bot's wrangler var).
// `source=drive:<folderId>` browses one Drive library. Results carry
// `kind: "drive"` and `library` (the display name from the registry,
// e.g. "Oriental Music"; null when the library has no registry row).
// Drive books have no t.me URL, so they use `flag:drive:<fileId>`
// instead of `flag:<handle>:<post_id>` (the flags:all blob may also
// carry `drive:<fileId>` entries); without it a flagged Drive book
// could never be flagged at all. Delivery for Drive rows is the
// /kindle/get delivery page (`get`, lib=drive&id=<fileId> — WAVE 7,
// unlocked by the `drive` entry in dl-token.js OPDS_LIBS) +
// send-by-email (`send`) + read-online (`read`); there is no bot
// deep link for a flagged Drive book (the bot has no dl_drive_ link).
//
// Flagged books: the endpoint IDENTIFIES them, it does not
// enforce the cap. It reads the shared denylist ONCE per search:
// a single KV key `flags:all` = { flagged: ["handle:postId", ...],
// hidden: ["handle:postId", ...] } (read once, cached in
// caches.default for 1 h — see flagStateForRows), instead of one
// KV get per result row. The bot rebuilds `flags:all` from the
// `flag:` / `hidden:` keys whenever one changes (see
// rlibook-flags-all-writer-patch.md); until the blob exists the
// endpoint falls back to the per-row gets (correct, just slower).
// The handle + post_id come from the result's t.me post URL. The bot
// enforces the 3/day successful-flagged-search cap and the
// invite-unlocks-3-more rule. If RLIBOOK_KV is not bound, flagged is
// false — the honest v1 limit (same as the token issuer): "not
// flagged" means "not on the denylist".
// A KV failure NEVER fails open here: when the denylist cannot be
// read, the reply carries `flagStatus: "degraded"`, every result
// carries `flagCheck: "degraded"` and NO delivery links (get/send/
// read/bot all null — and the raw post URL is withheld even from an
// authenticated bot caller). The website withholds the delivery
// links and shows the 🚩 flag instead; search itself keeps working
// (metadata only) until KV recovers.
//
// Hidden (owner-removed) books: a `hidden:<handle>:<post_id>` entry
// in the `flags:all` blob means the book is REMOVED from search
// entirely — it never appears in results, `total` drops by the
// hidden rows on the page, and the single-book lookup answers
// `book: null` exactly as if the post did not exist (no title
// leaks). Set by the owner's /hide command or by an approved user
// report (value = the approving report's rid, or
// `manual:<ownerId>:<timestamp>` for a manual hide). A KV failure
// no longer fails open for the DELIVERY path: a degraded page has
// no links at all, and dl-token.js fails CLOSED at mint time, so a
// hidden book still cannot be downloaded even if its title slips
// through a search. (Its title may stay visible in a degraded page
// — the hide itself is unenforceable while KV is down — but no file
// can leave through it.) The bot's /flags + /hide + /unhide
// (src/control-panel.ts) manage these keys; the catalog file
// (KOReader) is unaffected and still lists every file.
//
// File size: each result carries `size` ("2.7 MB") when the index
// recorded one, and no `size` key at all when it did not (see
// validateSize below). Never a `pages` key — the index has no page
// counts and this endpoint does not invent them.
//
// Env (Pages dashboard -> Settings -> Functions):
//   D1 binding  TG_D1       (required) — the Telegram catalog database.
//                            Create it (wrangler d1 create rlibook-tg),
//                            apply functions/api/tg-search-schema.sql,
//                            populate with telegram/tbi/d1_sync.py.
//   KV binding  RLIBOOK_KV  (optional) — the shared namespace the bot +
//                            OPDS feed use; the denylist blob
//                            `flags:all` = { flagged: [...], hidden:
//                            [...] } (rebuilt by the bot from the
//                            `flag:<handle>:<post_id>` /
//                            `hidden:<handle>:<post_id>` keys — the
//                            per-row keys remain the source of truth
//                            and the fallback), the coverage cache
//                            `tg-search:coverage`, and the `d1:guard`
//                            flag. Missing -> all results report
//                            flagged: false and hidden: false.
//   Secret      TG_SEARCH_BOT_KEY (optional) — the shared secret the
//                            Telegram bot sends as the `x-rlibook-bot-key`
//                            header so the endpoint returns the raw t.me
//                            post URL (`url`) in results. Public callers
//                            (no header, or a wrong one) never get `url`
//                            — only the gated links. Unset -> nobody gets
//                            `url` (the bot degrades to the plain-flag
//                            rendering) and nothing else changes.
//                            Generate once (openssl rand -hex 32) and set
//                            the SAME value as a Worker secret for the bot
//                            and as a Pages env var here. Never in the repo.
//
// Response is metadata + gated links only (title, author, source,
// format, the /kindle/get + email + reader links). No book file bytes
// are ever returned or stored, and the raw t.me post URL is returned
// only to an authenticated bot caller (see above).
//
// Totals are D1 counts: while the D1 import is still running (it
// finishes 2026-11-19) `total` is LOWER than the D1 final-import
// target (323,325 books) — the endpoint searches only what D1 holds
// so far, and says nothing more. The catalog manifest total is a
// DIFFERENT number (326,149 books on 2026-11-14, and growing) —
// /api/stats reports both numbers side by side; this endpoint never
// inflates its total to the manifest, and never claims a book is
// absent from the catalog when it may only be absent from D1 yet.
// Every ok:true reply therefore also carries `coverage`:
// { indexed, target, partial } — the D1 indexed count right now, the
// D1 final-import target (323,325), and whether D1 is still a partial
// snapshot (indexed < target). `indexed` comes from a KV cache
// (key `tg-search:coverage`, 6 h TTL; refreshed by a live MAX(id)
// on a cache miss — see d1Coverage), so the refresh runs at most
// 4 times/day instead of on every search. MAX(id) is an ESTIMATE of
// the row count, not an exact count: `books.id` is assigned
// sequentially by the importer, so the estimate overshoots by the
// id gaps only (live: 422,821 books at MAX(id) 422,850 — 29 rows,
// 0.007%). The live refresh is additionally barred by the `d1:guard`
// KV flag (set by the watchdog when D1 errors) and by a
// 4-refreshes/day KV counter — on guard the endpoint returns the
// last cached coverage or omits the field, and a KV failure never
// triggers a live refresh (that compound failure killed search on
// 2026-11-19). Callers (e.g. /book)
// show the partial note only while partial is true, so it disappears
// on its own when the import finishes.
//
// Free-tier friendly (D1 read-budget fix, 2026-11-26): one ranked
// FTS query per ladder tier (ORDER BY bm25 must rank the tier's
// match set — a common word like "رواية" matches ~7,000 books live,
// so one such search reads ~7k rows, not ~10-100) + ONE KV get for
// the denylist blob (`flags:all`, edge-cached 1 h) + one KV get for
// the coverage cache. The exact `total` costs a second full match-set
// enumeration ONLY when the returned page is full; small-result
// searches skip the COUNT entirely (see d1Search), and the COUNT
// that still runs is a direct-FTS count, not the old books-join
// COUNT. The coverage refresh is MAX(id) (~1 row), at most
// 4 times/day, never under `d1:guard`. No catalog fetch, no heavy
// work. D1 writes happen only in the population script, never here.

import { parseCookies, COOKIE_NAME } from "./identify.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10000;
const MAX_Q_LEN = 200; // Longer than any real title/author query; a 400, not a search
// A Telegram channel/group handle, or a Drive library source
// (`drive:<folderId>` — the per-library browse for a Drive library,
// e.g. ?source=drive:1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP). The colon
// form is the ONLY source value that may contain a colon.
const SOURCE_RE = /^(?:[A-Za-z0-9_]{1,64}|drive:[A-Za-z0-9_-]{10,64})$/;

// Same normalization as the indexer (tbi.books.normalize_arabic) and
// the website search page: NFKC, strip tashkeel (U+064B-U+0652) +
// superscript alef (U+0670) + tatweel (U+0640), unify alef forms
// (أإآٱ -> ا), ؤ -> و, ئ -> ي, ء removed, ى -> ي, ة -> ه, fold
// Persian letters (چ -> ج, ک/گ -> ك, پ -> ب, ڤ -> ف) so a query with
// ج finds a title stored with چ (e.g. نوستالچيا). Latin text is
// lowercased by normalizeQuery; display text is never changed. Must
// stay identical to tbi.books.normalize_arabic,
// d1_sync.normalize_arabic and src/search.ts normalizeArabic.
// EASTERN NUMERALS DEFERRED to day 2 (2026-11-21 follow-up): the
// ٠-٩ -> 0-9 fold is NOT applied here — the live books_fts still
// holds Eastern numerals in 15,370 rows (counted via
// d1_query_file.py, db ba378afe-4a2e-4d79-b6e9-ad73cf51e8fa) and the
// D1 write budget for today is fully used, so no batch rewrite was
// applied either. Folding the query now, without the migration,
// would make Eastern-numeral queries MISS rows they currently find
// (query folds to Western digits, index still holds Eastern ones).
// Day 2 (after the 2026-11-22 02:00 EET reset, once the delta
// completes): add the fold to all four normalizers + run the FTS
// migration. NEVER fold: س/ص, ت/ط, ذ/ز/ظ, ق/ك, ح/ه, ابن/بن.
export function normalizeArabic(text) {
  return (text || "")
    .normalize("NFKC")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ء/g, "")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[چ]/g, "ج")
    .replace(/[ک]/g, "ك")
    .replace(/[گ]/g, "ك")
    .replace(/[پ]/g, "ب")
    .replace(/[ڤ]/g, "ف");
}

// Strip the definite article "ال" from the front of a word, but only
// when >=3 chars remain — so "كاتب" matches "الكاتب" and "تواصل"
// matches "التواصل", while short words that would change meaning
// ("الله" -> "له") are left alone. Applied to index text AND query
// words identically, so both sides agree.
export function stripAl(word) {
  if (word.startsWith("ال") && word.length >= 5) return word.slice(2);
  return word;
}

/** Loose query form: Arabic-normalized, lowercased, single spaces. */
export function normalizeQuery(text) {
  return normalizeArabic(text).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Query words for the FTS AND: normalized, "ال"-stripped, len >= 2. */
export function queryWords(text) {
  return normalizeQuery(text)
    .split(" ")
    .map(stripAl)
    .filter((w) => w.length >= 2);
}

// --- format token ------------------------------------------------------
// The 22 book formats the indexer recognises (BOOK_EXTS in
// bot/src/group-index.ts, a port of tbi/books.py). A query whose LAST
// word is one of these is a format filter, not a search word:
// "بيت الحرير epub" searches بيت الحرير among EPUB rows only. The
// token is stripped BEFORE the ladder runs, so it can neither pollute
// the FTS AND (a format word never appears in a title) nor rescue
// junk through the OR tier — baseline: "بيت الحرير djvu" returned
// 102 rows via 'any' even though no DJVU row matched. The filter is
// applied as `AND b.ext = ?` on EVERY tier (and the smart trigram
// rescue, and source browse) — the books table HAS an ext column,
// so no schema change is needed. The reply echoes the detected
// format (`format: "epub"`) so callers can show the active filter.
// Deliberate difference from the indexer's FMT_TRAIL: "doc" (and
// "lit") ARE tokens here — the indexer omits them from trailing
// title-stripping because they are ordinary English words, but in a
// search query a trailing "doc" means the format (eval q089). The
// accepted edge case is a title genuinely ending in the word
// "doc"/"lit" being read as a format filter instead.
const FORMAT_EXTS = new Set([
  "azw", "azw3", "cbr", "cbz", "chm", "djv", "djvu", "doc", "docx",
  "epub", "fb2", "kepub", "kfx", "lit", "lrf", "mobi", "odt", "pdb",
  "pdf", "prc", "rtf", "txt",
]);

/** Split a query's words into { words, format }: when the last word
 *  is a known book format it is the format filter and is removed
 *  from the search words; otherwise the words pass through
 *  unchanged and format is null. Exported for tests. */
export function parseFormatToken(words) {
  const list = words || [];
  if (list.length === 0) return { words: [], format: null };
  const last = String(list[list.length - 1] || "").toLowerCase();
  if (!FORMAT_EXTS.has(last)) return { words: list, format: null };
  return { words: list.slice(0, -1), format: last };
}

// Escape a word for use inside an FTS5 double-quoted phrase: a "
// inside the phrase is doubled ("").
function ftsPhrase(word) {
  return '"' + word.replace(/"/g, '""') + '"';
}

// Build the FTS5 MATCH expression for an AND of words:
//   '"w1" AND "w2" AND ...'
function ftsMatch(words) {
  return words.map(ftsPhrase).join(" AND ");
}

// Strip ONE particle prefix (و / ف / بال / لل) from the front of a
// word, but ONLY when >=4 chars remain — so "والسندباد" -> "السندباد"
// (then stripAl -> "سندباد") while "وردة" stays "وردة" (remainder
// "ردة" is 3 chars). A LADDER variant only (see ladderQueries):
// the stripped form is tried only when the full form returned 0.
// NEVER a fold — the stored text and the normalizer are untouched.
// Exported for tests.
export function stripParticle(word) {
  if (!word) return word;
  for (const p of ["بال", "لل"]) {
    if (word.startsWith(p) && word.length - p.length >= 4) return word.slice(p.length);
  }
  for (const p of ["و", "ف"]) {
    if (word.startsWith(p) && word.length - 1 >= 4) return word.slice(1);
  }
  return word;
}

// The search ladder (see the header): the ordered tiers for one
// query's words, each { match, expr }. A tier is OMITTED when it
// cannot add anything: prefix needs a last word len>=4; OR needs
// >=2 words; longest-word is skipped for a single word (it IS the
// exact tier); the particle variant is omitted when no word
// changes. Exported for tests.
export function ladderQueries(words) {
  const tiers = [{ match: "exact", expr: ftsMatch(words) }];
  // Tier 0b — particle-stripped exact AND (match 'exact': it IS an
  // exact AND of the stripped form). Only when some word changes.
  const stripped = words.map((w) => stripAl(stripParticle(w)));
  if (stripped.some((w, i) => w !== words[i])) {
    tiers.push({ match: "exact", expr: ftsMatch(stripped) });
  }
  // Tier 1 — prefix: same AND, last word as an FTS5 prefix.
  const last = words[words.length - 1];
  if (words.length > 0 && last.length >= 4) {
    const prefixExpr =
      words.slice(0, -1).map(ftsPhrase).join(" AND ")
      + (words.length > 1 ? " AND " : "")
      + ftsPhrase(last) + "*";
    tiers.push({ match: "prefix", expr: prefixExpr });
  }
  // Tier 2 — typo: every word truncated to its first 5-6 chars,
  // prefix-matched. Anchor length: 5 chars for words of length
  // 5-6, 6 chars for longer words (a longer word can afford a
  // longer anchor); shorter words use the whole word as the prefix.
  const typoExpr = words
    .map((w) => ftsPhrase(w.length >= 7 ? w.slice(0, 6) : w.length >= 5 ? w.slice(0, 5) : w) + "*")
    .join(" AND ");
  tiers.push({ match: "typo", expr: typoExpr });
  // Tier 3 — OR/any-word (multi-word only).
  if (words.length > 1) {
    tiers.push({ match: "any", expr: words.map(ftsPhrase).join(" OR ") });
  }
  // Tier 4 — longest word alone (today's fallback, kept).
  if (words.length > 1) {
    const longest = [...words].sort((a, b) => b.length - a.length)[0];
    tiers.push({ match: "word", expr: ftsMatch([longest]) });
  }
  return tiers;
}

// -- file size -------------------------------------------------------
// The index records each book file's size (Telegram file_size, via
// the indexer: files.size_bytes + files.size_text -> shard `size` ->
// D1 books.size). The stored text is already human-readable
// ("2.7 MB", "888.9 KB" — the indexer's parse_size/format_size
// shapes: digits, optional decimal with "." or ",", unit B/KB/MB/GB).
// validateSize() accepts ONLY that shape (or a byte count, for a
// caller that holds bytes): anything else — an empty string, junk,
// a negative or non-finite number — yields "" (no size), so a bad
// value can never reach a reader as a fake size. Exported for tests
// and shared with functions/book.js's display rule (unknown = omitted).
const SIZE_TEXT_RE = /^\d+(?:[.,]\d+)?\s*(B|KB|MB|GB)$/i;

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  let size = n;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (size < 1024 || unit === "GB") {
      const text = size.toFixed(1).replace(/\.0$/, "");
      return `${text} ${unit}`;
    }
    size /= 1024;
  }
  return "";
}

/** A size value -> display text ("2.7 MB") or "" when unknown/invalid.
 *  Accepts the indexer's size text ("2.7 MB", "888.9 KB") or a byte
 *  count (number). Never invents: "" means "no size recorded". */
export function validateSize(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!SIZE_TEXT_RE.test(text)) return "";
    const m = /^(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)$/i.exec(text);
    // Rebuild normalized: "." decimal separator, one space, upper-case unit.
    return `${m[1].replace(",", ".")} ${m[2].toUpperCase()}`;
  }
  if (typeof value === "number") return formatBytes(value);
  return "";
}

// Parse a t.me post URL into { handle, postId } for the flag key.
// Handles https://t.me/<handle>/<post_id> (trailing query/fragment
// ignored). Returns null for any other shape (private-group c/ links,
// tg:// links, missing URL) — those are reported unflagged.
export function parsePostUrl(url) {
  const m = /^https?:\/\/t\.me\/([^/?#]+)\/(\d+)/.exec(url || "");
  if (!m) return null;
  return { handle: m[1], postId: m[2] };
}

// Same fingerprint shape as the bot (src/catalog.ts isFingerprint)
// and functions/opds/[[fp]].js: 22 URL-safe base64 chars.
const FP_RE = /^[A-Za-z0-9_-]{22}$/;

// Parse a Drive file URL into its file id, or null. Drive books have
// no t.me post URL, so the flag key for them is `drive:<fileId>`
// (see driveFlagKey) and the delivery identity is the file id.
export function parseDriveFileUrl(url) {
  const m = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/.exec(url || "");
  if (!m) return null;
  return { fileId: m[1] };
}

/** The denylist key for one Drive row (`drive:<fileId>`), or null
 *  when the row is not a Drive book. Exported for tests. */
export function driveFlagKey(url) {
  const file = parseDriveFileUrl(url);
  return file ? `drive:${file.fileId}` : null;
}

// The viewer is identified by ?fp= (the catalog fingerprint): the
// same KV lookup as functions/opds/[[fp]].js — fp:<token> ->
// { tg_id, created_at }. No fp (or an unknown/revoked one) means an
// anonymous viewer (null). Never throws.
//
// Cookie fallback (WAVE 7, A3, 2026-11-26): when no ?fp= is in the
// URL, the rlb_fp cookie set by /api/identify on the first catalog
// visit is read server-side (the cookie is HttpOnly, so page JS
// cannot read it — same pattern as functions/book.js). A reader who
// hops homepage -> telegram page -> homepage without fp in the URL
// keeps seeing their own private Drive libraries. ?fp= wins when
// present. A missing/invalid/unknown cookie resolves to anonymous
// (public-only) — fail closed, no new trust: the cookie holds the
// same fp the user arrived with, verified through the same KV
// lookup as ?fp=.
function cookieFp(request) {
  try {
    return (parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME] || "").trim();
  } catch (e) {
    // A malformed Cookie header (e.g. a stray % breaking
    // decodeURIComponent) must never 500 the search — anonymous.
    return "";
  }
}
async function verifyFingerprint(env, fp) {
  if (!FP_RE.test(fp || "")) return null;
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get("fp:" + fp);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const id = v && Number(v.tg_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (e) {
    return null;
  }
}

// True when the D1 `drive_libraries` registry table exists. Probes
// once per request; a missing table (older D1) means the search falls
// back to the legacy no-filter queries, never a 500. Never throws.
async function hasDriveRegistry(db) {
  try {
    const row = await db
      .prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='drive_libraries'")
      .bind().first();
    return !!row;
  } catch (e) {
    return false;
  }
}

// --- flags:all denylist blob (resilience batch, 2026-11-20) --------
// The flag/hide denylist used to cost one KV get per result row
// (up to ~101/search at limit 50) — and a KV failure failed OPEN,
// silently showing flagged books as clean. It is now ONE KV key:
//
//   flags:all = { flagged: ["handle:postId", ...],
//                 hidden:  ["handle:postId", ...] }
//
// rebuilt by the bot from the `flag:` / `hidden:` keys whenever one
// changes (see ~/workspace/rlibook-flags-all-writer-patch.md). The
// per-row `flag:` / `hidden:` keys remain the source of truth and
// the fallback: while the blob does not exist yet (rollout), the
// endpoint falls back to the per-row gets — correct, just slower —
// so deploying the read side first can never un-flag a book.
// The blob is also cached in caches.default for 1 h, so a steady
// state costs ~0 KV reads per search after the first.
//
// flagStateForRows() returns { status, flagged, hidden }:
//   "ok"       — blob read (or no KV binding: empty sets, the
//                honest v1 limit, same as before).
//   "legacy"   — blob missing/malformed: the sets were built with
//                the per-row gets instead. Correct, just slower.
//   "degraded" — a KV read threw: flag state is UNKNOWN and the
//                sets are EMPTY and must NOT be trusted. The caller
//                must disable delivery links and surface
//                flagStatus: "degraded" (see visibleResults).
// Never throws.
const FLAGS_ALL_KEY = "flags:all";
const FLAGS_CACHE_URL = "https://rlibook.internal/flags-all";
const FLAGS_CACHE_MAX_AGE_SECONDS = 3600; // 1 h

/** Validate a flags:all blob value into { flagged: Set, hidden: Set }
// of "handle:postId" entries, or null when the value is not a usable
// blob (not an object, or a flagged/hidden field that is present but
// not an array). Junk entries inside an array are dropped, never
// trusted. Exported for tests. */
export function parseFlagsBlob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    ("flagged" in value && !Array.isArray(value.flagged)) ||
    ("hidden" in value && !Array.isArray(value.hidden))
  ) {
    return null;
  }
  const clean = (arr) => {
    const out = new Set();
    for (const e of arr || []) {
      if (typeof e !== "string") continue;
      const t = e.trim();
      // Telegram entries ("handle:postId") and Drive entries
      // ("drive:<fileId>") — the bot writer may put either in the blob.
      const m = /^([A-Za-z0-9_]{1,64}):(\d{1,20})$/.exec(t);
      if (m) { out.add(`${m[1]}:${m[2]}`); continue; }
      const d = /^drive:([A-Za-z0-9_-]{1,64})$/.exec(t);
      if (d) out.add(`drive:${d[1]}`);
    }
    return out;
  };
  return { flagged: clean(value.flagged), hidden: clean(value.hidden) };
}

// Read the flags:all blob: edge cache (caches.default, 1 h) first,
// then one KV get. Returns { flagged: Set, hidden: Set } or null
// when the key is absent or malformed (the caller falls back to the
// legacy per-row gets). Throws on a KV/edge-cache read error (the
// caller treats that as degraded, never as "no flags"). In the
// Node test environment `caches` is undefined — the typeof guard
// keeps that path dead there; the edge-cache behaviour is covered
// by a test that installs a fake global `caches`.
async function flagsBlobGet(env) {
  const kv = env && env.RLIBOOK_KV;
  const edge = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (edge) {
    try {
      const hit = await edge.match(FLAGS_CACHE_URL);
      if (hit) {
        const parsed = parseFlagsBlob(await hit.json());
        if (parsed) return parsed;
        // A cached malformed blob is a corrupt cache entry, not a
        // missing blob — fall through to KV and re-cache.
      }
    } catch (e) {
      // Edge-cache failure: fall through to KV.
    }
  }
  const raw = await kv.get(FLAGS_ALL_KEY);
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = parseFlagsBlob(JSON.parse(raw));
  } catch (e) {
    return null;
  }
  if (!parsed) return null;
  // Best-effort edge-cache fill (a failure never fails the request).
  if (edge) {
    try {
      await edge.put(
        FLAGS_CACHE_URL,
        new Response(
          JSON.stringify({ flagged: [...parsed.flagged], hidden: [...parsed.hidden] }),
          {
            headers: {
              "content-type": "application/json",
              "cache-control": `max-age=${FLAGS_CACHE_MAX_AGE_SECONDS}`,
            },
          },
        ),
      );
    } catch (e) {
      // Best-effort only.
    }
  }
  return parsed;
}

// The denylist for one page of rows: { status, flagged, hidden }
// (see the header above). `rows` is needed only for the legacy
// fallback (the per-row gets); the blob path ignores it.
async function flagStateForRows(env, rows) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv) return { status: "ok", flagged: new Set(), hidden: new Set() };
  let blob = null;
  try {
    blob = await flagsBlobGet(env);
  } catch (e) {
    console.warn("[tg-search] flags:all lookup failed:", e && e.message);
    return { status: "degraded", flagged: new Set(), hidden: new Set() };
  }
  // Drive rows are flagged through the per-row `flag:drive:<fileId>`
  // key as well as the blob (the bot writer does not put drive entries
  // in the blob yet — the per-row key is the source of truth for them,
  // same as send-to-kindle.js checks). A Drive-row KV failure degrades
  // the whole page, never a silent unflag.
  const driveKeys = (rows || []).map((r) => driveFlagKey(r.url)).filter(Boolean);
  if (blob) {
    try {
      const flagged = new Set(blob.flagged);
      await Promise.all(
        driveKeys.map(async (key) => {
          const v = await kv.get(`flag:${key}`);
          if (v !== null) flagged.add(key);
        }),
      );
      return { status: "ok", flagged, hidden: blob.hidden };
    } catch (e) {
      console.warn("[tg-search] drive flag lookup failed:", e && e.message);
      return { status: "degraded", flagged: new Set(), hidden: new Set() };
    }
  }
  // Blob missing/malformed: legacy per-row gets. Any KV failure
  // here degrades the whole page — never a silent unflag.
  try {
    const flagged = new Set();
    const hidden = new Set();
    await Promise.all(
      (rows || []).map(async (r) => {
        const dkey = driveFlagKey(r.url);
        if (dkey) {
          const f = await kv.get(`flag:${dkey}`);
          if (f !== null) flagged.add(dkey);
          return;
        }
        const parsed = parsePostUrl(r.url);
        if (!parsed) return;
        const key = `${parsed.handle}:${parsed.postId}`;
        const [f, h] = await Promise.all([
          kv.get(`flag:${parsed.handle}:${parsed.postId}`),
          kv.get(`hidden:${parsed.handle}:${parsed.postId}`),
        ]);
        if (f !== null) flagged.add(key);
        if (h !== null) hidden.add(key);
      }),
    );
    return { status: "legacy", flagged, hidden };
  } catch (e) {
    console.warn("[tg-search] legacy flag lookup failed:", e && e.message);
    return { status: "degraded", flagged: new Set(), hidden: new Set() };
  }
}

// The bot username is hardcoded here, as in functions/book.js and
// index.html (no env var carries it today). The deep link is the
// website's "View in bot" button for flagged books: it opens the
// bot at the book's dl_ deep link, where the bot shows 🚩 + the
// source channel link under the 3/day flag-query cap and never
// downloads the book. It carries no raw t.me post URL — only the
// bot's own deep link — so it cannot bypass the token gate.
const BOT_USERNAME = "RliBook_bot";

/** The "View in bot" deep link for one Telegram row, or null when
 *  the row has no public post (private-group c/ links, tg://
 *  links, missing URL). Exported for tests. */
export function botDeepLink(row) {
  const parsed = parsePostUrl(row && row.url);
  if (!parsed || parsed.handle === "c") return null;
  return `https://t.me/${BOT_USERNAME}?start=dl_${parsed.handle}_${parsed.postId}_any`;
}

// --- search dedup (2026-11-21) ----------------------------------------
// The same book is often posted in several channels, so one title can
// come back 3x and eat 3 of the 10 slots (live complaint: 'ام ميمي'
// 3 times in 5 tiles). Rows collapse by normalized title + author —
// the same book reposted collapses to its best-ranked copy (the kept
// row keeps its own post identity + delivery links; nothing is merged
// into a synthetic entry). A different book that merely shares a title
// — a different author — stays, and the author line already
// disambiguates it on the website (like the bot report picklist's
// pickLabels(), which labels same-title tiles by author / library
// instead of dropping them — here the drop IS the point for the
// search list, the label is the fallback for what remains). When the
// kept copy is flagged and a later copy of the same book is not, the
// clean copy wins (it has delivery links; the flagged one points at
// the bot only). Exported for tests.
export function dedupeTitleKey(title, author) {
  return queryWords(title || "").join(" ") + "\n" + queryWords(author || "").join(" ");
}

// Collapse [{ row, flagged }] in rank order by dedupeTitleKey, first
// copy wins — except a clean copy replaces a flagged kept copy of the
// same book (see above). Not exported: visibleResults is the entry
// point and the tests cover it through onRequest().
function dedupeKept(kept) {
  const byKey = new Map();
  const out = [];
  for (const item of kept || []) {
    const k = dedupeTitleKey(item.row.title, item.row.author);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, item);
      out.push(item);
      continue;
    }
    if (prev.flagged && !item.flagged) {
      out[out.indexOf(prev)] = item;
      byKey.set(k, item);
    }
  }
  return out;
}

// Dedup over-fetch: the endpoint fetches up to 3x the requested limit
// (capped at MAX_LIMIT) so that after collapsing same-title reposts
// the page still holds `limit` distinct books instead of `limit`
// minus the duplicates. The COUNT(*) total is unaffected (it counts
// all matches, not the fetched page), and `total` keeps its raw
// meaning: matching rows, not distinct titles.
const DEDUP_OVERFETCH = 3;

// Flag + hide for one page of rows, from ONE denylist read (the
// flags:all blob — see flagStateForRows). Hidden rows are dropped
// (never returned), the rest are mapped with their flagged boolean
// and bot deep link. Returns { results, hiddenCount, flagStatus } —
// hiddenCount adjusts `total` (see the header: only the hidden rows
// on THIS page are subtracted). flagStatus is "ok" (blob), "legacy"
// (blob missing — per-row gets were used; correct, just slower), or
// "degraded" (KV failed — flag state UNKNOWN: every result is
// returned with delivery links disabled and flagCheck: "degraded",
// the raw post URL is withheld even from the bot, and the caller
// must surface flagStatus. A degraded page never fails open.)
async function visibleResults(env, rows, includeUrl, limit, fp = "") {
  const state = await flagStateForRows(env, rows);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : (rows || []).length;
  if (state.status === "degraded") {
    const kept = dedupeKept((rows || []).map((r) => ({ row: r, flagged: false })));
    const results = kept.slice(0, cap).map(({ row }) => {
      const out = toResult(row, false, false, fp);
      out.get = null;
      out.send = null;
      out.read = null;
      out.bot = null;
      out.flagCheck = "degraded";
      return out;
    });
    return { results, hiddenCount: 0, flagStatus: "degraded" };
  }
  const kept = [];
  let hiddenCount = 0;
  for (const r of rows || []) {
    const parsed = parsePostUrl(r.url);
    // Drive rows use the drive:<fileId> key; Telegram rows the
    // handle:postId key. Anything else has no denylist identity.
    const key = driveFlagKey(r.url) || (parsed ? `${parsed.handle}:${parsed.postId}` : null);
    if (key && state.hidden.has(key)) {
      hiddenCount++;
      continue;
    }
    kept.push({ row: r, flagged: key ? state.flagged.has(key) : false });
  }
  // Same-title reposts collapse to one tile (see dedupeKept); the
  // page is then cut to the requested limit of DISTINCT books.
  const results = dedupeKept(kept)
    .slice(0, cap)
    .map(({ row, flagged }) => toResult(row, flagged, includeUrl, fp));
  return { results, hiddenCount, flagStatus: state.status };
}

// D1 final-import target (distinct books). The delta import finished
// 2026-11-22 at 422,424 books, plus 397 Drive books imported 2026-11-23
// → 422,821 total; `partial` is false once D1 holds that many.
// This is NOT the catalog manifest total — never conflate the two.
const D1_FINAL_TARGET = 422821;

// Coverage cache: the D1 indexed count changes once a day (the daily
// import), not per request — so it is cached in KV (same RLIBOOK_KV
// binding the flag check already uses, same read-through pattern as
// functions/api/ratings.js) instead of running a full-table scan on
// every search. The live refresh used to be SELECT COUNT(*) FROM
// books — a full-table scan of ~422k rows, up to 4 times/day
// (~1.69M rows/day, a third of the 5M rows/day free budget) plus
// unguarded refreshes from /api/stats, which shares the same KV key
// with a 1 h TTL. That fixed cost is what the 2026-11-20 1 h TTL
// incident and the 2026-11-26 77%-by-11:13-UTC alert were made of.
// D1 READ-BUDGET FIX (2026-11-26, wave 4 workstream 7): the refresh
// is now SELECT MAX(id) FROM books — the PK b-tree tip, ~1 row read
// instead of ~422k. `books.id` is assigned sequentially by the
// importer, so MAX(id) tracks the row count within the id gaps:
// live D1 holds 422,821 books at MAX(id) 422,850 (gap 29 rows,
// 0.007%); on the 324,409-book measurement snapshot the gap is 7
// rows (0.002%). `indexed` is therefore an ESTIMATE, overstated by
// the gap — fine for a completeness indicator, and `partial` flips
// at the same point for practical purposes. The 6 h TTL, the
// 4-refreshes/day counter and the `d1:guard` kill-switch stay: they
// now bound an already-cheap query and keep the "KV failure never
// triggers a live count" guarantee (that compound failure killed
// search on 2026-11-19). /api/stats reads the same value from the
// same KV key and uses the same MAX(id) refresh (see stats.js
// d1CountCached).
const COVERAGE_CACHE_KEY = "tg-search:coverage";
const COVERAGE_CACHE_TTL_SECONDS = 21600; // 6 h

// Coverage guard (resilience batch, 2026-11-20): the live MAX(id)
// refresh is barred while the `d1:guard` KV flag is set (the watchdog sets
// it — value = a reason string, any non-null value counts — when
// the search canary reports D1 errors; delete the key to clear it),
// and barred after 4 refreshes in one UTC day (the D1 budget
// resets 00:00 UTC). The refresh counter is one KV key per UTC day
// (`tg-search:coverage:refreshes:<YYYY-MM-DD>`, 48 h TTL), one
// write per refresh. Two concurrent refreshes can both read N and
// both write N+1 — the budget may overshoot by one; the 6 h cache
// TTL still bounds the normal case to 4/day, so the counter is the
// backstop for cache-eviction storms, not a precise ledger.
const D1_GUARD_KEY = "d1:guard";
const COVERAGE_REFRESHES_PER_DAY = 4;
const COVERAGE_REFRESH_COUNTER_TTL_SECONDS = 172800; // 48 h

function coverageRefreshCounterKey(now = new Date()) {
  return `tg-search:coverage:refreshes:${now.toISOString().slice(0, 10)}`;
}

// True when the live MAX(id) refresh is barred right now: the guard flag
// is set, today's refresh budget is spent, or KV itself cannot be
// read (the guard state is unknown, so the count is barred — a KV
// failure must never trigger a live refresh). Never throws. No KV
// binding -> false (no guard to read; the count is the only source,
// the pre-existing behaviour for an unbound KV).
async function coverageRefreshBarred(env) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return false;
  try {
    const guard = await kv.get(D1_GUARD_KEY);
    if (guard !== null) return true;
    const raw = await kv.get(coverageRefreshCounterKey());
    const used = raw === null ? 0 : parseInt(raw, 10);
    return Number.isFinite(used) && used >= COVERAGE_REFRESHES_PER_DAY;
  } catch (e) {
    return true;
  }
}

// Record one coverage refresh against today's budget (best-effort:
// a failure never fails the request, and a lost increment only
// means the budget check may allow one extra refresh).
async function coverageRefreshCount(env) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return;
  try {
    const key = coverageRefreshCounterKey();
    const raw = await kv.get(key);
    const used = raw === null ? 0 : parseInt(raw, 10);
    const next = (Number.isFinite(used) ? used : 0) + 1;
    await kv.put(key, String(next), { expirationTtl: COVERAGE_REFRESH_COUNTER_TTL_SECONDS });
  } catch (e) {
    // Best-effort only.
  }
}

// Read the cached coverage count (an integer), or null. Never throws.
async function coverageCacheGet(env) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get(COVERAGE_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.indexed !== "number" || !Number.isFinite(v.indexed) || v.indexed < 0) return null;
    return Math.floor(v.indexed);
  } catch (e) {
    return null;
  }
}

// Store the coverage count (best-effort: a KV failure never fails the
// request). Same expirationTtl pattern as ratings.js cachePut.
async function coverageCachePut(env, indexed) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.put !== "function") return;
  try {
    await kv.put(COVERAGE_CACHE_KEY, JSON.stringify({ indexed, at: Date.now() }), { expirationTtl: COVERAGE_CACHE_TTL_SECONDS });
  } catch (e) {
    // Best-effort only.
  }
}

// Coverage of the D1 snapshot: how many books D1 holds right now vs
// the final-import target. Served from the KV cache when present
// (see above); otherwise a direct MAX(id) — the same estimate
// /api/stats uses for books_d1.count — but ONLY when the guard
// allows it (see coverageRefreshBarred). On guard, returns null and
// the caller omits the field, so a failed or barred count can never
// break a search. Never throws.
async function d1Coverage(db, env) {
  const cached = await coverageCacheGet(env);
  if (cached !== null) {
    return { indexed: cached, target: D1_FINAL_TARGET, partial: cached < D1_FINAL_TARGET };
  }
  if (await coverageRefreshBarred(env)) {
    return null;
  }
  try {
    const row = await db.prepare("SELECT MAX(id) AS n FROM books").bind().first();
    const indexed = row ? Number(row.n) || 0 : 0;
    await coverageCachePut(env, indexed);
    await coverageRefreshCount(env);
    return { indexed, target: D1_FINAL_TARGET, partial: indexed < D1_FINAL_TARGET };
  } catch (e) {
    console.warn("[tg-search] coverage count failed:", e && e.message);
    return null;
  }
}

// One D1 search: FTS MATCH, rank order, bounded. Returns { total, rows }.
// `total` is the full match count (may exceed rows.length).
// `source` (optional) restricts to one channel/group handle (exact match
// on books.source). With no query words (empty q) and a source, it lists
// that library's books by id order instead of FTS rank.
// Drive-visibility clause (WAVE 4, WS8 — see the header docs). `vis`
// is { hasRegistry, hasRestrictedDrive, viewerTgId, isOwner } (built
// in onRequest). When the registry is absent the join/clause are
// empty strings — the legacy no-filter queries, so search can never
// 500 on an older D1. `needsFilter` is true only when a RESTRICTED
// (private / pending_public / removed / unavailable) Drive library
// exists: with no restricted library every Drive row is visible to
// everyone, so the fast direct-FTS count (which cannot carry a
// books-table filter) stays
// exact; with one, the count must use the join form below (see
// countTotal in d1Search).
function driveVisibility(vis) {
  if (!vis || !vis.hasRegistry) return { join: "", clause: "", params: [], libCol: "", needsFilter: false };
  return {
    join:
      " LEFT JOIN drive_libraries dl ON b.kind = 'drive' " +
      "AND dl.folder_id = substr(b.source, 7)",
    clause:
      " AND (b.kind != 'drive' OR dl.folder_id IS NULL OR dl.visibility = 'public'" +
      " OR (dl.visibility IN ('private', 'pending_public') AND dl.submitter_tg_id = ?)" +
      " OR (dl.visibility = 'pending_public' AND ? = 1))",
    params: [vis.viewerTgId || -1, vis.isOwner ? 1 : 0],
    libCol: ", dl.title AS library_title",
    needsFilter: !!vis.hasRestrictedDrive,
  };
}

//
// D1 READ-BUDGET FIX (2026-11-26, wave 4 workstream 7): this used to
// run a COUNT(*) FIRST on every tier, then the rows query — two full
// enumerations of the match set per tier, because COUNT(*) must walk
// every match and ORDER BY bm25 must rank every match before LIMIT.
// Measured on the real 324,409-book snapshot (live: 422,821): a common
// single word costs ~2x its match set per search ("رواية" 5,780
// matches -> 11,560 rows; "كتاب" 6,887 -> 13,774), and the OR tier's
// union runs 1,920 rows for "فن الخرطوم". That is what burned the
// 5M rows/day free budget (77% by 11:13 UTC 2026-11-26; exceeded
// 3x before). The shape below keeps `total` EXACT and the ladder,
// ranking and results byte-identical, while cutting the statements:
//   1. Rows FIRST. A tier with 0 rows misses — no COUNT is spent
//      deciding that, and the ladder moves on after ONE statement.
//   2. COUNT only when the page is full (rows.length === limit): the
//      full count may exceed the page, so it must be counted. When
//      the page is NOT full, every match is on it, so
//      total = offset + rows.length EXACTLY — no COUNT at all. That
//      covers most searches (exact multi-word hits, rare words).
//   3. The one COUNT that still runs is a DIRECT FTS count
//      (SELECT COUNT(*) FROM books_fts WHERE MATCH ?) whenever no
//      source/format filter applies — the old join form
//      (books b WHERE b.id IN (SELECT rowid FROM books_fts ...))
//      probed `books` by PK once per match (EXPLAIN: SEARCH b USING
//      INTEGER PRIMARY KEY per rowid); the direct form stays inside
//      the FTS index (~9x faster locally for a 354-row match set).
//      The join form stays ONLY when a filter applies, because the
//      filter lives on `books` and the count must agree with the page.
//   4. Empty page + offset > 0 is the one ambiguous case: it means
//      "no matches" OR "offset past the end" (total < offset). The
//      COUNT runs there too, so the returned total stays exact and
//      the ladder's tier choice is unchanged. (offset === 0 + empty
//      page means total 0 — no COUNT needed.)
// No new index can help: the FTS5 index already serves MATCH; the
// waste was the second full enumeration (COUNT), not a missing index.
async function d1Search(db, match, limit, offset, source, format, vis) {  const hasSource = !!(source && source.trim());
  const srcClause = hasSource ? " AND b.source = ?" : "";
  const srcParams = hasSource ? [source.trim()] : [];
  // Format filter (see parseFormatToken): constrain to one ext, in
  // BOTH the count and the rows query, so `total` and the page agree.
  // COLLATE NOCASE guards against a mixed-case ext in live D1.
  const hasFormat = !!(format && typeof format === "string" && format.trim());
  const fmtClause = hasFormat ? " AND b.ext = ? COLLATE NOCASE" : "";
  const fmtParams = hasFormat ? [format.trim().toLowerCase()] : [];
  const dv = driveVisibility(vis);
  // The exact total, counted only when the page cannot prove it
  // (see the header above): the page is full, or it is empty past
  // an offset. Direct-FTS count when no filter applies (same count
  // as the join form — rowid 1:1 with books.id — without the
  // per-match `books` probe); join form when a filter applies.
  // Drive note (WAVE 7, wave-7 child A — fixes the deb17a71
  // caveat): the join form carries the driveVisibility
  // join/clause, so the count agrees with the rows when a
  // private/pending Drive library exists. The direct form has no
  // visibility filter, so it runs ONLY when no restricted Drive
  // library exists at all (dv.needsFilter, from the one-row probe
  // in onRequest): with a restricted library present the count
  // uses the join form even on an unfiltered page, so the
  // full-page total can never overcount invisible Drive matches.
  // With no restricted library every Drive row is public/legacy,
  // so the direct count stays exact — and stays fast.
  async function countTotal(matchExpr) {
    if (!hasSource && !hasFormat && !dv.needsFilter) {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM books_fts WHERE books_fts MATCH ?")
        .bind(matchExpr)
        .first();
      return row ? Number(row.n) || 0 : 0;
    }
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM books b" + dv.join + " WHERE b.id IN " +
          "(SELECT rowid FROM books_fts WHERE books_fts MATCH ?)" + srcClause + fmtClause + dv.clause,
      )
      .bind(matchExpr, ...srcParams, ...fmtParams, ...dv.params)
      .first();
    return row ? Number(row.n) || 0 : 0;
  }
  if (!match) {
    // Empty query + source: plain browse of one library.
    const { results } = await db
      .prepare(
        "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date" + dv.libCol +
          " FROM books b" + dv.join + " WHERE 1=1" + srcClause + fmtClause + dv.clause + " ORDER BY b.id LIMIT ? OFFSET ?",
      )
      .bind(...srcParams, ...fmtParams, ...dv.params, limit, offset)
      .all();
    const rows = results || [];
    if (rows.length === 0 && offset === 0) return { total: 0, rows: [] };
    // Empty page past an offset must NOT return offset as the total
    // (true total < offset) — fall through to the COUNT below.
    if (rows.length > 0 && rows.length < limit) return { total: offset + rows.length, rows };
    // Page full (or empty past an offset): count the true total.
    // Browse has no FTS expression, so the count is the plain
    // source/format count on `books` (idx_books_source serves it).
    const countRes = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM books b" + dv.join + " WHERE 1=1" +
          (hasSource ? " AND b.source = ?" : "") + fmtClause + dv.clause,
      )
      .bind(...srcParams, ...fmtParams, ...dv.params)
      .first();
    return { total: countRes ? Number(countRes.n) || 0 : 0, rows };
  }
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date" + dv.libCol +
        " FROM books_fts f JOIN books b ON b.id = f.rowid " + dv.join +
        " WHERE f.books_fts MATCH ?" + srcClause + fmtClause + dv.clause + " ORDER BY bm25(books_fts, 3.0, 1.0) LIMIT ? OFFSET ?",
    )
    .bind(match, ...srcParams, ...fmtParams, ...dv.params, limit, offset)
    .all();
  const rows = results || [];
  if (rows.length === 0 && offset === 0) return { total: 0, rows: [] };
  if (rows.length > 0 && rows.length < limit) return { total: offset + rows.length, rows };
  return { total: await countTotal(match), rows };
}

// Run the search ladder (see ladderQueries): each tier runs ONLY
// when the previous one returned 0 rows; the first hit wins.
// Returns { total, rows, match } — match is the winning tier
// (exact|prefix|typo|any|word) or null when no tier matched.
// Rows are over-fetched (up to 3x `limit`, capped at MAX_LIMIT) so
// visibleResults can collapse same-title reposts and still return
// `limit` distinct books; `total` is the full match count, not the
// fetched page. Each tier costs ONE rows query plus a COUNT only
// when its page is full (see d1Search) — the ladder never pays a
// COUNT to decide a tier misses. Exported for tests.
export async function d1SearchLadder(db, words, limit, offset, source, format, vis) {  const fetchLimit = Math.min(MAX_LIMIT, limit * DEDUP_OVERFETCH);
  for (const tier of ladderQueries(words)) {
    const found = await d1Search(db, tier.expr, fetchLimit, offset, source, format, vis);
    if (found.total > 0) return { ...found, match: tier.match };
  }
  return { total: 0, rows: [], match: null };
}

function toResult(row, flagged, includeUrl, fp = "") {
  const author = row.author && String(row.author).trim() ? row.author : null;
  const ext = (row.ext || "").trim().toUpperCase();
  const links = gatedLinks(row, !!flagged, fp);
  const out = {
    title: row.title,
    author,
    // Source-hiding (2026-11-21): the channel/group handle is
    // populated ONLY for flagged books (the bot's neutral
    // 'عرض المصدر' button needs it as a link target); every other
    // result carries source: null. The `h=<handle>` param stays in
    // the gated get/send/read links (see the header) — it is the
    // delivery identity, not displayed text.
    source: flagged ? row.source : null,
    kind: row.kind || "channel",
    // Drive rows only: the library display name from the registry
    // (e.g. "Oriental Music"); null for Telegram rows and for Drive
    // rows whose library has no registry row. The website renders it
    // (book.js formats line), never the raw drive:<folderId> source.
    library: row.library_title || null,
    formats: ext ? [ext] : [],
    flagged: !!flagged,
    get: links.get,
    send: links.send,
    read: links.read,
    // Flagged books only: the "View in bot" deep link (null for
    // every other book — they have get/send/read instead).
    bot: flagged ? botDeepLink(row) : null,
  };
  // File size when the index recorded one (validateSize: "" when
  // unknown/invalid). No `size` key at all when there is none, and
  // never a `pages` key — the index has no page counts.
  const size = validateSize(row.size);
  if (size) out.size = size;
  // The raw post URL is a direct, ungated download — only an
  // authenticated bot caller gets it (see isBotRequest). Every other
  // caller gets the gated links above and nothing else.
  if (includeUrl) out.url = row.url;
  return out;
}

/** True when the request carries the bot's shared secret, so the
 *  response may include the raw t.me post URL. The header must match
 *  env.TG_SEARCH_BOT_KEY exactly; when the secret is unset (or the
 *  header is absent/wrong) this is false — fail closed, never open. */
export function isBotRequest(request, env) {
  const secret = ((env && env.TG_SEARCH_BOT_KEY) || "").trim();
  if (!secret) return false;
  const sent = (request.headers.get("x-rlibook-bot-key") || "").trim();
  if (!sent || sent.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ sent.charCodeAt(i);
  return diff === 0;
}

// Formats the website's delivery paths accept (same set as
// functions/book.js TG_SENDABLE_FORMATS): a Telegram book in any
// other format gets no `get`/`send` link — the endpoints would
// refuse it anyway — and a note pointing at the bot instead.
const SENDABLE_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);

/** The gated links for one Telegram row, or nulls. Flagged books get
 *  no links at all (website rule: flagged = shown, never readable or
 *  downloadable here — the bot is the flagged path). A private-group
 *  post (t.me/c/...) has no public handle, so it gets no links either:
 *  the delivery page could not fetch it. `fp` (optional, WAVE 7):
 *  the viewer's VERIFIED fingerprint — when present it rides on the
 *  `get` + `send` links, because /kindle/get and /api/send-to-kindle
 *  resolve identity from ?fp= OR the rlb_fp cookie, and a search
 *  visitor may carry ?fp= with no cookie set yet (without it, a
 *  submitter's own private Drive book would 403 on the direct
 *  download/email link). The `read` link carries no fp — the site
 *  reader has no server gate to satisfy. Exported for tests. */
export function gatedLinks(row, flagged, fp = "") {
  const none = { get: null, send: null, read: null };
  if (flagged) return none;
  const fpQ = fp ? `&fp=${encodeURIComponent(fp)}` : "";
  // Drive rows: `get` is the /kindle/get delivery page
  // (lib=drive&id=<fileId> — unlocked by the `drive` entry in
  // dl-token.js OPDS_LIBS, which /kindle/get resolves via
  // parseBookParams), plus send-by-email + read-online. The
  // website falls back to the direct send link for them only when
  // the format is not get/sendable (book.js).
  const drive = parseDriveFileUrl(row.url);
  if (drive) {
    const fmt = (row.ext || "").trim().toLowerCase();
    const title = encodeURIComponent(row.title || "");
    const base = `lib=drive&id=${encodeURIComponent(drive.fileId)}`;
    const out = { ...none };
    if (SENDABLE_FORMATS.has(fmt)) {
      out.get = `/kindle/get?${base}&f=${fmt}&t=${title}${fpQ}`;
      out.send = `/api/send-to-kindle?${base}&f=${fmt}&t=${title}${fpQ}`;
    }
    if (fmt === "epub") {
      out.read = `/site/reader/?${base}&f=epub&title=${title}`;
    }
    return out;
  }
  const parsed = parsePostUrl(row.url);
  if (!parsed || parsed.handle === "c") return none;
  const fmt = (row.ext || "").trim().toLowerCase();
  const title = encodeURIComponent(row.title || "");
  const base = `lib=tg&h=${encodeURIComponent(parsed.handle)}&p=${parsed.postId}`;
  const out = { ...none };
  if (SENDABLE_FORMATS.has(fmt)) {
    out.get = `/kindle/get?${base}&f=${fmt}&t=${title}${fpQ}`;
    out.send = `/api/send-to-kindle?${base}&f=${fmt}&t=${title}${fpQ}`;
  }
  if (fmt === "epub") {
    out.read = `/site/reader/?${base}&f=epub&title=${title}`;
  }
  return out;
}

/** One D1 lookup by Telegram post: the first book row for that post
 *  URL, by id. A post can hold several files — the first row wins
 *  (see the route docs). Returns the row or null. `vis` (optional,
 *  built in onRequest) applies the Drive-visibility clause, so a
 *  Drive row can never leak through this path to a viewer who may
 *  not see its library; without `vis` the legacy no-filter query
 *  runs. Exported for tests. */
export async function d1LookupByPost(db, handle, postId, vis) {
  const url = `https://t.me/${handle}/${postId}`;
  const dv = driveVisibility(vis);
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date" + dv.libCol +
        " FROM books b" + dv.join + " WHERE b.url = ? COLLATE NOCASE" + dv.clause + " ORDER BY b.id LIMIT 1",
    )
    .bind(url, ...dv.params)
    .all();
  return (results && results[0]) || null;
}

/** True when `h`/`p` address a Drive book, not a Telegram post:
 *  h=drive and p is a Drive file id (10-80 chars). A numeric p of
 *  1-10 digits stays a Telegram post id — a channel literally
 *  named "drive" keeps its posts on the Telegram path. Exported
 *  for tests. */
export function isDriveLookup(handle, postId) {
  const p = postId || "";
  return handle === "drive"
    && /^[A-Za-z0-9_-]{10,80}$/.test(p)
    && !/^\d{1,10}$/.test(p);
}

/** One D1 lookup by Drive file id: the first kind='drive' row whose
 *  URL is that file's Drive URL, by id. The stored URL is the
 *  /file/d/<id>/view form (see parseDriveFileUrl); the exact
 *  no-suffix form is accepted too. `vis` (optional) applies the
 *  Drive-visibility clause — an invisible library's book reads as
 *  "unknown" (null), never as a title leak. Exported for tests. */
export async function d1LookupByDriveFile(db, fileId, vis) {
  const dv = driveVisibility(vis);
  const exact = `https://drive.google.com/file/d/${fileId}`;
  const prefix = exact + "/";
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date" + dv.libCol +
        " FROM books b" + dv.join + " WHERE b.kind = 'drive' AND (b.url = ? OR instr(b.url, ?) = 1)" +
        dv.clause + " ORDER BY b.id LIMIT 1",
    )
    .bind(exact, prefix, ...dv.params)
    .all();
  return (results && results[0]) || null;
}

// --- SMART SEARCH (batch-1, 2026-11-24) ------------------------------
// Behind ?smart=1 (or env SEARCH_SMART=1). Three pieces, each gated
// by the 82-query eval set (see search-eval/BASELINE.md):
//   1. Trigram rescue — books_trigram (FTS5 trigram over the same
//      normalized title+author as books_fts). Runs ONLY when the
//      ladder finds nothing, as an OR of the query words' character
//      trigrams (a whole-word substring phrase does NOT tolerate
//      interior deletions — measured v1). The v1 trigram RERANK was
//      removed: it moved zero ranks on the eval set while adding
//      ~40% p95 latency and inflating `total`.
//   2. Nonsense guard — when the ladder won on the OR ('any') tier,
//      the top result must match at least half the query words
//      (exact word or word-prefix); otherwise the query has no good
//      match and the reply is empty + a did-you-mean suggestion
//      instead of junk. (Baseline: 4/5 nonsense queries returned
//      junk via 'any'. The guard only applies to 'any' — exact /
//      prefix / typo wins are untouched.)
//   3. Did-you-mean — vocab-table candidates (Claude's variant of
//      the consensus SymSpell: a precomputed SymSpell delete
//      dictionary for ~200k catalog words does not fit D1's 100k
//      rows/day write budget as a one-off build, and a 200k-word
//      in-memory dictionary does not fit a free Worker; the vocab
//      table gives the same user-visible "هل تقصد: X؟" from the
//      same catalog titles). Only on zero results; the query is
//      NEVER silently rewritten — the suggestion is returned and
//      the caller decides.
//   4. Autocomplete — ?suggest=<prefix> reads prefix_counts
//      (prefix 3-4 chars of normalized title -> top real titles).
//      Suggestions start at 3 chars; every suggestion is a real
//      catalog title by construction.
// If the side tables are absent (not built yet), every smart step
// fails SOFT: the trigram/suggest/vocab queries throw, the catch
// returns the plain ladder result — smart=1 can never break a
// search that works today.
/** True when the smart path is requested for this call. */
export function isSmartSearch(request, env) {
  try {
    const u = new URL(request.url);
    if (u.searchParams.get("smart") === "1") return true;
  } catch { /* fall through to env */ }
  return env && env.SEARCH_SMART === "1";
}

/** One trigram search: OR of the query words against books_trigram
 *  (substring match), rank order, bounded. Same row shape as
 *  d1Search. Returns { total, rows }.
 *
 *  D1 READ-BUDGET FIX (2026-11-26, wave 4 workstream 7): NO COUNT
 *  here at all. The only caller (applySmartSearch) re-scores the
 *  rows by trigram overlap and REPLACES total with the kept count
 *  (`total: kept.length`) — the raw COUNT was always discarded, so
 *  counting the trigram-OR match set (character trigrams of common
 *  words match very broadly) was pure waste. `total` here is the
 *  fetched-page count; the caller only uses it as a >0 check before
 *  re-counting. */
async function d1SearchTrigram(db, words, limit, offset, source, format, vis) {  const match = words.map(ftsPhrase).join(" OR ");
  const hasSource = !!(source && source.trim());
  const srcClause = hasSource ? " AND b.source = ?" : "";
  const srcParams = hasSource ? [source.trim()] : [];
  const hasFormat = !!(format && typeof format === "string" && format.trim());
  const fmtClause = hasFormat ? " AND b.ext = ? COLLATE NOCASE" : "";
  const fmtParams = hasFormat ? [format.trim().toLowerCase()] : [];
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date" + dv.libCol +
        " FROM books_trigram f JOIN books b ON b.id = f.rowid " + dv.join +
        " WHERE f.books_trigram MATCH ?" + srcClause + fmtClause + dv.clause + " ORDER BY f.rank LIMIT ? OFFSET ?",
    )
    .bind(match, ...srcParams, ...fmtParams, ...dv.params, limit, offset)
    .all();
  const rows = results || [];
  return { total: rows.length, rows };
}

/** Small Levenshtein distance (query word vs vocab candidate). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Damerau-Levenshtein distance: like Levenshtein but a transposition
 *  of two adjacent letters costs 1, not 2 ("اعالم"->"اعلام" is one
 *  typo, not two). Used for did-you-mean ranking; plain Levenshtein
 *  is kept exported for tests. */
export function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2 = new Array(n + 1).fill(0);
  let prev1 = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      let cost = prev1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cost = Math.min(cost, prev1[j] + 1, cur[j - 1] + 1);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, prev2[j - 2] + 1);
      }
      cur[j] = cost;
    }
    prev2 = prev1;
    prev1 = cur;
  }
  return prev1[n];
}

/** Alphabet for edit-1 candidate generation (normalized forms only —
 *  the query word is already normalized, so ا/أ/إ etc. are all ا). */
const EDIT_ALPHABET = "ابتثجحخدذرزسشصضطظعغفقكلمنهويىةءؤئ0123456789".split("");

/** All strings at Damerau distance 1 from `w` (one deletion,
 *  transposition, substitution, or insertion). The classic SymSpell
 *  lookup, computed at query time instead of precomputed: a
 *  precomputed delete dictionary for ~200k catalog words would be
 *  ~4M rows — ~40 days of D1 write budget — while generating the
 *  ~450 candidates for one word costs a single batched IN lookup.
 *  Crucially this catches what the 3-letter-prefix filter cannot:
 *  an error in the first 3 letters ("قان" -> "قران", deleted ر). */
function edits1(w) {
  const out = new Set();
  for (let i = 0; i < w.length; i++) out.add(w.slice(0, i) + w.slice(i + 1)); // delete
  for (let i = 0; i < w.length - 1; i++) { // transpose
    out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  }
  for (let i = 0; i < w.length; i++) { // substitute
    for (const c of EDIT_ALPHABET) {
      if (c !== w[i]) out.add(w.slice(0, i) + c + w.slice(i + 1));
    }
  }
  for (let i = 0; i <= w.length; i++) { // insert
    for (const c of EDIT_ALPHABET) out.add(w.slice(0, i) + c + w.slice(i));
  }
  out.delete(w);
  return [...out];
}

/** Did-you-mean: for each query word (len>=3) that is NOT itself a
 *  catalog word, find the closest catalog word. Pass 1 — SymSpell
 *  edit-1 generation (all distance-1 neighbours, most frequent
 *  wins). Pass 2 — for long words (len>=7) with no distance-1 hit,
 *  the 3-letter-prefix scan with Damerau distance <=2. Returns the
 *  corrected query string, or null when nothing is close. Never
 *  throws (a missing vocab table -> null). */
async function d1SuggestCorrection(db, words) {
  try {
    const inVocab = new Set();
    for (const w of words) {
      const row = await db.prepare("SELECT word FROM vocab WHERE word = ?").bind(w).first();
      if (row) inVocab.add(w);
    }
    const unknown = words.filter((w) => w.length >= 3 && !inVocab.has(w));
    if (unknown.length === 0) return null;
    const corrected = [...words];
    let changed = false;
    for (const w of unknown) {
      let best = null;
      // Pass 1: edit-1 neighbours via one batched IN lookup
      // (chunked at 90 params — D1's bound-parameter ceiling).
      const cands = edits1(w);
      for (let i = 0; i < cands.length; i += 90) {
        const chunk = cands.slice(i, i + 90);
        const placeholders = chunk.map(() => "?").join(",");
        const { results } = await db
          .prepare(`SELECT word, freq FROM vocab WHERE word IN (${placeholders})`)
          .bind(...chunk)
          .all();
        for (const c of results || []) {
          if (!best || c.freq > best.freq) best = { word: c.word, d: 1, freq: c.freq };
        }
      }
      // Pass 2: long words only — prefix scan, Damerau <= 2.
      if (!best && w.length >= 7) {
        const prefix = w.slice(0, 3).replace(/[%_\\]/g, "\\$&");
        const { results } = await db
          .prepare("SELECT word, freq FROM vocab WHERE word LIKE ? ESCAPE '\\' LIMIT 60")
          .bind(prefix + "%")
          .all();
        for (const c of results || []) {
          const d = damerauLevenshtein(w, c.word);
          if (d >= 1 && d <= 2 && (!best || d < best.d || (d === best.d && c.freq > best.freq))) {
            best = { word: c.word, d, freq: c.freq };
          }
        }
      }
      if (best) {
        corrected[corrected.indexOf(w)] = best.word;
        changed = true;
      }
    }
    return changed ? corrected.join(" ") : null;
  } catch {
    return null; // Vocab table absent (not built yet) — no suggestion.
  }
}

/** Autocomplete: top real titles whose normalized title starts with
 *  the given prefix (3 chars -> 3-char bucket, 4+ -> 4-char bucket).
 *  Returns [{ title, author }] (at most `limit`). Empty for prefixes
 *  under 3 chars. Never throws (a missing table -> []). */
export async function d1Autocomplete(db, rawPrefix, limit = 10) {
  try {
    const p = normalizeQuery(rawPrefix || "");
    if (p.length < 3) return [];
    const key = p.slice(0, 4);
    const { results } = await db
      .prepare("SELECT title, author, cnt FROM prefix_counts WHERE prefix = ? ORDER BY cnt DESC, title ASC LIMIT ?")
      .bind(key, limit)
      .all();
    return (results || []).map((r) => ({ title: r.title, author: r.author || null }));
  } catch {
    return [];
  }
}

/** How many query words does this row match? A word matches when it
 *  appears exactly in the normalized title+author words, or a title/
 *  author word starts with it (prefix). Both sides use the same
 *  stripAl as the index, so "كاتب" matches a title word "الكاتب".
 *  Used by the nonsense guard. */
function matchedWordCount(row, words) {
  const hay = new Set(
    `${normalizeArabic(row.title || "")} ${normalizeArabic(row.author || "")}`
      .toLowerCase().split(/\s+/).filter(Boolean).map(stripAl),
  );
  let n = 0;
  for (const w of words) {
    if (hay.has(w)) { n++; continue; }
    for (const h of hay) {
      if (h.startsWith(w) || w.startsWith(h)) { n++; break; }
    }
  }
  return n;
}

/** Character trigrams of one word (len>=3; shorter words pass through
 *  unchanged). The FTS5 trigram tokenizer matches SUBSTRINGS, so a
 *  whole-word phrase ("القان") only finds titles containing that exact
 *  substring — it does NOT tolerate an interior deletion. OR-ing the
 *  word's trigrams is the actual typo-tolerant query: a title sharing
 *  more trigrams ranks higher. */
function wordTrigrams(word) {
  if (word.length < 3) return [word];
  const out = [];
  for (let i = 0; i <= word.length - 3; i++) out.push(word.slice(i, i + 3));
  return out;
}

/** Trigram overlap score between the query's trigram set and one
 *  row's title+author trigram set: shared / min(|query|, |row|).
 *  A raw trigram-OR match is far too loose on its own — a single
 *  common trigram ("lmo" in "almost") matches gibberish — so rescue
 *  candidates are re-scored here and kept only at >= 0.25. */
function trigramScore(row, queryTrigrams) {
  const hay = new Set(
    `${normalizeArabic(row.title || "")} ${normalizeArabic(row.author || "")}`
      .toLowerCase().split(/\s+/).filter(Boolean).map(stripAl).flatMap(wordTrigrams),
  );
  if (hay.size === 0 || queryTrigrams.size === 0) return 0;
  let shared = 0;
  for (const t of queryTrigrams) if (hay.has(t)) shared++;
  return shared / Math.min(queryTrigrams.size, hay.size);
}

/** Apply the smart path to a ladder result. Returns
 *  { found: { total, rows, match }, suggestion: string|null }.
 *  Never throws: any side-table failure degrades to the ladder.
 *  v2 (measured 2026-11-24): the v1 trigram RERANK is removed — it
 *  moved zero ranks on the eval set while adding ~40% p95 latency
 *  and inflating `total`. What remains: (a) trigram rescue when the
 *  ladder finds nothing, re-scored by trigram overlap (a raw
 *  trigram-OR returns junk for gibberish — one shared trigram is
 *  not a match), (b) the nonsense guard on OR-tier wins,
 *  (c) did-you-mean on zero/weak results. */
async function applySmartSearch(db, words, found, limit, offset, source, format, vis) {
  const fetchLimit = Math.min(MAX_LIMIT, limit * DEDUP_OVERFETCH);
  try {
    // Rescue: the ladder found nothing — try trigram similarity
    // (OR of the query words' character trigrams), then keep only
    // candidates sharing >=25% of the smaller trigram set.
    if (found.total === 0) {
      const triWords = [...new Set(words.flatMap(wordTrigrams))];
      const tri = await d1SearchTrigram(db, triWords, fetchLimit, offset, source, format, vis);
      if (tri.total > 0) {
        const qSet = new Set(triWords);
        const kept = tri.rows
          .map((r) => ({ row: r, score: trigramScore(r, qSet) }))
          .filter((x) => x.score >= 0.25)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.row);
        if (kept.length > 0) {
          return { found: { total: kept.length, rows: kept.slice(0, fetchLimit), match: "trigram" }, suggestion: null };
        }
      }
      return { found, suggestion: await d1SuggestCorrection(db, words) };
    }
    // Nonsense guard: an OR-tier win whose top result matches less
    // than half the query words is not a match — answer empty +
    // a suggestion instead of junk. (Baseline: 4/5 nonsense queries
    // returned junk via 'any'.) Only 'any' is gated; exact /
    // prefix / typo wins are untouched.
    if (found.match === "any" && found.rows.length > 0) {
      const need = Math.max(1, Math.ceil(words.length / 2));
      if (matchedWordCount(found.rows[0], words) < need) {
        return {
          found: { total: 0, rows: [], match: null },
          suggestion: await d1SuggestCorrection(db, words),
        };
      }
    }
    // Did-you-mean on weak wins — but ONLY when the user got nothing
    // useful: a single-word query whose ladder win is weak (the
    // multi-word weak wins already return books — offering a
    // correction on top of a rank-1-correct answer is noise, and
    // the vocab scan costs ~5-30 ms per query: measured v2, running
    // it on every typo/any/word win pushed p95 +83%). The caller
    // shows "هل تقصد: X؟" — the query is never silently rewritten.
    if (words.length === 1 && (found.match === "typo" || found.match === "any" || found.match === "word")) {
      const suggestion = await d1SuggestCorrection(db, words);
      return { found, suggestion };
    }
    return { found, suggestion: null };
  } catch {
    return { found, suggestion: null };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const q = (url.searchParams.get("q") || "").trim();
  const source = (url.searchParams.get("source") || "").trim();
  const limitRaw = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, limitRaw))
    : DEFAULT_LIMIT;
  const offsetRaw = parseInt(url.searchParams.get("offset") || "", 10);
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(0, Math.min(MAX_OFFSET, offsetRaw))
    : 0;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });

  // Validate before touching D1: a bad source is a 400 (the caller
  // passed something that is not a channel/group handle), and a very
  // long query is a 400 too — both used to reach the database unchecked.
  if (source && !SOURCE_RE.test(source)) {
    return json(
      { ok: false, error: "bad source — use a channel or group handle (letters, digits, underscore) or drive:<folderId>" },
      400,
    );
  }
  if (q.length > MAX_Q_LEN) {
    return json(
      { ok: false, error: "query too long (max 200 characters)" },
      400,
    );
  }

  const db = env && env.TG_D1;
  if (!db) {
    return json(
      { ok: false, error: "search unavailable (TG_D1 not bound)" },
      503,
    );
  }

  // Autocomplete (smart path): ?suggest=<prefix> returns up to 10
  // real catalog titles starting with the prefix (3+ chars).
  const suggestRaw = (url.searchParams.get("suggest") || "").trim();
  if (suggestRaw) {
    const suggestions = await d1Autocomplete(db, suggestRaw, 10);
    return json({ ok: true, suggest: suggestRaw, results: suggestions });
  }

  // Drive-visibility context (WAVE 4, WS8 — see the header docs):
  // the viewer is identified by ?fp= (the catalog fingerprint), the
  // owner by env.RLIBOOK_OWNER_ID (same value as the bot's wrangler
  // var; OWNER_TG_ID accepted as an alias). Anonymous viewers see
  // public libraries only. When no ?fp= is present, the rlb_fp
  // cookie is read server-side instead (?fp= wins — see
  // cookieFp above). The registry probe is one tiny
  // sqlite_master lookup; when the table is absent the search falls
  // back to the legacy no-filter queries.
  // The verified fingerprint also rides on the delivery links
  // (WAVE 7): /kindle/get and /api/send-to-kindle resolve identity
  // from ?fp= OR the rlb_fp cookie, but a search visitor may carry
  // ?fp= with no cookie set yet — so the gated links carry it
  // explicitly (see gatedLinks). Only a VERIFIED fp is threaded;
  // an unknown token is dropped, never echoed into links.
  const rawFp = (url.searchParams.get("fp") || "").trim() || cookieFp(request);
  const viewerTgId = await verifyFingerprint(env, rawFp);
  const viewerFp = viewerTgId !== null ? rawFp : "";
  const ownerId = Number(((env && (env.RLIBOOK_OWNER_ID || env.OWNER_TG_ID)) || "").toString().trim());
  // hasRestrictedDrive (WAVE 7, wave-7 child A): one LIMIT 1 probe
  // for a private/pending_public/removed/unavailable Drive library.
  // (removed/unavailable count as restricted: their books are hidden
  // by the driveVisibility clause, so the direct-FTS count would
  // overcount them if the probe missed them.) It decides whether
  // the fast direct-FTS count may run (see countTotal): with no
  // restricted library the direct count is exact, with one the
  // join form must run. The table is tiny (one row per library),
  // so the probe costs ~1 row. A probe failure assumes restricted
  // (fail closed on totals: the join form is always correct, and
  // a failed probe must never let the direct count overcount
  // invisible books) — search itself never 500s on it.
  const hasRegistry = await hasDriveRegistry(db);
  let hasRestrictedDrive = false;
  if (hasRegistry) {
    try {
      const probe = await db
        .prepare("SELECT 1 AS n FROM drive_libraries WHERE visibility IN ('private', 'pending_public', 'removed', 'unavailable') LIMIT 1")
        .bind().first();
      hasRestrictedDrive = !!probe;
    } catch (e) {
      hasRestrictedDrive = true;
    }
  }
  const vis = {
    hasRegistry,
    hasRestrictedDrive,
    viewerTgId: viewerTgId || -1,
    isOwner: viewerTgId !== null && Number.isSafeInteger(ownerId) && ownerId > 0 && ownerId === viewerTgId,
  };

  // Only an authenticated bot caller gets the raw t.me post URL in
  // results (see isBotRequest). Everyone else gets the gated links.
  const includeUrl = isBotRequest(request, env);

  // Coverage is computed once per request and attached to every ok:true
  // reply below (spread as `...cov`); a failed or barred count yields
  // no field rather than a broken search. The count comes from the KV
  // cache when present (see d1Coverage) — the live MAX(id) refresh runs only
  // on a cache miss, at most 4 times/day, never under `d1:guard`.
  const coverage = await d1Coverage(db, env);
  const cov = coverage ? { coverage } : {};

  // Single-book lookup by Telegram post (?h=&p=) — or by Drive file
  // (?h=drive&p=<fileId>, WAVE 7, wave-7 child A): the ?h=&p= path
  // previously resolved Telegram posts only, so a Drive book was
  // unreachable here at all. Both forms are visible ONLY through
  // the viewer's ?fp= fingerprint (vis is passed to the lookup):
  // a private/pending Drive book reads as { book: null } for anyone
  // but its submitter (pending: + owner), exactly like a hidden
  // post — no title leak. Both params are required; a bad handle,
  // post id or file id is a 400, an unknown post/file is
  // { ok: true, book: null } (not a 404 — the caller treats
  // "unknown" as "cannot confirm the format"). The book carries the
  // same fields as a search result (gated links for everyone, `url`
  // only for an authenticated bot caller).
  const hParam = (url.searchParams.get("h") || "").trim();
  const pParam = (url.searchParams.get("p") || "").trim();
  if (hParam || pParam) {
    const driveLookup = isDriveLookup(hParam.toLowerCase(), pParam);
    if (!driveLookup && (!SOURCE_RE.test(hParam) || !/^\d{1,10}$/.test(pParam))) {
      return json(
        { ok: false, error: "bad post — use ?h=<channel handle>&p=<post id> or ?h=drive&p=<Drive file id>" },
        400,
      );
    }
    try {
      const row = driveLookup
        ? await d1LookupByDriveFile(db, pParam, vis)
        : await d1LookupByPost(db, hParam.toLowerCase(), pParam, vis);
      if (!row) {
        return json({ ok: true, ...cov, book: null });
      }
      // One denylist read for this row (flags:all blob — see
      // flagStateForRows). Degraded (KV failed): the book is
      // returned with NO links and flagCheck: "degraded" — the raw
      // post URL is withheld even from the bot, so a lookup can
      // never hand out a download for a book whose flag state is
      // unknown. Hidden (owner-hide): the post reads as "unknown
      // post" — the same null, no "removed" notice, no title leak.
      const state = await flagStateForRows(env, [row]);
      if (state.status === "degraded") {
        const out = toResult(row, false, false, viewerFp);
        out.get = null;
        out.send = null;
        out.read = null;
        out.bot = null;
        out.flagCheck = "degraded";
        return json({ ok: true, ...cov, flagStatus: "degraded", book: out });
      }
      const parsed = parsePostUrl(row.url);
      const key = driveFlagKey(row.url) || (parsed ? `${parsed.handle}:${parsed.postId}` : null);
      if (key && state.hidden.has(key)) {
        return json({ ok: true, ...cov, flagStatus: state.status, book: null });
      }
      const flagged = key ? state.flagged.has(key) : false;
      return json({ ok: true, ...cov, flagStatus: state.status, book: toResult(row, flagged, includeUrl, viewerFp) });
    } catch (e) {
      console.warn("[tg-search] post lookup failed:", e && e.message);
      return json(
        { ok: false, error: "search failed — try again later" },
        500,
      );
    }
  }

  // Format token: a trailing known-format word ("بيت الحرير epub")
  // is a filter on books.ext, not a search word (see
  // parseFormatToken). It is stripped before the ladder runs; the
  // reply echoes it (`format: "epub"`) so callers can show the
  // active filter.
  const words = queryWords(q);
  const { words: searchWords, format } = parseFormatToken(words);
  const fmtField = format ? { format } : {};

  if (!q || searchWords.length === 0) {
    // Empty query — or a query of only a format token ("epub"):
    // without a source there is nothing to list; with a source,
    // browse that library's books (filtered to the format when one
    // was given). A bare format token never browses the whole
    // catalog.
    if (!source) {
      return json({ ok: true, q, total: 0, limit, offset, ...cov, ...fmtField, results: [] });
    }
    try {
      // Browse over-fetches like search (see DEDUP_OVERFETCH): the
      // same title can be reposted inside one library too.
      const found = await d1Search(db, null, Math.min(MAX_LIMIT, limit * DEDUP_OVERFETCH), offset, source, format, vis);
      if (found.total === 0) {
        return json({ ok: true, q, source, total: 0, limit, offset, ...cov, ...fmtField, results: [] });
      }
      // Hidden rows (owner /hide) are dropped before the reply;
      // `total` is adjusted by the hidden rows on this page only.
      // flagStatus ("ok" | "legacy" | "degraded") tells the caller
      // whether the denylist was trusted for this page. Same-title
      // reposts collapse to one tile (see visibleResults).
      const { results, hiddenCount, flagStatus } = await visibleResults(env, found.rows, includeUrl, limit, viewerFp);
      return json({
        ok: true, q, source, total: Math.max(0, found.total - hiddenCount), limit, offset, ...cov, ...fmtField,
        flagStatus,
        results,
      });
    } catch (e) {
      // Never leak the database error to the caller (it can carry
      // table/column names); log it, return a generic failure.
      console.warn("[tg-search] search failed:", e && e.message);
      return json(
        { ok: false, error: "search failed — try again later" },
        500,
      );
    }
  }

  try {
    // The search ladder (see ladderQueries): exact AND first, then
    // prefix / typo / OR / longest-word — each tier runs ONLY when
    // the previous returned 0; the first hit wins. `match` names
    // the winning tier (null when nothing matched) so callers can
    // label non-exact results 'أقرب النتائج'. With ?smart=1 the
    // trigram rescue/rerank + nonsense guard run on top (see
    // applySmartSearch); without it the ladder is byte-identical
    // to before. Every tier is constrained to the format token
    // when one was given (see d1SearchLadder).
    let found = await d1SearchLadder(db, searchWords, limit, offset, source, format, vis);
    let suggestion = null;
    if (isSmartSearch(request, env)) {
      const smart = await applySmartSearch(db, searchWords, found, limit, offset, source, format, vis);
      found = smart.found;
      suggestion = smart.suggestion;
    }
    if (found.total === 0) {
      return json({
        ok: true, q, match: null, total: 0, limit, offset, ...cov, ...fmtField,
        ...(suggestion ? { suggestion } : {}),
        results: [],
      });
    }
    // One denylist read for the page (the flags:all blob — see
    // visibleResults). Hidden rows (owner /hide) are dropped before
    // the reply, and `total` is adjusted by the hidden rows on this
    // page only. flagStatus ("ok" | "legacy" | "degraded") tells
    // the caller whether the denylist was trusted for this page.
    // Same-title reposts collapse to one tile (see visibleResults);
    // `total` stays the raw match count, not distinct titles.
    const { results, hiddenCount, flagStatus } = await visibleResults(env, found.rows, includeUrl, limit, viewerFp);
    return json({
      ok: true,
      q,
      ...(source ? { source } : {}),
      match: found.match,
      total: Math.max(0, found.total - hiddenCount),
      limit,
      offset,
      ...cov,
      ...fmtField,
      flagStatus,
      ...(suggestion ? { suggestion } : {}),
      results,
    });
  } catch (e) {
    // Never leak the database error to the caller (it can carry
    // table/column names); log it, return a generic failure.
    console.warn("[tg-search] search failed:", e && e.message);
    return json(
      { ok: false, error: "search failed — try again later" },
      500,
    );
  }
}
