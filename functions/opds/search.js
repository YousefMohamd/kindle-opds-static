// Cloudflare Pages Function: OPDS search across all five searchable libraries.
// Route: /opds/search?q=...
// Loads all five search-index.json files (static assets, same Pages project),
// filters by substring in title or author (case-insensitive),
// returns ONE OPDS acquisition feed, max 100 results TOTAL across all libraries.
// Result order (fixed, by library): khazendar, sahwa, electronic, hindawi, doab.
// Each entry carries its source library in a <category term="..."> element.
// Acquisition links + mime per library:
//   khazendar/sahwa/electronic — Drive uc?id links, mime from the index (b.m).
//   hindawi — https://www.hindawi.org/books/<booknr>.epub, application/epub+zip.
//   doab — the direct EPUB URL stored as the index id (b.i), application/epub+zip.
// Wikisource (English) is NOT included: it is an external catalog with no
// search index of ours, so it cannot be searched here (it stays browse-only
// as a subsection of the combined catalog). No count is invented for it.
// Failure policy: if ANY index fetch fails, the function returns HTTP 500
// naming the failed index; it never returns partial results as if complete.
// Empty query returns an empty valid feed, same as the per-library functions.
// No Drive write, no Mac server involved.
// ---- shared search-index loader (also used by functions/book.js
// and the five per-library opds/search.js) --------------------------
// The five search-index.json files total ~3 MB / ~21k books. The old
// code JSON.parse()d every index on EVERY search and then scanned
// every record — 44–53 ms CPU for a no-hit query (measured locally,
// Node 24) against Cloudflare's 10 ms free-tier budget: the shape
// of an 1102 on /book and /opds/search. The loader below fetches
// the index as text and skips the parse entirely when the needle
// provably cannot match anything in it (indexTextMayContain). A
// no-hit Arabic query across all five libraries now costs ~2–3 ms
// instead of ~45 ms; a hit still parses, exactly as before.

