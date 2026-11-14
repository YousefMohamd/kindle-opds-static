// Cloudflare Pages Function: book enrichment — ratings + description
// (RliBook Blocks 4 + 9).
// Route: GET /api/ratings?title=...&author=...
//
//   GET /api/ratings?title=Dune&author=Frank%20Herbert
//     -> 200 { ok: true, title: "Dune",
//              rating: { value: 8.4, count: 12345, source: "Google Books" },
//              description: { text: "...", source: "Google Books" } }
//
// Sources (both free, no key, no payment):
//   1. Google Books API (averageRating 0-5 + ratingsCount + description)
//   2. Open Library search API (ratings_average 0-5 + ratings_count)
//      — used ONLY when Google Books has no confident match with a rating.
//
// Rating honesty: the rating is shown ONLY for a confident title match
// (see titleMatches). A miss returns rating: null — never a fake 0,
// never another book's rating. The response always names its source
// ("Google Books" / "Open Library") so the /book page can say where
// the number came from.
//
// Description: from the matched Google Books volume, shortened to a
// few lines (DESC_MAX_CHARS). The /book page prefers the Telegram post
// text (first) and uses this only when the post text is absent — the
// endpoint only ever supplies the Google Books half.
//
// Graceful degradation: any upstream failure (network, non-200,
// malformed JSON) yields rating: null + description: null with HTTP
// 200 — the /book page then simply shows no rating/description, it
// never 500s because enrichment failed.
//
// Free-tier friendly: two external fetches at most (Open Library is
// only called when Google Books yields nothing usable), no D1 — and
// a KV read-through cache (optional RLIBOOK_KV binding, 24 h): the
// /book page asks for the same titles over and over, so a cached
// answer costs one KV read instead of two upstream fetches. Without
// the binding the endpoint simply skips the cache. The response is
// cacheable for an hour (ratings change slowly).

const GB_URL = "https://www.googleapis.com/books/v1/volumes";
const OL_URL = "https://openlibrary.org/search.json";
const DESC_MAX_CHARS = 400;
const MAX_TITLE_LEN = 200; // Longer than any real title; a 400, not a query
const CACHE_TTL_SECONDS = 86400; // 24 h: ratings change slowly

// Same normalization as functions/api/tg-search.js normalizeArabic +
// stripAl: NFKC, strip tashkeel/tatweel, unify alef/hamza/yeh forms,
// ة->ه, ى->ي, lowercased, "ال" stripped from the front of a word when
// >=3 chars remain. Display text is never changed.
export function normalizeForMatch(text) {
  return (text || "")
    .normalize("NFKC")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ء/g, "")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

function stripAl(word) {
  if (word.startsWith("ال") && word.length >= 5) return word.slice(2);
  return word;
}

