// Cloudflare Pages Function: personal OPDS feed (Block 8, RliBook).
// Route: /opds/<fp>/ and sub-routes, via functions/opds/[[fp]].js
//   (multipath catch-all under /opds/ — context.params.fp is the
//   remaining path segments as an array).
//
//   GET /opds/<fp>/            — personal navigation feed: the 6 public
//                                 libraries (same as the combined catalog
//                                 index.xml) + "My Private Books" when
//                                 the fingerprint is valid.
//   GET /opds/<fp>/private    — the user's private books (acquisition
//                                 feed, from KV priv:<tg_id>).
//   GET /opds/<fp>/search?q=  — fingerprinted search: the public combined
//                                 search plus the user's matching private
//                                 books, prepended.
//   GET /opds/<fp>/opensearch — OpenSearch description for the search
//                                 above (same shape as opds-search.xml).
//
// Fingerprint: the 22-char base64url HMAC token the v4 bot generates
// (catalog.ts: base64url(HMAC-SHA256(CATALOG_SECRET, "rlibook:<tg_id>"))[:22]).
// Verification is a KV lookup: fp:<token> -> { tg_id, created_at }.
// A fingerprint is valid ONLY while its KV key exists; deleting the key
// revokes it. The KV binding is env.RLIBOOK_KV — bind the SAME namespace
// the bot uses (Pages project Settings -> Functions -> KV namespace
// bindings, variable RLIBOOK_KV). If the binding is missing, every
// fingerprint is treated as unverified (public catalog only) — the
// function still works, it just cannot show private books.
//
// Invalid / unknown / revoked fingerprint: the feed is still served
// (the public catalog is public) but WITHOUT the private section, and
// with a clear bilingual notice that the catalog link is not valid.
// Private books NEVER appear without a valid fingerprint.
//
// Private books are metadata only (title, author, source, added_at
// from KV priv:<tg_id>). The file itself lives on the user's own Drive,
// never on our server. An acquisition link is emitted ONLY when the
// record carries a real downloadable reference (drive_id today). The
// Block 2 download-proxy link (https://<proxy>/dl?h=..&p=..&f=..&t=..)
// needs a signed token from the token issuer, which is not built yet —
// so no proxy link is emitted today; see opds-feed/README.md for the
// follow-ups.
//
// Entry format matches the existing catalog (functions/opds/search.js +
// index.xml): same <entry> shape, same acquisition link relation, same
// content-type headers, same XML escaping. One deliberate fix: the
// public combined search.js double-escapes its Drive links
// (builds the href with "&amp;" then passes it through esc() ->
// "&amp;amp;" in the output — verified live 2026-11-10). This function
// builds raw URLs and escapes exactly once, so its links are correct.
//
// Free-tier friendly: root / private / opensearch do no heavy fetching
// (one KV read each); search fetches the same five search-index.json
// files the public search already fetches (~3 MB total) — same cost
// profile as the existing /opds/search.

const NAV_CT = "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8";
const ACQ_CT = "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8";
const OSD_CT = "application/opensearchdescription+xml; charset=utf-8";

// Same fingerprint shape as the bot (src/catalog.ts isFingerprint).
const FP_RE = /^[A-Za-z0-9_-]{22}$/;

// The six libraries, Arabic-first — same titles, ids, hrefs, counts and
// updated dates as the combined catalog (index.xml). Counts are from the
// 2026-11-03/05 snapshot; refresh them when the catalog snapshot is rebuilt.
const LIBRARIES = [
  { title: "خازندار المكتبة العربية", id: "urn:static:libraries:khazendar", href: "/khazendar/index.xml", content: "6392 book", updated: "2026-11-04T00:00:00Z" },
  { title: "مكتبة صحوه", id: "urn:static:libraries:sahwa", href: "/sahwa/index.xml", content: "1593 book", updated: "2026-11-04T00:00:00Z" },
  { title: "المكتبة الإلكترونية", id: "urn:static:libraries:electronic", href: "/electronic/index.xml", content: "10552 book", updated: "2026-11-04T00:00:00Z" },
  { title: "مكتبة صفحات - هنداوي", id: "urn:static:libraries:hindawi", href: "/hindawi/index.xml", content: "1745 book", updated: "2026-11-05T00:00:00Z" },
  { title: "DOAB", id: "urn:static:libraries:doab", href: "/doab/index.xml", content: "841 book", updated: "2026-11-05T00:00:00Z" },
  { title: "Wikisource (English)", id: "urn:static:libraries:wikisource", href: "https://ws-export.wmcloud.org/opds/en/Ready_for_export.xml", content: "OPDS catalog", updated: "2026-11-05T00:00:00Z" },
];

