// Cloudflare Pages Function: OPDS search for one library.
// Route: /khazendar/opds/search?q=...
// Loads /khazendar/search-index.json (static asset, same Pages project),
// filters by substring in title or author (case-insensitive),
// returns an OPDS acquisition feed, max 100 results.
// Download links are the same Drive uc?id links as the static catalog.
// No Drive write, no Mac server involved.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const lib = "khazendar";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (!q) {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>Search ' + lib + '</title><id>urn:search:' + lib + '</id><updated>2026-11-03T00:00:00Z</updated></feed>', {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
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
  out += "<title>Search: " + esc(q) + "</title><id>urn:search:" + lib + ":" + esc(q) + "</id><updated>2026-11-03T00:00:00Z</updated>";
  out += '<link rel="self" href="/' + lib + '/opds/search?q=' + encodeURIComponent(q) + '" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>';
  out += "<opds:totalResults>" + hits.length + "</opds:totalResults>";
  for (const b of hits) {
    out += "<entry><title>" + esc(b.t) + "</title><id>urn:drive:" + esc(b.i) + "</id><updated>2026-11-03T00:00:00Z</updated>";
    if (b.a) out += "<author><name>" + esc(b.a) + "</name></author>";
    out += '<link rel="http://opds-spec.org/acquisition" href="https://drive.google.com/uc?id=' + esc(b.i) + '&amp;export=download" type="' + esc(b.m || "application/octet-stream") + '"/>';
    out += "</entry>";
  }
  out += "</feed>";
  return new Response(out, {headers: {"content-type": "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8"}});
}