function matchWords(text) {
  return normalizeForMatch(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map(stripAl)
    .filter((w) => w.length >= 2);
}

/** True when `candidateTitle` is plausibly the SAME book as the query
 *  title: every word of the shorter title appears in the longer one,
 *  and any extra words are edition qualifiers only ("deluxe",
 *  "edition", "illustrated", ...). "Dune" must NOT match "Dune
 *  Messiah" (a different book) — a missed rating (null) is far better
 *  than another book's rating. Short titles (one 2-letter word) never
 *  match. Exported for tests. */
const EDITION_WORDS = new Set([
  "edition", "ed", "deluxe", "illustrated", "revised", "annotated",
  "complete", "unabridged", "abridged", "volume", "vol", "part",
  "book", "classic", "classics", "hardcover", "paperback", "ebook",
  "anniversary", "special", "collector", "definitive", "expanded",
  "updated", "new", "2nd", "3rd",
]);
export function titleMatches(candidateTitle, queryTitle) {
  const qWords = matchWords(queryTitle);
  const cWords = matchWords(candidateTitle);
  if (qWords.length === 0 || cWords.length === 0) return false;
  if (qWords.length === 1 && qWords[0].length < 3) return false;
  if (cWords.length === 1 && cWords[0].length < 3) return false;
  const qSet = new Set(qWords);
  const cSet = new Set(cWords);
  const extraInC = [...cSet].filter((w) => !qSet.has(w));
  const extraInQ = [...qSet].filter((w) => !cSet.has(w));
  if (extraInC.length === 0 && extraInQ.length === 0) return true;
  if (extraInQ.length === 0) {
    return extraInC.every((w) => EDITION_WORDS.has(w));
  }
  if (extraInC.length === 0) {
    return extraInQ.every((w) => EDITION_WORDS.has(w));
  }
  return false;
}

/** True when the candidate's author list is compatible with the query
 *  author: no author given (no check), the candidate has no authors
 *  (no check — some records lack them), or at least one author word
 *  overlaps. A candidate whose authors are all different is rejected:
 *  same title, different author is usually a different book. */
export function authorCompatible(candidateAuthors, queryAuthor) {
  const q = matchWords(queryAuthor || "");
  if (q.length === 0) return true;
  const c = (candidateAuthors || []).flatMap((a) => matchWords(a));
  if (c.length === 0) return true;
  return q.some((w) => c.includes(w));
}

function toTen(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return Math.round(n * 2 * 10) / 10; // 0-5 -> X.X / 10
}

function shortDescription(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= DESC_MAX_CHARS) return t;
  const cut = t.slice(0, DESC_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

// Pick the first confident Google Books volume with a rating.
// Returns { rating, description } with either field null.
function pickGoogle(items, title, author) {
  let description = null;
  for (const item of items || []) {
    const info = (item && item.volumeInfo) || {};
    if (!titleMatches(info.title || "", title)) continue;
    if (!authorCompatible(info.authors, author)) continue;
    if (description === null) {
      const d = shortDescription(info.description || "");
      if (d) description = { text: d, source: "Google Books" };
    }
    const value = toTen(info.averageRating);
    const count = Number(info.ratingsCount);
    if (value !== null && Number.isFinite(count) && count > 0) {
      return {
        rating: { value, count, source: "Google Books" },
        description,
      };
    }
  }
  return { rating: null, description };
}

// Pick the first confident Open Library doc with a rating.
function pickOpenLibrary(docs, title, author) {
  for (const doc of docs || []) {
    if (!titleMatches(doc.title || "", title)) continue;
    if (!authorCompatible(doc.author_name, author)) continue;
    const value = toTen(doc.ratings_average);
    const count = Number(doc.ratings_count);
    if (value !== null && Number.isFinite(count) && count > 0) {
      return { value, count, source: "Open Library" };
    }
  }
  return null;
}

// Open Library search URL. The `fields=` parameter is REQUIRED:
// without it the response omits ratings_average/ratings_count entirely
// (verified live 2026-11-14: a default search for "Dune" returns no
// rating fields at all; with fields= it returns 4.307359 / 462).
function olUrl(title, author) {
  return OL_URL + "?title=" + encodeURIComponent(title)
    + ((author || "").trim()
      ? "&author=" + encodeURIComponent(author.trim()) : "")
    + "&fields=key,title,author_name,ratings_average,ratings_count"
    + "&limit=5";
}

/** Enrich one book: Google Books first, Open Library as fallback.
// `fetchImpl` defaults to global fetch and is injectable for tests.
// Never throws: any failure yields { rating: null, description: null }.
 *  Exported for tests. */
export async function enrich(title, author, fetchImpl = fetch) {
  const empty = { rating: null, description: null };
  const qTitle = (title || "").trim();
  if (!qTitle) return empty;
  const gbQ = "intitle:" + qTitle
    + ((author || "").trim() ? "+inauthor:" + author.trim() : "");
  try {
    const gbRes = await fetchImpl(
      GB_URL + "?q=" + encodeURIComponent(gbQ) + "&maxResults=5",
      { headers: { accept: "application/json" } },
    );
    if (gbRes.ok) {
      const data = await gbRes.json();
      const picked = pickGoogle(data && data.items, qTitle, author);
      if (picked.rating) return picked;
      // Google matched the book but has no rating: still return its
      // description, and try Open Library for the rating only.
      try {
        const olRes = await fetchImpl(
          olUrl(qTitle, author),
          { headers: { accept: "application/json" } },
        );
        if (olRes.ok) {
          const olData = await olRes.json();
          const ol = pickOpenLibrary(olData && olData.docs, qTitle, author);
          if (ol) return { rating: ol, description: picked.description };
        }
      } catch (e) {
        console.warn("[ratings] open library unavailable:", e && e.message);
      }
      return picked;
    }
  } catch (e) {
    console.warn("[ratings] google books unavailable:", e && e.message);
  }
  // Google Books itself failed: try Open Library alone.
  try {
    const olRes = await fetchImpl(
      olUrl(qTitle, author),
      { headers: { accept: "application/json" } },
    );
    if (olRes.ok) {
      const olData = await olRes.json();
      const ol = pickOpenLibrary(olData && olData.docs, qTitle, author);
      if (ol) return { rating: ol, description: null };
    }
  } catch (e) {
    console.warn("[ratings] open library unavailable:", e && e.message);
  }
  return empty;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const url = new URL(context.request.url);
  const title = (url.searchParams.get("title") || "").trim();
  const author = (url.searchParams.get("author") || "").trim();
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  if (!title) {
    return json({ ok: true, title: "", rating: null, description: null });
  }
  if (title.length > MAX_TITLE_LEN) {
    return json({ ok: false, error: "title too long (max 200 characters)" }, 400);
  }
  // KV read-through cache (optional binding — missing KV just skips
  // it). A cached answer — including a cached "no rating" — costs one
  // KV read instead of two upstream fetches.
  const cacheKey = await ratingsCacheKey(title, author);
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    return json({ ok: true, title, rating: cached.rating, description: cached.description });
  }
  const found = await enrich(title, author);
  await cachePut(env, cacheKey, found);
  return json({ ok: true, title, rating: found.rating, description: found.description });
}

// Cache key for one (title, author): the identity is hashed, so no
// title text ever appears in a KV key. Exported for tests.
export async function ratingsCacheKey(title, author) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      String(title || "").trim().toLowerCase() + "\n" + String(author || "").trim().toLowerCase(),
    ),
  );
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "ratings:" + hex;
}

// Read one cached enrichment, or null (missing binding, missing key,
// malformed value — all mean "not cached", never an error).
async function cacheGet(env, key) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !("rating" in v) || !("description" in v)) return null;
    return { rating: v.rating, description: v.description };
  } catch (e) {
    return null;
  }
}

// Store one enrichment (best-effort: a KV failure never fails the request).
async function cachePut(env, key, value) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.put !== "function") return;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (e) {
    // Best-effort only.
  }
}
