// Cloudflare Pages Function: Telegram-catalog search (RliBook, Task 2).
// Route: GET /api/tg-search?q=...&limit=...&offset=...
//
//   GET /api/tg-search?q=فن%20التواصل
//     -> 200 { ok: true, q: "فن التواصل", total: 42, limit: 10,
//              offset: 0, results: [
//                { title, author, source, kind, formats, url, flagged }, ... ] }
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
// Free-tier friendly: one D1 query (FTS MATCH, reads ~10-100 rows;
// 5M rows read/day on Workers Free) + up to `limit` parallel KV gets
// for the flag check. No catalog fetch, no heavy work. D1 writes
// happen only in the population script, never here.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OFFSET = 10000;

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

// One D1 search: FTS MATCH, rank order, bounded. Returns { total, rows }.
// `total` is the full match count (may exceed rows.length).
async function d1Search(db, match, limit, offset) {
  const countRes = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM books WHERE id IN " +
        "(SELECT rowid FROM books_fts WHERE books_fts MATCH ?)",
    )
    .bind(match)
    .first();
  const total = countRes ? Number(countRes.n) || 0 : 0;
  if (total === 0) return { total: 0, rows: [] };
  const { results } = await db
    .prepare(
      "SELECT b.id, b.title, b.author, b.source, b.kind, b.ext, b.url, b.date " +
        "FROM books_fts f JOIN books b ON b.id = f.rowid " +
        "WHERE f.books_fts MATCH ? ORDER BY f.rank LIMIT ? OFFSET ?",
    )
    .bind(match, limit, offset)
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

  if (!q) {
    return json({ ok: true, q: "", total: 0, limit, offset, results: [] });
  }

  const db = env && env.TG_D1;
  if (!db) {
    return json(
      { ok: false, error: "search unavailable (TG_D1 not bound)" },
      503,
    );
  }

  const words = queryWords(q);
  if (words.length === 0) {
    return json({ ok: true, q, total: 0, limit, offset, results: [] });
  }

  try {
    // Full AND first; fall back to the longest word alone (same spirit
    // as the bot's suggestSearch) when nothing matches all words.
    let found = await d1Search(db, ftsMatch(words), limit, offset);
    if (found.total === 0 && words.length > 1) {
      const longest = [...words].sort((a, b) => b.length - a.length)[0];
      found = await d1Search(db, ftsMatch([longest]), limit, offset);
    }
    if (found.total === 0) {
      return json({ ok: true, q, total: 0, limit, offset, results: [] });
    }
    // Flag check per result, in parallel (one KV get each, at most
    // `limit` gets; missing KV binding -> all unflagged).
    const flagged = await Promise.all(
      found.rows.map((r) => isFlagged(env, r.url)),
    );
    return json({
      ok: true,
      q,
      total: found.total,
      limit,
      offset,
      results: found.rows.map((r, i) => toResult(r, flagged[i])),
    });
  } catch (e) {
    return json(
      { ok: false, error: "search failed: " + (e && e.message ? e.message : e) },
      500,
    );
  }
}
