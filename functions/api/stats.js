// Cloudflare Pages Function: live site statistics (RliBook, Block 11c).
// Route: GET /api/stats
//
//   GET /api/stats
//     -> 200 { ok: true, generated_at, books, books_d1, files, posts,
//              sources, libraries, libraries_count, newest, newspapers,
//              views, downloads, bot }
//
// Every number comes from a live source at request time — nothing is
// hardcoded:
//   - Telegram catalog (books / files / posts / sources / newest):
//     the published manifest /site/telegram/index.json and
//     /site/telegram/newest.json (rebuilt daily by the indexer).
//   - D1 search index: when the TG_D1 binding exists, the count comes
//     from the SAME KV cache /api/tg-search uses (RLIBOOK_KV key
//     `tg-search:coverage`, 1 h TTL — see d1CountCached below), not
//     from a bare SELECT COUNT(*) on every request: a bare COUNT(*)
//     scans ~150k rows and would burn the 5M rows/day free tier.
//     On a cache miss (or a KV error / malformed value / no
//     RLIBOOK_KV binding) it falls back to the live COUNT(*) once
//     and best-effort repopulates the cache. D1 is a snapshot import
//     of the manifest, not the live catalog: it is still partial
//     (finishing Thu 2026-11-19 at 323,325 books) and the manifest
//     keeps growing daily, so the D1 count stays below the manifest
//     total. Both numbers are reported side by side with their
//     source — the manifest is the headline count.
//   - OPDS libraries (khazendar, sahwa, electronic, hindawi, doab):
//     each library's published search-index.json, counted (array
//     length) at build time. These are static catalogs, rebuilt only
//     when the catalog is rebuilt.
//   - Newspapers: /site/newspapers.json (date + entries).
//   - Views / downloads: NOT measured yet. There is no analytics on
//     the site until Cloudflare Web Analytics is enabled for the
//     rlibook.tech zone (a user step — see the stats page and
//     blocks-open-questions.md). The endpoint returns null for both,
//     with a note, instead of inventing numbers.
//   - Bot usage stats: NOT published by any API yet, so null with a
//     note. The bot is a separate worker; when it publishes a stats
//     endpoint this function can read it.
//
// Cost: the manifest (26 KB) + newest (5.5 KB) + newspapers + the
// five OPDS indexes (~2.9 MB total) are fetched once per build, then
// the response is cached in caches.default for 1 hour, so a normal
// page view costs one cache lookup, not a rebuild. If any one source
// fails, that section reports null + a reason and the rest still
// returns — the endpoint never 500s because one library is down, and
// it never invents a number for a source it could not read. Only a
// missing manifest (the headline count) is a 503.
//
// Env (Pages dashboard -> Settings -> Functions):
//   D1 binding  TG_D1  (optional) — the Telegram catalog database.
//                         Missing -> books_d1 is null, manifest only.
//   ASSETS binding is provided by Pages automatically and is used to
//   read the static files without a network round-trip; without it
//   the function falls back to fetching the same paths from the
//   request origin.
//
// Free-tier friendly: one cached JSON per hour; a rebuild is a few
// small static fetches + a KV read for the D1 count (one live
// COUNT(*) at most once an hour, when the cache is cold and D1 is
// bound). No book file bytes are ever returned or stored — metadata
// + counts only.

// The five OPDS libraries: key, display name, site path, and the
// published search index the count is read from. Names and paths are
// the site's own structure; the COUNTS are computed at request time.
const OPDS_LIBRARIES = [
  { key: "khazendar",  name: "خازندار",               path: "/khazendar/",  index: "/khazendar/search-index.json" },
  { key: "sahwa",      name: "مكتبة صحوه",            path: "/sahwa/",      index: "/sahwa/search-index.json" },
  { key: "electronic", name: "المكتبة الإلكترونية",    path: "/electronic/", index: "/electronic/search-index.json" },
  { key: "hindawi",    name: "مكتبة صفحات — هنداوي",  path: "/hindawi/",    index: "/hindawi/search-index.json" },
  { key: "doab",       name: "DOAB",                  path: "/doab/",       index: "/doab/search-index.json" },
];

const MANIFEST_PATH = "/site/telegram/index.json";
const NEWEST_PATH = "/site/telegram/newest.json";
const NEWSPAPERS_PATH = "/site/newspapers.json";
const CACHE_SECONDS = 3600; // 1 hour: the manifest itself is daily.

// Read one static file of this site: the Pages ASSETS binding when
// present (no network), otherwise a same-origin fetch.
async function fetchStatic(env, origin, path) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
    const res = await env.ASSETS.fetch(
      new Request("https://rlibook.assets" + path)
    );
    if (!res.ok) throw new Error(path + " (HTTP " + res.status + ")");
    return res;
  }
  const res = await fetch(origin + path);
  if (!res.ok) throw new Error(path + " (HTTP " + res.status + ")");
  return res;
}

async function fetchJson(env, origin, path) {
  const res = await fetchStatic(env, origin, path);
  return res.json();
}

