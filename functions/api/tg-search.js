// Cloudflare Pages Function: Telegram-catalog search (RliBook, Task 2).
// Route: GET /api/tg-search?q=...&limit=...&offset=...&source=...
//
//   GET /api/tg-search?q=فن%20التواصل
//     -> 200 { ok: true, q: "فن التواصل", total: 42, limit: 10,
//              offset: 0,
//              coverage: { indexed: 149996, target: 323325, partial: true },
//              results: [
//                { title, author, source, kind, formats, url, flagged }, ... ] }
//   GET /api/tg-search?source=EBook_Library&q=...  — same search, but only
//     books whose source (channel/group handle) is exactly EBook_Library.
//     Powers the per-library browse links on /telegram/libraries.html.
//     With source= and no q, returns that library's books (newest first
//     is NOT guaranteed — FTS rank needs a query; empty-q source browse
//     lists by id order, capped by limit).
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
// Flagged (commercial) books: the endpoint IDENTIFIES them, it does not
// enforce the cap. For each result it checks the shared KV denylist
// (same mechanism as functions/api/dl-token.js): a KV key
// `flag:<handle>:<post_id>` means the book IS flagged/commercial.
// The handle + post_id come from the result's t.me post URL. The bot
// enforces the 3/day successful-flagged-search cap and the
// invite-unlocks-3-more rule. If RLIBOOK_KV is not bound, or no flag
// key exists, flagged is false — the honest v1 limit (same as the
// token issuer): "not flagged" means "not on the denylist". Block 7
// populates the `flag:` keys from the bot's flags.ts list; until then
// the bot's own matchFlagged check on the query remains the primary
// flag gate.
//
// Env (Pages dashboard -> Settings -> Functions):
//   D1 binding  TG_D1       (required) — the Telegram catalog database.
//                            Create it (wrangler d1 create rlibook-tg),
//                            apply functions/api/tg-search-schema.sql,
//                            populate with telegram/tbi/d1_sync.py.
//   KV binding  RLIBOOK_KV  (optional) — the shared namespace the bot +
//                            OPDS feed use; flag denylist keys
//                            `flag:<handle>:<post_id>`. Missing -> all
//                            results report flagged: false.
//
// Response is metadata + links only (title, author, source, format,
// t.me post link). No book file bytes are ever returned or stored.
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
// snapshot (indexed < target). Callers (e.g. /book) show the partial
// note only while partial is true, so it disappears on its own when
// the import finishes.
//
// Free-tier friendly: one D1 query (FTS MATCH, reads ~10-100 rows;
// 5M rows read/day on Workers Free) + up to `limit` parallel KV gets
// for the flag check. No catalog fetch, no heavy work. D1 writes
// happen only in the population script, never here.

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
// A key `flag:<handle>:<post_id>` means flagged/commercial.
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

// D1 final-import target (distinct books). The import finishes
// 2026-11-19; until then D1 holds fewer books and `partial` is true.
// This is NOT the catalog manifest total (326,149 books on
// 2026-11-14, and growing) — never conflate the two.
const D1_FINAL_TARGET = 323325;

// Coverage of the D1 snapshot: how many books D1 holds right now vs
// the final-import target. Same direct COUNT(*) the endpoint already
// uses for match totals (and /api/stats uses for books_d1.count).
// Never throws: on any failure returns null and the caller omits the
// field, so a failed count can never break a search.
async function d1Coverage(db) {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM books").bind().first();
    const indexed = row ? Number(row.n) || 0 : 0;
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
        "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.url, b.date " +
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
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.url, b.date " +
        "FROM books_fts f JOIN books b ON b.id = f.rowid " +
        "WHERE f.books_fts MATCH ?" + srcClause + " ORDER BY f.rank LIMIT ? OFFSET ?",
    )
    .bind(match, ...srcParams, limit, offset)
    .all();
  return { total, rows: results || [] };
}

function toResult(row, flagged) {
  const author = row.author && String(row.author).trim() ? row.author : null;
  const ext = (row.ext || "").trim().toUpperCase();
  return {
    title: row.title,
    author,
    source: row.source,
    kind: row.kind || "channel",
    formats: ext ? [ext] : [],
    url: row.url,
    flagged: !!flagged,
  };
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

  // Coverage is computed once per request and attached to every ok:true
  // reply below (spread as `...cov`); a failed count yields no field
  // rather than a broken search.
  const coverage = await d1Coverage(db);
  const cov = coverage ? { coverage } : {};

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
      const flagged = await Promise.all(
        found.rows.map((r) => isFlagged(env, r.url)),
      );
      return json({
        ok: true, q: "", source, total: found.total, limit, offset, ...cov,
        results: found.rows.map((r, i) => toResult(r, flagged[i])),
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
    // `limit` gets; missing KV binding -> all unflagged).
    const flagged = await Promise.all(
      found.rows.map((r) => isFlagged(env, r.url)),
    );
    return json({
      ok: true,
      q,
      ...(source ? { source } : {}),
      total: found.total,
      limit,
      offset,
      ...cov,
      results: found.rows.map((r, i) => toResult(r, flagged[i])),
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
