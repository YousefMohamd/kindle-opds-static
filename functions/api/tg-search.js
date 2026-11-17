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
// tashkeel/tatweel, unify alef/hamza/yeh forms, ة->ه, ى->ي), lowercased,
// and the definite article "ال" stripped from the front of a word when
// >=3 chars remain (so "كاتب" matches "الكاتب"). The query is split
// into words; ALL words must appear (FTS5 phrase-AND). If the AND
// query finds nothing, the endpoint retries with the longest word
// alone (the bot's "Did you mean" does its own suggestion on top).
// Results are ordered by FTS5 rank (best match first).
//
// Flagged books: the endpoint IDENTIFIES them, it does not
// enforce the cap. For each result it checks the shared KV denylist
// (same mechanism as functions/api/dl-token.js): a KV key
// `flag:<handle>:<post_id>` means the book IS flagged.
// The handle + post_id come from the result's t.me post URL. The bot
// enforces the 3/day successful-flagged-search cap and the
// invite-unlocks-3-more rule. If RLIBOOK_KV is not bound, or no flag
// key exists, flagged is false — the honest v1 limit (same as the
// token issuer): "not flagged" means "not on the denylist". Block 7
// populates the `flag:` keys from the bot's flags.ts list; until then
// the bot's own matchFlagged check on the query remains the primary
// flag gate.
//
// Hidden (owner-removed) books: a KV key `hidden:<handle>:<post_id>`
// means the book is REMOVED from search entirely — it never appears
// in results, `total` drops by the hidden rows on the page, and the
// single-book lookup answers `book: null` exactly as if the post did
// not exist (no title leaks). Set by the owner's /hide command or by
// an approved user report (value = the approving report's rid, or
// `manual:<ownerId>:<timestamp>` for a manual hide). A KV failure
// fails OPEN here (the book stays visible — search must never fail
// because the hide check did); dl-token.js fails CLOSED at mint
// time instead, so a hidden book still cannot be downloaded even
// if it slips through a search. The bot's /flags + /hide + /unhide
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
//                            OPDS feed use; flag denylist keys
//                            `flag:<handle>:<post_id>` and owner-hide
//                            keys `hidden:<handle>:<post_id>`.
//                            Missing -> all results report flagged:
//                            false and hidden: false.
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
// (key `tg-search:coverage`, 1 h TTL; refreshed by a live COUNT(*)
// on a cache miss — see d1Coverage), so the full-table count runs at
// most 24 times/day instead of on every search. Callers (e.g. /book)
// show the partial note only while partial is true, so it disappears
// on its own when the import finishes.
//
// Free-tier friendly: one D1 query (FTS MATCH, reads ~10-100 rows;
// 5M rows read/day on Workers Free) + up to `limit` parallel KV gets
// for the flag check + one KV get for the coverage cache. The
// coverage COUNT(*) (a full-table scan, ~150k rows) runs only on a
// cache miss, at most once an hour. No catalog fetch, no heavy work.
// D1 writes happen only in the population script, never here.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10000;
const MAX_Q_LEN = 200; // Longer than any real title/author query; a 400, not a search
const SOURCE_RE = /^[A-Za-z0-9_]{1,64}$/; // A Telegram channel/group handle

// Same normalization as the indexer (tbi.books.normalize_arabic) and
// the website search page: NFKC, strip tashkeel (U+064B-U+0652) +
// superscript alef (U+0670) + tatweel (U+0640), unify alef forms
// (أإآٱ -> ا), ؤ -> و, ئ -> ي, ء removed, ى -> ي, ة -> ه. Latin text
// is lowercased by normalizeQuery; display text is never changed.
export function normalizeArabic(text) {
  return (text || "")
    .normalize("NFKC")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ء/g, "")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
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

// Flag check against the shared KV denylist (same as dl-token.js).
// A key `flag:<handle>:<post_id>` means flagged.
async function isFlagged(env, url) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv) return false;
  const parsed = parsePostUrl(url);
  if (!parsed) return false;
  try {
    const v = await kv.get(`flag:${parsed.handle}:${parsed.postId}`);
    return v !== null;
  } catch (e) {
    console.warn("[tg-search] flag lookup failed:", e && e.message);
    return false;
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

// Hidden check (owner-only /hide, Workstream 2b). A key
// `hidden:<handle>:<post_id>` means the book is REMOVED from
// search. Same shape as isFlagged; a KV failure fails OPEN here
// (the book stays visible — search must never fail because the
// hide check did; dl-token.js fails CLOSED at mint time instead,
// so a hidden book still cannot be downloaded). Reports never
// set this key — an approved report sets `flag:` instead.
async function isHidden(env, url) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv) return false;
  const parsed = parsePostUrl(url);
  if (!parsed) return false;
  try {
    const v = await kv.get(`hidden:${parsed.handle}:${parsed.postId}`);
    return v !== null;
  } catch (e) {
    console.warn("[tg-search] hidden lookup failed:", e && e.message);
    return false;
  }
}