// Count the entries of a search-index.json (a JSON array). Returns
// null on any failure — the caller reports the reason, never a guess.
function countIndexArray(parsed) {
  if (!Array.isArray(parsed)) return null;
  return parsed.length;
}

// Pure builder: turns the already-fetched live sources into the stats
// object. Exported for tests (node functions/api/stats.test.mjs).
//   manifest:   parsed /site/telegram/index.json (or null on failure)
//   newest:     parsed /site/telegram/newest.json (or null)
//   newspapers: parsed /site/newspapers.json (or null)
//   opdsCounts: { khazendar: 6392 | null, ... } — null = unreadable
//   d1Count:    COUNT(*) FROM books, or null when D1 is not bound/read
export function buildStats(manifest, newest, newspapers, opdsCounts, d1Count) {
  const now = new Date().toISOString();
  const t = (manifest && manifest.totals) || {};
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

  // Telegram sources by kind (channel / group) — derived from the
  // manifest's own sources list, never hardcoded.
  let channels = null;
  let groups = null;
  if (manifest && Array.isArray(manifest.sources)) {
    channels = 0;
    groups = 0;
    for (const s of manifest.sources) {
      if (s.kind === "group") groups += 1;
      else if (s.kind === "channel") channels += 1;
    }
  }

  const libraries = OPDS_LIBRARIES.map((lib) => ({
    key: lib.key,
    name: lib.name,
    path: lib.path,
    books: num(opdsCounts ? opdsCounts[lib.key] : null),
    books_source:
      opdsCounts && typeof opdsCounts[lib.key] === "number"
        ? "live count of " + lib.index + " (published search index)"
        : "unavailable — " + lib.index + " could not be read",
  }));
  libraries.push({
    key: "telegram",
    name: "فهرس كتب تيليجرام",
    path: "/telegram/",
    books: num(t.books),
    books_source: "live catalog manifest " + MANIFEST_PATH,
  });
  const opdsTotal = libraries
    .filter((l) => l.key !== "telegram" && typeof l.books === "number")
    .reduce((sum, l) => sum + l.books, 0);
  const opdsComplete = libraries
    .filter((l) => l.key !== "telegram")
    .every((l) => typeof l.books === "number");
  const telegramBooks = num(t.books);
  const totalBooks =
    telegramBooks !== null && opdsComplete ? telegramBooks + opdsTotal : null;

  const newestBooks = Array.isArray(newest && newest.books)
    ? newest.books.map((b) => ({
        title: b.title || "",
        author: b.author || "",
        source: b.source || "",
        format: b.format || "",
        date: b.date || "",
        url: b.url || "",
      }))
    : [];

  const paperEntries =
    newspapers && Array.isArray(newspapers.sources)
      ? newspapers.sources.reduce(
          (sum, s) => sum + (typeof s.entries === "number" ? s.entries : 0),
          0
        )
      : null;

  return {
    ok: true,
    generated_at: now,
    books: {
      telegram: telegramBooks,
      opds: opdsComplete ? opdsTotal : null,
      total: totalBooks,
      source:
        "Live — Telegram count from the catalog manifest " +
        MANIFEST_PATH +
        " (generated " +
        (manifest && manifest.generated_at ? manifest.generated_at : "unknown") +
        "); OPDS counts from each library's published search-index.json. " +
        "Total is null until every library count is readable.",
    },
    books_d1: {
      count: num(d1Count),
      source: "D1 database (TG_D1) — SELECT COUNT(*) FROM books",
      note:
        d1Count === null
          ? "D1 is not bound or not readable — the manifest count above is the live total."
          : "Live search-index count. D1 is a snapshot import of the manifest, still partial (finishing Thu 2026-11-19 at 323,325 books); the manifest keeps growing daily, so this stays below the manifest total. The manifest is the headline count.",
    },
    files: {
      telegram: num(t.files),
      source: "Live — catalog manifest " + MANIFEST_PATH,
    },
    posts: {
      telegram: num(t.posts),
      source: "Live — catalog manifest " + MANIFEST_PATH,
    },
    sources: {
      telegram_total: num(t.sources),
      channels: channels,
      groups: groups,
      source: "Live — catalog manifest " + MANIFEST_PATH + " (sources list, by kind)",
    },
    libraries: libraries,
    libraries_count: libraries.length,
    newest: {
      generated_at: (newest && newest.generated_at) || null,
      count: newestBooks.length,
      books: newestBooks,
      source: "Live — " + NEWEST_PATH + " (newest books, rebuilt daily)",
    },
    newspapers: {
      date: (newspapers && newspapers.date) || null,
      entries: paperEntries,
      sources:
        newspapers && Array.isArray(newspapers.sources)
          ? newspapers.sources.length
          : null,
      source: "Live — " + NEWSPAPERS_PATH,
    },
    views: {
      count: null,
      source: null,
      note: "Not measured yet — Cloudflare Web Analytics is not enabled for the rlibook.tech zone. Enable it in the Cloudflare dashboard (Web Analytics for the zone, then paste the token into the beacon snippet) and this will report real visits.",
    },
    downloads: {
      count: null,
      source: null,
      note: "Not measured yet — downloads go through the Telegram bot / Send-to-Kindle email, and neither publishes a count yet. No number is invented here.",
    },
    bot: {
      stats: null,
      source: null,
      note: "Bot usage stats are not published by any API yet (the bot is a separate worker). When the bot publishes a stats endpoint, this endpoint will read it.",
    },
  };
}

