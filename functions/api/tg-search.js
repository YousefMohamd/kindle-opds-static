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
// (key `tg-search:coverage`, 6 h TTL; refreshed by a live COUNT(*)
// on a cache miss — see d1Coverage), so the full-table count runs at
// most 4 times/day instead of on every search. The live COUNT(*) is
// additionally barred by the `d1:guard` KV flag (set by the watchdog
// when D1 errors) and by a 4-refreshes/day KV counter — on guard the
// endpoint returns the last cached coverage or omits the field, and
// a KV failure never triggers a live count (that compound failure
// killed search on 2026-11-19). Callers (e.g. /book)
// show the partial note only while partial is true, so it disappears
// on its own when the import finishes.
//
// Free-tier friendly: one D1 query (FTS MATCH, reads ~10-100 rows;
// 5M rows read/day on Workers Free) + ONE KV get for the denylist
// blob (`flags:all`, edge-cached 1 h) + one KV get for the coverage
// cache. The coverage COUNT(*) (a full-table scan, ~323k rows) runs
// only on a cache miss, at most 4 times/day, never under `d1:guard`.
// No catalog fetch, no heavy work. D1 writes happen only in the
// population script, never here.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10000;
const MAX_Q_LEN = 200; // Longer than any real title/author query; a 400, not a search
const SOURCE_RE = /^[A-Za-z0-9_]{1,64}$/; // A Telegram channel/group handle

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
      const m = /^([A-Za-z0-9_]{1,64}):(\d{1,20})$/.exec(e.trim());
      if (m) out.add(`${m[1]}:${m[2]}`);
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
  if (blob) return { status: "ok", flagged: blob.flagged, hidden: blob.hidden };
  // Blob missing/malformed: legacy per-row gets. Any KV failure
  // here degrades the whole page — never a silent unflag.
  try {
    const flagged = new Set();
    const hidden = new Set();
    await Promise.all(
      (rows || []).map(async (r) => {
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
async function visibleResults(env, rows, includeUrl, limit) {
  const state = await flagStateForRows(env, rows);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : (rows || []).length;
  if (state.status === "degraded") {
    const kept = dedupeKept((rows || []).map((r) => ({ row: r, flagged: false })));
    const results = kept.slice(0, cap).map(({ row }) => {
      const out = toResult(row, false, false);
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
    const key = parsed ? `${parsed.handle}:${parsed.postId}` : null;
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
    .map(({ row, flagged }) => toResult(row, flagged, includeUrl));
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
// functions/api/ratings.js) instead of running a full-table COUNT(*)
// on every search. A bare COUNT(*) scans ~323k rows, and at the 5M
// rows/day free-tier budget ~15 searches/day would exhaust it and
// site search would die with 500 for the rest of the day. With a
// 6 h TTL the count is refreshed at most 4 times/day and is at most
// 6 h stale — fine for a "how complete is D1" indicator. On a cache
// miss the code runs the live COUNT(*) ONLY when the guard allows it
// (see d1Coverage): a missing or broken cache can never break a
// search, and a KV failure can never TRIGGER a live count either —
// that compound failure killed search on 2026-11-19.
//
// 2026-11-20: the 1 h TTL broke live search — the coverage COUNT(*)
// refreshes up to 24×/day × 323,318 rows = 7.76M rows/day against the
// D1 free 5M rows/day budget (error 7500), so search died with HTTP
// 500 for the rest of each day. TTL is now 6 h: at most 4 refreshes/
// day (~1.29M rows/day), well inside the budget. The count is at most
// 6 h stale — fine for a completeness indicator.
const COVERAGE_CACHE_KEY = "tg-search:coverage";
const COVERAGE_CACHE_TTL_SECONDS = 21600; // 6 h

// Coverage guard (resilience batch, 2026-11-20): the live COUNT(*)
// is barred while the `d1:guard` KV flag is set (the watchdog sets
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

// True when the live COUNT(*) is barred right now: the guard flag
// is set, today's refresh budget is spent, or KV itself cannot be
// read (the guard state is unknown, so the count is barred — a KV
// failure must never trigger a live COUNT(*)). Never throws. No KV
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
// (see above); otherwise a direct COUNT(*) — the same count
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
    const row = await db.prepare("SELECT COUNT(*) AS n FROM books").bind().first();
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
async function d1Search(db, match, limit, offset, source) {
  const hasSource = !!(source && source.trim());
  const srcClause = hasSource ? " AND b.source = ?" : "";
  const srcParams = hasSource ? [source.trim()] : [];
  if (!match) {
    // Empty query + source: plain browse of one library.
    const countRes = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM books b WHERE 1=1" +
          (hasSource ? " AND b.source = ?" : ""),
      )
      .bind(...srcParams)
      .first();
    const total = countRes ? Number(countRes.n) || 0 : 0;
    if (total === 0) return { total: 0, rows: [] };
    const { results } = await db
      .prepare(
        "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date " +
          "FROM books b WHERE 1=1" + srcClause + " ORDER BY b.id LIMIT ? OFFSET ?",
      )
      .bind(...srcParams, limit, offset)
      .all();
    return { total, rows: results || [] };
  }
  const countRes = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM books b WHERE b.id IN " +
        "(SELECT rowid FROM books_fts WHERE books_fts MATCH ?)" + srcClause,
    )
    .bind(match, ...srcParams)
    .first();
  const total = countRes ? Number(countRes.n) || 0 : 0;
  if (total === 0) return { total: 0, rows: [] };
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date " +
        "FROM books_fts f JOIN books b ON b.id = f.rowid " +
        "WHERE f.books_fts MATCH ?" + srcClause + " ORDER BY bm25(books_fts, 3.0, 1.0) LIMIT ? OFFSET ?",
    )
    .bind(match, ...srcParams, limit, offset)
    .all();
  return { total, rows: results || [] };
}

// Run the search ladder (see ladderQueries): each tier runs ONLY
// when the previous one returned 0 rows; the first hit wins.
// Returns { total, rows, match } — match is the winning tier
// (exact|prefix|typo|any|word) or null when no tier matched.
// Rows are over-fetched (up to 3x `limit`, capped at MAX_LIMIT) so
// visibleResults can collapse same-title reposts and still return
// `limit` distinct books; `total` is the full match count, not the
// fetched page. Exported for tests.
export async function d1SearchLadder(db, words, limit, offset, source) {
  const fetchLimit = Math.min(MAX_LIMIT, limit * DEDUP_OVERFETCH);
  for (const tier of ladderQueries(words)) {
    const found = await d1Search(db, tier.expr, fetchLimit, offset, source);
    if (found.total > 0) return { ...found, match: tier.match };
  }
  return { total: 0, rows: [], match: null };
}

function toResult(row, flagged, includeUrl) {
  const author = row.author && String(row.author).trim() ? row.author : null;
  const ext = (row.ext || "").trim().toUpperCase();
  const links = gatedLinks(row, !!flagged);
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
 *  the delivery page could not fetch it. Exported for tests. */
export function gatedLinks(row, flagged) {
  const none = { get: null, send: null, read: null };
  if (flagged) return none;
  const parsed = parsePostUrl(row.url);
  if (!parsed || parsed.handle === "c") return none;
  const fmt = (row.ext || "").trim().toLowerCase();
  const title = encodeURIComponent(row.title || "");
  const base = `lib=tg&h=${encodeURIComponent(parsed.handle)}&p=${parsed.postId}`;
  const out = { ...none };
  if (SENDABLE_FORMATS.has(fmt)) {
    out.get = `/kindle/get?${base}&f=${fmt}&t=${title}`;
    out.send = `/api/send-to-kindle?${base}&f=${fmt}&t=${title}`;
  }
  if (fmt === "epub") {
    out.read = `/site/reader/?${base}&f=epub&title=${title}`;
  }
  return out;
}

/** One D1 lookup by Telegram post: the first book row for that post
 *  URL, by id. A post can hold several files — the first row wins
 *  (see the route docs). Returns the row or null. Exported for tests. */
export async function d1LookupByPost(db, handle, postId) {
  const url = `https://t.me/${handle}/${postId}`;
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.size, b.url, b.date " +
        "FROM books b WHERE b.url = ? COLLATE NOCASE ORDER BY b.id LIMIT 1",
    )
    .bind(url)
    .all();
  return (results && results[0]) || null;
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
      { ok: false, error: "bad source — use a channel or group handle (letters, digits, underscore)" },
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

  // Only an authenticated bot caller gets the raw t.me post URL in
  // results (see isBotRequest). Everyone else gets the gated links.
  const includeUrl = isBotRequest(request, env);

  // Coverage is computed once per request and attached to every ok:true
  // reply below (spread as `...cov`); a failed or barred count yields
  // no field rather than a broken search. The count comes from the KV
  // cache when present (see d1Coverage) — the live COUNT(*) runs only
  // on a cache miss, at most 4 times/day, never under `d1:guard`.
  const coverage = await d1Coverage(db, env);
  const cov = coverage ? { coverage } : {};

  // Single-book lookup by Telegram post (?h=&p=): the bot's dl_ deep
  // link resolves the book's format through this instead of trusting
  // the link. Both params are required; a bad handle or post id is a
  // 400, an unknown post is { ok: true, book: null } (not a 404 —
  // the caller treats "unknown post" as "cannot confirm the format").
  // The book carries the same fields as a search result (gated links
  // for everyone, `url` only for an authenticated bot caller).
  const hParam = (url.searchParams.get("h") || "").trim();
  const pParam = (url.searchParams.get("p") || "").trim();
  if (hParam || pParam) {
    if (!SOURCE_RE.test(hParam) || !/^\d{1,10}$/.test(pParam)) {
      return json(
        { ok: false, error: "bad post — use ?h=<channel handle>&p=<post id>" },
        400,
      );
    }
    try {
      const row = await d1LookupByPost(db, hParam.toLowerCase(), pParam);
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
        const out = toResult(row, false, false);
        out.get = null;
        out.send = null;
        out.read = null;
        out.bot = null;
        out.flagCheck = "degraded";
        return json({ ok: true, ...cov, flagStatus: "degraded", book: out });
      }
      const parsed = parsePostUrl(row.url);
      const key = parsed ? `${parsed.handle}:${parsed.postId}` : null;
      if (key && state.hidden.has(key)) {
        return json({ ok: true, ...cov, flagStatus: state.status, book: null });
      }
      const flagged = key ? state.flagged.has(key) : false;
      return json({ ok: true, ...cov, flagStatus: state.status, book: toResult(row, flagged, includeUrl) });
    } catch (e) {
      console.warn("[tg-search] post lookup failed:", e && e.message);
      return json(
        { ok: false, error: "search failed — try again later" },
        500,
      );
    }
  }

  if (!q) {
    // Empty query: without a source there is nothing to list; with a
    // source, browse that library's books (id order, capped by limit).
    if (!source) {
      return json({ ok: true, q: "", total: 0, limit, offset, ...cov, results: [] });
    }
    try {
      // Browse over-fetches like search (see DEDUP_OVERFETCH): the
      // same title can be reposted inside one library too.
      const found = await d1Search(db, null, Math.min(MAX_LIMIT, limit * DEDUP_OVERFETCH), offset, source);
      if (found.total === 0) {
        return json({ ok: true, q: "", source, total: 0, limit, offset, ...cov, results: [] });
      }
      // Hidden rows (owner /hide) are dropped before the reply;
      // `total` is adjusted by the hidden rows on this page only.
      // flagStatus ("ok" | "legacy" | "degraded") tells the caller
      // whether the denylist was trusted for this page. Same-title
      // reposts collapse to one tile (see visibleResults).
      const { results, hiddenCount, flagStatus } = await visibleResults(env, found.rows, includeUrl, limit);
      return json({
        ok: true, q: "", source, total: Math.max(0, found.total - hiddenCount), limit, offset, ...cov,
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

  const words = queryWords(q);
  if (words.length === 0) {
    return json({ ok: true, q, total: 0, limit, offset, ...cov, results: [] });
  }

  try {
    // The search ladder (see ladderQueries): exact AND first, then
    // prefix / typo / OR / longest-word — each tier runs ONLY when
    // the previous returned 0; the first hit wins. `match` names
    // the winning tier (null when nothing matched) so callers can
    // label non-exact results 'أقرب النتائج'.
    const found = await d1SearchLadder(db, words, limit, offset, source);
    if (found.total === 0) {
      return json({ ok: true, q, match: null, total: 0, limit, offset, ...cov, results: [] });
    }
    // One denylist read for the page (the flags:all blob — see
    // visibleResults). Hidden rows (owner /hide) are dropped before
    // the reply, and `total` is adjusted by the hidden rows on this
    // page only. flagStatus ("ok" | "legacy" | "degraded") tells
    // the caller whether the denylist was trusted for this page.
    // Same-title reposts collapse to one tile (see visibleResults);
    // `total` stays the raw match count, not distinct titles.
    const { results, hiddenCount, flagStatus } = await visibleResults(env, found.rows, includeUrl, limit);
    return json({
      ok: true,
      q,
      ...(source ? { source } : {}),
      match: found.match,
      total: Math.max(0, found.total - hiddenCount),
      limit,
      offset,
      ...cov,
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