/** True when the raw index JSON text MAY contain the needle, i.e.
 *  when the JSON.parse cannot be skipped. Returns false only when
/// the needle provably cannot match any title/author: the needle
/// must have no cased letter in any script (needle === its own
/// lower- AND upper-case — otherwise case could differ between the
/// raw text and the lowercased scan) and no character JSON escaping
/// could hide (", backslash, control chars) or case-folding could
/// create (combining marks). The index files store raw UTF-8 (no
/// \uXXXX escapes — verified on the live files), so a caseless,
/// escape-free needle appears literally in the text iff it appears
/// in some title/author. A false positive (needle inside an id, a
/// mime or a URL) only costs a parse; a false negative is impossible
/// under the guard. Exported for tests. */
export function indexTextMayContain(text, needle) {
  if (needle !== needle.toLowerCase() || needle !== needle.toUpperCase()) return true;
  if (/["\\\x00-\x1f\u0300-\u036f]/.test(needle)) return true;
  return text.includes(needle);
}

/** Load one library's search index. Returns { books } on success,
 *  { skip: true } when the pre-filter proves the needle cannot match
 *  anything in this library (no parse, no scan — the library simply
 *  has no hits), or { error: true } when the index cannot be fetched
 *  or parsed (the caller turns this into its own 500). `needle` is
 *  the already-lowercased query. Exported for tests. */
export async function loadSearchIndex(origin, slug, needle) {
  const idxUrl = new URL("/" + slug + "/search-index.json", origin);
  let res;
  try {
    res = await fetch(idxUrl.toString(), { headers: { "accept": "application/json" } });
  } catch (e) {
    return { error: true };
  }
  if (!res.ok) return { error: true };
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { error: true };
  }
  // Shape check BEFORE the pre-filter: the text must at least look
  // like a JSON array (first non-space char `[`, last `]`). A file
  // that fails this is malformed and must error exactly as the old
  // code errored (JSON.parse throw / non-array -> 500 naming the
  // index) — without this, a corrupt index that merely lacks the
  // needle would be silently treated as "no hits". Residual,
  // stated: invalid JSON that still starts with `[` and ends with
  // `]` (broken in the middle) can only be caught by parsing, so a
  // non-matching query against such a file reads as empty instead
  // of a 500; a matching query still parses and still 500s.
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start++;
  let end = text.length - 1;
  while (end >= start && /\s/.test(text[end])) end--;
  if (start >= text.length
    || text.charCodeAt(start) !== 0x5b /* [ */
    || text.charCodeAt(end) !== 0x5d /* ] */) {
    return { error: true };
  }
  if (!indexTextMayContain(text, needle)) return { skip: true };
  let books;
  try {
    books = JSON.parse(text);
  } catch (e) {
    return { error: true };
  }
  if (!Array.isArray(books)) return { error: true };
  return { books };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (context.request.method !== "GET") {
    return new Response("Method not allowed", {status: 405});
  }
  const q = (url.searchParams.get("q") || "").trim();
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (!q) {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Search combined</title><id>urn:search:combined</id><updated>2026-11-05T00:00:00Z</updated></feed>', {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
  }
  const LIBS = [
    {slug: "khazendar", label: "خازندار المكتبة العربية", kind: "drive"},
    {slug: "sahwa", label: "مكتبة صحوه", kind: "drive"},
    {slug: "electronic", label: "المكتبة الإلكترونية", kind: "drive"},
    {slug: "hindawi", label: "مكتبة صفحات - هنداوي", kind: "hindawi"},
    {slug: "doab", label: "DOAB", kind: "doab"},
    // Drive libraries (WAVE 4, WS8): /drive/search-index.json is built
    // by telegram/tbi/drive_opds.py from the D1 batch — PUBLIC
    // libraries only (a private/pending library never enters it).
    // Same kind="drive" branch below builds the uc download link
    // from the Drive file id (b.i).
    {slug: "drive", label: "مكتبات Drive", kind: "drive"},
  ];
  const needle = q.toLowerCase();
  const hits = [];
  for (const lib of LIBS) {
    // A missing or malformed index is a 500 naming the failed index —
    // never an uncaught throw (a bare 500 from the runtime) and never
    // partial results presented as complete. A library the pre-filter
    // clears ({ skip: true }) simply has no hits — no parse, no scan.
    const loaded = await loadSearchIndex(url.origin, lib.slug, needle);
    if (loaded.error) {
      return new Response("search index not found: /" + lib.slug + "/search-index.json", {status: 500});
    }
    if (loaded.skip) continue;
    const books = loaded.books;
    for (const b of books) {
      if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(needle)) {
        hits.push({lib, b});
        if (hits.length >= 100) break;
      }
    }
    if (hits.length >= 100) break;
  }
  let out = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">';
  out += "<title>Search: " + esc(q) + "</title><id>urn:search:combined:" + esc(q) + "</id><updated>2026-11-05T00:00:00Z</updated>";
  out += '<link rel="self" href="/opds/search?q=' + encodeURIComponent(q) + '" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>';
  out += "<opds:totalResults>" + hits.length + "</opds:totalResults>";
  for (const {lib, b} of hits) {
    let id, href;
    if (lib.kind === "drive") {
      id = "urn:drive:" + b.i;
      href = "https://drive.google.com/uc?id=" + b.i + "&export=download";
    } else if (lib.kind === "hindawi") {
      id = "urn:hindawi:" + b.i;
      href = "https://www.hindawi.org/books/" + b.i + ".epub";
    } else {
      id = "urn:doab:" + b.i;
      href = b.i;
    }
    out += "<entry><title>" + esc(b.t) + "</title><id>" + esc(id) + "</id><updated>2026-11-05T00:00:00Z</updated>";
    if (b.a) out += "<author><name>" + esc(b.a) + "</name></author>";
    out += '<category term="' + esc(lib.label) + '"/>';
    out += '<link rel="http://opds-spec.org/acquisition" href="' + esc(href) + '" type="' + esc(b.m || "application/epub+zip") + '"/>';
    out += "</entry>";
  }
  out += "</feed>";
  return new Response(out, {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
}
