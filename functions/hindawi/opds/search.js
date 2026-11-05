// Cloudflare Pages Function: OPDS search for one library.
// Route: /hindawi/opds/search?q=...
// Loads /hindawi/search-index.json (static asset, same Pages project),
// filters by substring in title or author (case-insensitive),
// returns an OPDS acquisition feed, max 100 results.
// Download links are the Hindawi EPUB links, https://www.hindawi.org/books/<booknr>.epub,
// the same pattern as the static catalog. No Drive links here.
// No Drive write, no Mac server involved.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const lib = "hindawi";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (!q) {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Search ' + lib + '</title><id>urn:search:' + lib + '</id><updated>2026-11-05T00:00:00Z</updated></feed>', {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
  }
  const idxUrl = new URL("/" + lib + "/search-index.json", url.origin);
  const res = await fetch(idxUrl.toString(), {headers: {"accept": "application/json"}});
  if (!res.ok) return new Response("search index not found", {status: 500});
  const books = await res.json();
  const needle = q.toLowerCase();
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
    out += "<entry><title>" + esc(b.t) + "</title><id>urn:hindawi:" + esc(b.i) + "</id><updated>2026-11-05T00:00:00Z</updated>";
    if (b.a) out += "<author><name>" + esc(b.a) + "</name></author>";
    out += '<link rel="http://opds-spec.org/acquisition" href="https://www.hindawi.org/books/' + esc(b.i) + '.epub" type="' + esc(b.m || "application/epub+zip") + '"/>';
    out += "</entry>";
  }
  out += "</feed>";
  return new Response(out, {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
}