// The five searchable libraries — same list, order and kinds as
// functions/opds/search.js (Wikisource is browse-only, no index).
const SEARCH_LIBS = [
  { slug: "khazendar", label: "خازندار المكتبة العربية", kind: "drive" },
  { slug: "sahwa", label: "مكتبة صحوه", kind: "drive" },
  { slug: "electronic", label: "المكتبة الإلكترونية", kind: "drive" },
  { slug: "hindawi", label: "مكتبة صفحات - هنداوي", kind: "hindawi" },
  { slug: "doab", label: "DOAB", kind: "doab" },
];

const MAX_PUBLIC_RESULTS = 100; // same cap as the public search
const MAX_PRIVATE_RESULTS = 50; // private matches prepended to search
const MAX_PRIVATE_FEED = 100; // cap for the /private feed
const PUBLIC_UPDATED = "2026-11-05T00:00:00Z"; // same as the public search

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// FNV-1a 32-bit, 8 hex chars — stable id for a private book.
function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function validIso(s) {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const MIME_BY_FORMAT = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  txt: "text/plain",
  kfx: "application/octet-stream",
};

function mimeForFormat(fmt) {
  if (!fmt) return "application/epub+zip";
  return MIME_BY_FORMAT[String(fmt).toLowerCase()] || "application/octet-stream";
}

// Returns { href, type } or null. Today only drive_id produces a link.
// The Block 2 proxy link (https://<proxy>/dl?h=..&p=..&f=..&t=..) needs
// a signed token from the token issuer (not built yet), so it is NOT
// emitted — a tokenless proxy link would 403 and look broken in KOReader.
// When the issuer exists, add a branch here that asks it for a token
// (and make the bot record handle/post/format in priv records).
// NOTE: build the href with a raw "&" and escape it exactly once at emit
// time — do NOT pre-escape "&amp;" here (that is the double-escape bug
// in the public combined search.js).
function acquisitionFor(book) {
  if (book.drive_id) {
    const type = book.m || mimeForFormat(book.format);
    return {
      href: "https://drive.google.com/uc?id=" + book.drive_id + "&export=download",
      type,
    };
  }
  return null;
}

// Verify the fingerprint against the shared KV namespace.
// Returns the Telegram user id (number) or null.
async function verifyFingerprint(env, fp) {
  if (!FP_RE.test(fp)) return null;
  const kv = env && env.RLIBOOK_KV;
  if (!kv) {
    console.warn("[opds] RLIBOOK_KV binding missing — fingerprint treated as unverified");
    return null;
  }
  try {
    const raw = await kv.get("fp:" + fp);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec) return null;
    const tg = Number(rec.tg_id);
    return Number.isFinite(tg) ? tg : null;
  } catch (e) {
    console.warn("[opds] fingerprint lookup failed:", e && e.message);
    return null;
  }
}

// Private-book metadata from KV priv:<tg_id> (array of
// { title, author, source, added_at } — same shape the v4 bot writes).
async function getPrivateBooks(env, tgId) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv) return [];
  try {
    const raw = await kv.get("priv:" + tgId);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn("[opds] private books lookup failed:", e && e.message);
    return [];
  }
}

function privateEntry(book, tgId, now) {
  const title = book.title || "Untitled / بدون عنوان";
  const author = book.author || null;
  const updated = validIso(book.added_at) || now;
  const id = "urn:rlibook:private:" + tgId + ":" + fnv1aHex(title + "\n" + (author || ""));
  const acq = acquisitionFor(book);
  const source = book.source || "—";
  const note = acq
    ? "Source: " + source + ". / المصدر: " + source + "."
    : "Source: " + source + ". Download links for private books come with the direct-download service (Block 2). / المصدر: " + source + ". روابط التحميل هتيجي مع خدمة التحميل المباشر.";
  return (
    "<entry><title>" + esc(title) + "</title><id>" + esc(id) + "</id><updated>" + esc(updated) + "</updated>" +
    (author ? "<author><name>" + esc(author) + "</name></author>" : "") +
    '<category term="🔒 My Private Books"/>' +
    (acq
      ? '<link rel="http://opds-spec.org/acquisition" href="' + esc(acq.href) + '" type="' + esc(acq.type) + '"/>'
      : "") +
    '<content type="text">' + esc(note) + "</content></entry>"
  );
}