// D1 count cache — the SAME key /api/tg-search uses (see
// functions/api/tg-search.js: `tg-search:coverage`, 1 h TTL).
// The D1 indexed count changes once a day (the daily import), not
// per request, so it is cached in KV (the RLIBOOK_KV binding) instead
// of running a full-table COUNT(*) on every stats request. A bare
// COUNT(*) scans ~150k rows; at the 5M rows/day free-tier budget a
// handful of uncached stats rebuilds a day would already hurt. With
// a 1 h TTL the count is refreshed at most 24 times/day and is at
// most 1 h stale — fine for a "how complete is D1" indicator. On a
// cache miss, a KV error, or a malformed cached value, the code falls
// back to the live COUNT(*) (and best-effort repopulates the cache),
// so a missing or broken cache can never break the stats response.
const COVERAGE_CACHE_KEY = "tg-search:coverage";
const COVERAGE_CACHE_TTL_SECONDS = 3600; // 1 h

// Read the cached D1 count (an integer), or null. Never throws.
// Same validation as tg-search.js coverageCacheGet.
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

// Store the D1 count (best-effort: a KV failure never fails the
// request). Same expirationTtl pattern as tg-search.js coverageCachePut.
async function coverageCachePut(env, indexed) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.put !== "function") return;
  try {
    await kv.put(COVERAGE_CACHE_KEY, JSON.stringify({ indexed, at: Date.now() }), { expirationTtl: COVERAGE_CACHE_TTL_SECONDS });
  } catch (e) {
    // Best-effort only.
  }
}

// D1 book count, read-through: KV cache first, live COUNT(*) on a
// miss/error, best-effort repopulate. Never throws: on any failure
// returns null and the caller reports books_d1.count null with the
// manifest count standing. Returns null when D1 is not bound.
async function d1CountCached(db, env) {
  if (!db) return null;
  const cached = await coverageCacheGet(env);
  if (cached !== null) return cached;
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM books").first();
    if (row && typeof row.n === "number") {
      const n = row.n;
      await coverageCachePut(env, n);
      return n;
    }
    return null;
  } catch (e) {
    console.warn("[stats] D1 count failed:", e && e.message);
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return Response.json(
      { ok: false, error: "Method not allowed — use GET /api/stats" },
      { status: 405 }
    );
  }

  // Serve the cached build when fresh (1 hour). The cache key is the
  // request URL. Any cache failure falls through to a fresh build.
  let cache = null;
  let cacheKey = null;
  try {
    if (typeof caches !== "undefined" && caches.default) {
      cache = caches.default;
      cacheKey = new Request(request.url, { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
  } catch (e) {
    cache = null; // no cache available (e.g. local test) — build fresh
  }

  const origin = new URL(request.url).origin;

  // The manifest is the headline count: without it there is nothing
  // honest to report, so this is the one hard failure (503).
  let manifest = null;
  try {
    manifest = await fetchJson(env, origin, MANIFEST_PATH);
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: "Catalog manifest unavailable (" + MANIFEST_PATH + "): " + e.message,
        note: "No numbers are returned when the live source cannot be read.",
      },
      { status: 503 }
    );
  }

  let newest = null;
  try {
    newest = await fetchJson(env, origin, NEWEST_PATH);
  } catch (e) {
    newest = null; // newest section reports empty + its source; not fatal
  }

  let newspapers = null;
  try {
    newspapers = await fetchJson(env, origin, NEWSPAPERS_PATH);
  } catch (e) {
    newspapers = null;
  }

  const opdsCounts = {};
  for (const lib of OPDS_LIBRARIES) {
    try {
      const parsed = await fetchJson(env, origin, lib.index);
      opdsCounts[lib.key] = countIndexArray(parsed);
    } catch (e) {
      opdsCounts[lib.key] = null;
    }
  }

  // D1 count via the shared KV coverage cache (see d1CountCached):
  // a KV hit avoids the full-table COUNT(*); a miss/error falls back
  // to the live count once. Never fails the response.
  const d1Count = await d1CountCached(env && env.TG_D1 ? env.TG_D1 : null, env);

  const body = buildStats(manifest, newest, newspapers, opdsCounts, d1Count);
  const response = Response.json(body, {
    headers: { "Cache-Control": "public, max-age=" + CACHE_SECONDS },
  });

  try {
    if (cache && cacheKey) {
      await cache.put(cacheKey, response.clone());
    }
  } catch (e) {
    // Cache write failure is not a request failure.
  }
  return response;
}
