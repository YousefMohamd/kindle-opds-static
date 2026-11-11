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
export async function onRequest(context) {
  const url = new URL(context.request.url);
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
  ];
  const needle = q.toLowerCase();
  const hits = [];
  for (const lib of LIBS) {
    const idxUrl = new URL("/" + lib.slug + "/search-index.json", url.origin);
    const res = await fetch(idxUrl.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) return new Response("search index not found: /" + lib.slug + "/search-index.json", {status: 500});
    const books = await res.json();
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