// Flag + hide for one page of rows: hidden rows are dropped (never
// returned), the rest are mapped with their flagged boolean and
// bot deep link. Returns { results, hiddenCount } — hiddenCount
// adjusts `total` (see the header: only the hidden rows on THIS
// page are subtracted).
async function visibleResults(env, rows, includeUrl) {
  const checks = await Promise.all(
    rows.map(async (r) => ({
      flagged: await isFlagged(env, r.url),
      hidden: await isHidden(env, r.url),
    })),
  );
  const results = [];
  let hiddenCount = 0;
  rows.forEach((r, i) => {
    if (checks[i].hidden) {
      hiddenCount++;
      return;
    }
    results.push(toResult(r, checks[i].flagged, includeUrl));
  });
  return { results, hiddenCount };
}

// D1 final-import target (distinct books). The import finishes
// 2026-11-19; until then D1 holds fewer books and `partial` is true.
// This is NOT the catalog manifest total (326,149 books on
// 2026-11-14, and growing) — never conflate the two.
const D1_FINAL_TARGET = 323325;

// Coverage cache: the D1 indexed count changes once a day (the daily
// import), not per request — so it is cached in KV (same RLIBOOK_KV
// binding the flag check already uses, same read-through pattern as
// functions/api/ratings.js) instead of running a full-table COUNT(*)
// on every search. A bare COUNT(*) scans ~150k rows, and at the 5M
// rows/day free-tier budget ~30 searches/day would exhaust it and
// site search would die with 500 for the rest of the day. With a
// 1 h TTL the count is refreshed at most 24 times/day and is at most
// 1 h stale — fine for a "how complete is D1" indicator. On a cache
// miss, a KV error, or a malformed cached value, the code falls back
// to the live COUNT(*) (and best-effort repopulates the cache), so a
// missing or broken cache can never break a search.
const COVERAGE_CACHE_KEY = "tg-search:coverage";
const COVERAGE_CACHE_TTL_SECONDS = 3600; // 1 h

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
// /api/stats uses for books_d1.count. Never throws: on any failure
// returns null and the caller omits the field, so a failed count can
// never break a search.
async function d1Coverage(db, env) {
  const cached = await coverageCacheGet(env);
  if (cached !== null) {
    return { indexed: cached, target: D1_FINAL_TARGET, partial: cached < D1_FINAL_TARGET };
  }
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM books").bind().first();
    const indexed = row ? Number(row.n) || 0 : 0;
    await coverageCachePut(env, indexed);
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
        "WHERE f.books_fts MATCH ?" + srcClause + " ORDER BY f.rank LIMIT ? OFFSET ?",
    )
    .bind(match, ...srcParams, limit, offset)
    .all();
  return { total, rows: results || [] };
}

function toResult(row, flagged, includeUrl) {
  const author = row.author && String(row.author).trim() ? row.author : null;
  const ext = (row.ext || "").trim().toUpperCase();
  const links = gatedLinks(row, !!flagged);
  const out = {
    title: row.title,
    author,
    source: row.source,
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
  // reply below (spread as `...cov`); a failed count yields no field
  // rather than a broken search. The count comes from the KV cache
  // when present (see d1Coverage) — the live COUNT(*) runs only on a
  // cache miss, at most once an hour.
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
      // Owner-hide: a hidden post reads as "unknown post" — the
      // same null, no "removed" notice, no title leak.
      if (await isHidden(env, row.url)) {
        return json({ ok: true, ...cov, book: null });
      }
      const flagged = await isFlagged(env, row.url);
      return json({ ok: true, ...cov, book: toResult(row, flagged, includeUrl) });
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
      const found = await d1Search(db, null, limit, offset, source);
      if (found.total === 0) {
        return json({ ok: true, q: "", source, total: 0, limit, offset, ...cov, results: [] });
      }
      // Hidden rows (owner /hide) are dropped before the reply;
      // `total` is adjusted by the hidden rows on this page only.
      const { results, hiddenCount } = await visibleResults(env, found.rows, includeUrl);
      return json({
        ok: true, q: "", source, total: Math.max(0, found.total - hiddenCount), limit, offset, ...cov,
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
    // Full AND first; fall back to the longest word alone (same spirit
    // as the bot's suggestSearch) when nothing matches all words.
    let found = await d1Search(db, ftsMatch(words), limit, offset, source);
    if (found.total === 0 && words.length > 1) {
      const longest = [...words].sort((a, b) => b.length - a.length)[0];
      found = await d1Search(db, ftsMatch([longest]), limit, offset, source);
    }
    if (found.total === 0) {
      return json({ ok: true, q, total: 0, limit, offset, ...cov, results: [] });
    }
    // Flag check per result, in parallel (one KV get each, at most
    // `limit` gets; missing KV binding -> all unflagged). Hidden
    // rows (owner /hide) are dropped before the reply, and `total`
    // is adjusted by the hidden rows on this page only.
    const { results, hiddenCount } = await visibleResults(env, found.rows, includeUrl);
    return json({
      ok: true,
      q,
      ...(source ? { source } : {}),
      total: Math.max(0, found.total - hiddenCount),
      limit,
      offset,
      ...cov,
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