function rootFeed(fp, verified, privCount, now) {
  let out =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">' +
    "<title>RliBook — My Catalog</title>" +
    "<id>urn:rlibook:opds:" + esc(fp) + "</id>" +
    "<updated>" + now + "</updated>" +
    '<link rel="self" href="/opds/' + esc(fp) + '/" type="' + NAV_CT + '"/>' +
    '<link rel="search" type="application/opensearchdescription+xml" href="/opds/' + esc(fp) + '/opensearch"/>';
  if (!verified) {
    out +=
      "<entry><title>⚠️ This catalog link is not valid / الرابط ده مش صحيح</title>" +
      "<id>urn:rlibook:opds:" + esc(fp) + ":invalid</id>" +
      "<updated>" + now + "</updated>" +
      "<content type=\"text\">Request a new catalog file from the bot (@RliBook_bot → /kindle). This link was revoked, or it is not a catalog link. / اطلب ملف كتالوج جديد من البوت (@RliBook_bot ← /kindle). الرابط ده اتلغى أو مش رابط كتالوج.</content></entry>";
  }
  for (const lib of LIBRARIES) {
    out +=
      "<entry><title>" + esc(lib.title) + "</title><id>" + esc(lib.id) + "</id><updated>" + lib.updated + "</updated>" +
      '<link rel="subsection" href="' + esc(lib.href) + '" type="' + NAV_CT + '"/>' +
      '<content type="text">' + esc(lib.content) + "</content></entry>";
  }
  if (verified) {
    out +=
      "<entry><title>🔒 My Private Books / كتبي الخاصة</title>" +
      "<id>urn:rlibook:opds:" + esc(fp) + ":private</id>" +
      "<updated>" + now + "</updated>" +
      '<link rel="subsection" href="/opds/' + esc(fp) + '/private" type="' + ACQ_CT + '"/>' +
      "<content type=\"text\">" + privCount + " book" + (privCount === 1 ? "" : "s") + " — only you can see them / " + privCount + " كتاب — بتظهرلك أنت بس</content></entry>";
  }
  out += "</feed>";
  return out;
}

function privateFeed(fp, verified, tgId, books, now) {
  const shown = verified ? books.slice(0, MAX_PRIVATE_FEED) : [];
  const subtitle = verified
    ? shown.length === 0
      ? "No private books yet — add one with /addbook in the bot (answer that you own it). / لسه مفيش كتب خاصة — ضيف واحد من /addbook في البوت (وقول إنك مالكه)."
      : "Your private books — only you can see them. / كتبك الخاصة — بتظهرلك أنت بس."
    : "This catalog link is not valid — request a new catalog file from the bot (@RliBook_bot → /kindle). / الرابط ده مش صحيح — اطلب ملف كتالوج جديد من البوت.";
  let out =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">' +
    "<title>🔒 My Private Books / كتبي الخاصة</title>" +
    "<id>urn:rlibook:opds:" + esc(fp) + ":private</id>" +
    "<updated>" + now + "</updated>" +
    '<link rel="self" href="/opds/' + esc(fp) + '/private" type="' + ACQ_CT + '"/>' +
    "<subtitle>" + esc(subtitle) + "</subtitle>" +
    "<opds:totalResults>" + shown.length + "</opds:totalResults>";
  for (const b of shown) out += privateEntry(b, tgId, now);
  out += "</feed>";
  return out;
}

function opensearchXml(fp) {
  // Same shape as the site's opds-search.xml, with the fingerprinted template.
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">\n' +
    "<ShortName>RliBook — My Catalog search</ShortName>\n" +
    '<Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="/opds/' + esc(fp) + '/search?q={searchTerms}"/>\n' +
    "</OpenSearchDescription>"
  );
}

