// Cloudflare Pages Function: OPDS search for one library.
// Route: /doab/opds/search?q=...
// Loads /doab/search-index.json (static asset, same Pages project),
// filters by substring in title or author (case-insensitive),
// returns an OPDS acquisition feed, max 100 results.
// Download links are the direct EPUB URLs stored as the index id (b.i),
// the same URLs as the static catalog. No Drive links here.
// No Drive write, no Mac server involved.
import { loadSearchIndex } from "../../opds/search.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (context.request.method !== "GET") {
    return new Response("Method not allowed", {status: 405});
  }
  const q = (url.searchParams.get("q") || "").trim();
  const lib = "doab";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (!q) {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Search ' + lib + '</title><id>urn:search:' + lib + '</id><updated>2026-11-05T00:00:00Z</updated></feed>', {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
  }
  const needle = q.toLowerCase();
  // Shared loader (functions/opds/search.js): fetches the index as
  // text and skips the JSON.parse when the needle provably cannot
  // match anything in it — parsing a ~1 MB index on every search
  // cost ~10–17 ms CPU against the 10 ms budget (1102 shape).
  // A missing or malformed index is a 500 naming the problem — never an
  // uncaught throw (a bare 500 from the runtime) and never partial
  // results presented as complete.
  const loaded = await loadSearchIndex(url.origin, lib, needle);
  if (loaded.error) return new Response("search index not found", {status: 500});
  const books = loaded.skip ? [] : loaded.books;
  const hits = [];
  for (const b of books) {
    if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(needle)) {
      hits.push(b);
      if (hits.length >= 100) break;
    }
  }
  let out = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">';
  out += "<title>Search: " + esc(q) + "</title><id>urn:search:" + lib + ":" + esc(q) + "</id><updated>2026-11-05T00:00:00Z</updated>";
  out += '<link rel="self" href="/' + lib + '/opds/search?q=' + encodeURIComponent(q) + '" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>';
  out += "<opds:totalResults>" + hits.length + "</opds:totalResults>";
  for (const b of hits) {
    out += "<entry><title>" + esc(b.t) + "</title><id>urn:doab:" + esc(b.i) + "</id><updated>2026-11-05T00:00:00Z</updated>";
    if (b.a) out += "<author><name>" + esc(b.a) + "</name></author>";
    out += '<link rel="http://opds-spec.org/acquisition" href="' + esc(b.i) + '" type="' + esc(b.m || "application/epub+zip") + '"/>';
    out += "</entry>";
  }
  out += "</feed>";
  return new Response(out, {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
}