// Public combined search — same libraries, order, cap (100) and entry
// shape as functions/opds/search.js, but with correct single escaping
// (see the header note) and matching on title OR author.
async function publicSearch(url, q) {
  const needle = q.toLowerCase();
  let entries = "";
  let count = 0;
  for (const lib of SEARCH_LIBS) {
    const indexUrl = new URL("/" + lib.slug + "/search-index.json", url.origin);
    const r = await fetch(indexUrl);
    if (!r.ok) {
      throw new Error("failed to load index for " + lib.slug + " (" + r.status + ")");
    }
    const books = await r.json();
    for (const b of books) {
      if (count >= MAX_PUBLIC_RESULTS) break;
      const hay = ((b.t || "") + " " + (b.a || "")).toLowerCase();
      if (!hay.includes(needle)) continue;
      let href = "";
      if (lib.kind === "drive") href = "https://drive.google.com/uc?id=" + b.i + "&export=download";
      else if (lib.kind === "hindawi") href = "https://www.hindawi.org/books/" + b.i + ".epub";
      else href = b.i; // doab: the direct EPUB URL is stored as the id
      const mime = lib.kind === "drive" ? b.m || "application/epub+zip" : "application/epub+zip";
      const urn = lib.kind === "drive" ? "urn:drive:" + b.i : lib.kind === "hindawi" ? "urn:hindawi:" + b.i : "urn:doab:" + b.i;
      entries +=
        "<entry><title>" + esc(b.t) + "</title><id>" + esc(urn) + "</id><updated>" + PUBLIC_UPDATED + "</updated>" +
        (b.a ? "<author><name>" + esc(b.a) + "</name></author>" : "") +
        '<category term="' + esc(lib.label) + '"/>' +
        '<link rel="http://opds-spec.org/acquisition" href="' + esc(href) + '" type="' + esc(mime) + '"/></entry>';
      count++;
    }
    if (count >= MAX_PUBLIC_RESULTS) break;
  }
  return { entries, count };
}

function privateMatches(books, q) {
  const needle = q.toLowerCase();
  return books
    .filter((b) => ((b.title || "") + " " + (b.author || "")).toLowerCase().includes(needle))
    .slice(0, MAX_PRIVATE_RESULTS);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // context.params.fp is the remaining path segments (an array for the
  // [[fp]] multipath route; a string if the router hands one segment).
  let segs = params && params.fp != null ? params.fp : [];
  if (typeof segs === "string") segs = [segs];
  segs = segs.filter((s) => s !== "");

  if (segs.length === 0) return new Response("Not found", { status: 404 });

  const fp = segs[0];

  // Defensive guard: /opds/search belongs to functions/opds/search.js
  // (specific routes precede catch-alls). If it ever lands here the
  // router misbehaved — never treat "search" as a fingerprint.
  if (fp === "search") return new Response("Not found", { status: 404 });

  const sub = segs[1] || "";
  if (segs.length > 2) return new Response("Not found", { status: 404 });

  const now = new Date().toISOString();

  // Verify the fingerprint once per request (one cheap KV read).
  const tgId = await verifyFingerprint(env, fp);
  const verified = tgId !== null;

  if (sub === "") {
    const privCount = verified ? (await getPrivateBooks(env, tgId)).length : 0;
    return new Response(rootFeed(fp, verified, privCount, now), {
      status: 200,
      headers: { "content-type": NAV_CT },
    });
  }

  if (sub === "private") {
    const books = verified ? await getPrivateBooks(env, tgId) : [];
    return new Response(privateFeed(fp, verified, tgId, books, now), {
      status: 200,
      headers: { "content-type": ACQ_CT },
    });
  }

  if (sub === "opensearch") {
    return new Response(opensearchXml(fp), {
      status: 200,
      headers: { "content-type": OSD_CT },
    });
  }

  if (sub === "search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      // Same empty valid feed as the public search.
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">' +
        "<title>Search</title><id>urn:rlibook:opds:" + esc(fp) + ":search</id><updated>" + now + "</updated>" +
        '<link rel="self" href="/opds/' + esc(fp) + '/search" type="' + ACQ_CT + '"/></feed>';
      return new Response(body, { status: 200, headers: { "content-type": ACQ_CT } });
    }
    try {
      const pub = await publicSearch(url, q);
      let privEntries = "";
      let privCount = 0;
      if (verified) {
        const books = await getPrivateBooks(env, tgId);
        const matches = privateMatches(books, q);
        privCount = matches.length;
        for (const b of matches) privEntries += privateEntry(b, tgId, now);
      }
      const total = pub.count + privCount;
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">' +
        "<title>Search: " + esc(q) + "</title>" +
        "<id>urn:rlibook:opds:" + esc(fp) + ":search:" + esc(q) + "</id>" +
        "<updated>" + now + "</updated>" +
        '<link rel="self" href="/opds/' + esc(fp) + '/search?q=' + esc(q) + '" type="' + ACQ_CT + '"/>' +
        "<opds:totalResults>" + total + "</opds:totalResults>" +
        privEntries +
        pub.entries +
        "</feed>";
      return new Response(body, { status: 200, headers: { "content-type": ACQ_CT } });
    } catch (e) {
      // Same failure policy as the public search: name the failed index,
      // never return partial results.
      return new Response("search failed: " + (e && e.message ? e.message : e), { status: 500 });
    }
  }

  return new Response("Not found", { status: 404 });
}
