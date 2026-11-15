// Cloudflare Pages Function: human-readable HTML book/search page (RliBook).
// Route: GET /book?q=...
//
//   GET /book?q=الصلح
//     -> 200 text/html — the matching books as a plain readable page:
//        title, author, library, format, a "أرسل إلى جهازي" send
//        button (Send-to-Kindle email — the ONLY download path; there
//        is NO direct-download link: the Kindle browser cannot
//        download EPUB/PDF) and a search form. No JavaScript, minimal
//        CSS, tiny page —
//        built for the Kindle experimental browser.
//
// Why this exists: the catalog dictionary links to a book page. The old
// link pointed at /opds/search, which returns an Atom XML feed — the
// Kindle browser shows that as raw XML code ("corrupted embed code").
// This page renders the SAME search (same five search-index.json files,
// same substring matching as functions/opds/search.js) as HTML.
//
// Data: the five public OPDS libraries (khazendar, sahwa,
// electronic, hindawi, doab) PLUS the Telegram catalog — unified
// search. Telegram results come from GET /api/tg-search
// (functions/api/tg-search.js), which queries the TG_D1 database
// (D1 + FTS5; the D1 snapshot is still being imported — see the
// `coverage` field on /api/tg-search for the live indexed count).
// endpoint owns all Telegram search logic (Arabic normalization,
// FTS5 AND + longest-word fallback, flagged check), so there is one
// implementation of it and /book stays a thin renderer. /book sends
// one same-origin subrequest to /api/tg-search and parses only the
// ~2 KB JSON reply (~0.02 ms CPU locally — three orders of magnitude
// below parsing a Telegram shard, ~129 ms for 19.9 MB).
//
// Activation: this file can deploy BEFORE D1 exists. Until
// /api/tg-search is deployed and TG_D1 is populated, the subrequest
// fails (404/503) and /book silently renders exactly what it renders
// today (OPDS-only, including the no-match page with the /telegram/
// link). The moment tg-search is live and D1 has books, Telegram
// cards appear with no further change to this file.
//
// Telegram cards are NORMAL cards (title, author, source, format)
// with the SAME "أرسل إلى جهازي" send button as OPDS cards —
// the button sends the book by email via functions/api/send-to-
// kindle.js (lib=tg), which fetches the file from the Block 2 proxy
// first. The source (library/channel name) is plain TEXT under the
// book info, never the button label and never a t.me link: tapping
// a source link opened the Telegram website, which is not a download.
// Flagged (commercial) Telegram books show a "تجاري" marker and NO send
// button and NO reading on the website, per the website rule that
// flagged books are flagged but not readable/downloadable on the
// site — they point at the bot instead, which enforces the 3/day cap.
//
// Enrichment (Blocks 4 + 9): Telegram cards also show, when available,
// an embedded cover (Block 4 pairing — a data:image/* URI stored with
// the book metadata, never a hotlink; no cover -> no <img> at all),
// a rating X/10 with its source (Block 9, via /api/ratings — Google
// Books first, Open Library fallback; no rating -> nothing, never a
// fake 0), and a short description with its source (Telegram post text
// first, Google Books second). OPDS cards are NOT enriched (up to 100
// cards x external fetches would blow the subrequest budget and slow
// the Kindle page). Every enrichment call degrades to "not shown".
//
// Graceful degradation (never a 500 from the Telegram half): the
// tg-search fetch is wrapped so it can only resolve to
// { available, total, coverage, results } — a throw, a non-200 status, a
// { ok: false } body, or malformed results all yield
// available:false + no results, and /book falls back to OPDS-only.
// OPDS failures return a 500 HTML page naming the failed index, with
// links to /telegram/ and the home page — never a bare error line
// and never partial results presented as complete.
//
// Download honesty: the Kindle's built-in browser REFUSES to download
// EPUB/PDF ("Invalid File Type — Only .AZW, .PRC, .MOBI or .TXT"), and
// the dialog's ".AZW" does NOT cover ".azw3" (BicBucStriim #287: *.azw3
// hits the same error, *.mobi downloads). So there is no direct browser
// download for these books, and the page renders NO direct-download
// link at all (removed 2026-11-13: device test showed tapping it
// failed with a white page + error codes 175/101). The "أرسل إلى
// جهازي" button therefore sends the book by Send-to-Kindle email
// instead (functions/api/send-to-kindle.js): EPUB by email IS accepted
// — Amazon converts it to AZW3/KFX on delivery. Email send is the
// ONLY download path on this page.
//
// Free-tier friendly: same cost profile as /opds/search (five static
// JSON fetches, ~3 MB total, no KV, no D1) + one same-origin
// subrequest to /api/tg-search (1 of the 50/subrequest budget) whose
// reply is ~2 KB. Network wait does not count toward the 10 ms CPU
// limit; /book's own CPU grows by only the ~0.02 ms to parse it.

const TG_LIMIT = 10; // Telegram cards per page (OPDS stays capped at 100)
const MAX_Q_LEN = 200; // A title/author query longer than this is a 400 page, not a search

// Query the Telegram catalog via the /api/tg-search endpoint.
// NEVER throws and NEVER returns a partial/untrusted result: any
// failure — endpoint not deployed yet (404), D1 not bound (503),
// D1 empty, non-JSON or { ok: false } reply — yields
// { available: false, total: 0, coverage: null, results: [] }, and the
// caller falls back to OPDS-only. `available: true` means the endpoint
// answered with ok:true (even with zero results: D1 was searched and
// is empty for this query). `coverage` is the endpoint's coverage
// object ({ indexed, target, partial }) passed through validated —
// null when the endpoint did not send one — so the caller can say
// honestly that D1 is still a partial snapshot (import finishes
// 2026-11-19) instead of guessing. Each result is validated: a title
// and a t.me post URL are required, anything else is dropped, so a
// bad endpoint reply can never inject an arbitrary link into the page.
// `origin` is the request origin (same-origin subrequest, like the
// OPDS index fetches below). Exported for tests.
export async function fetchTelegramResults(origin, q, limit = TG_LIMIT) {
  try {
    const tgUrl = new URL("/api/tg-search", origin);
    tgUrl.searchParams.set("q", q);
    tgUrl.searchParams.set("limit", String(limit));
    const res = await fetch(tgUrl.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) return {available: false, total: 0, coverage: null, results: []};
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.results)) {
      return {available: false, total: 0, coverage: null, results: []};
    }
    const results = [];
    for (const r of data.results) {
      if (!r || typeof r.title !== "string" || !r.title) continue;
      if (typeof r.url !== "string" || !/^https:\/\/t\.me\//.test(r.url)) continue;
      // Cover (Block 4 pairing): EMBEDDED only — a data:image/* URI
      // stored with the book metadata, small enough for the Kindle
      // browser (<= 150 KB). Anything else (a hotlink, an oversized
      // blob, a non-image) is dropped: no evidence = no cover, and a
      // wrong/huge cover is worse than no cover.
      let cover = "";
      if (typeof r.cover === "string"
        && /^data:image\/(jpeg|png|webp|gif);base64,/.test(r.cover)
        && r.cover.length <= 150000) {
        cover = r.cover;
      }
      // Description from the Telegram post text (first source for the
      // description; Google Books is second, via /api/ratings).
      const description = typeof r.description === "string"
        ? r.description.slice(0, 2000)
        : "";
      results.push({
        title: r.title,
        author: typeof r.author === "string" ? r.author : "",
        source: typeof r.source === "string" ? r.source : "",
        kind: r.kind === "group" ? "group" : "channel",
        formats: Array.isArray(r.formats)
          ? r.formats.filter((f) => typeof f === "string")
          : [],
        url: r.url,
        flagged: r.flagged === true,
        cover,
        description,
      });
    }
    return {
      available: true,
      total: Number.isFinite(data.total) ? data.total : results.length,
      coverage: data.coverage && typeof data.coverage === "object"
        ? {
            indexed: Number.isFinite(data.coverage.indexed)
              ? data.coverage.indexed : null,
            target: Number.isFinite(data.coverage.target)
              ? data.coverage.target : null,
            partial: data.coverage.partial === true,
          }
        : null,
      results,
    };
  } catch (e) {
    console.warn("[book] telegram search unavailable:", e && e.message);
    return {available: false, total: 0, coverage: null, results: []};
  }
}

// Parse a t.me post URL into { handle, postId } for the Telegram send
// path (/api/send-to-kindle?lib=tg&h=..&p=..). Same shape as
// functions/api/tg-search.js parsePostUrl. Private-group links
// (https://t.me/c/<id>/<post>) return null: "c" is not a public handle
// and the proxy cannot fetch from it. Exported for tests.
export function parseTelegramPostUrl(url) {
  const m = /^https?:\/\/t\.me\/([^/?#]+)\/(\d+)/.exec(url || "");
  if (!m || m[1] === "c") return null;
  return { handle: m[1].toLowerCase(), postId: Number(m[2]) };
}

// Formats the email endpoint accepts (Send-to-Kindle's list). A Telegram
// book in any other format (MOBI/AZW3/KFX) gets no send button — the
// endpoint would refuse it anyway — and a note pointing at the bot.
export const TG_SENDABLE_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);

/** The send URL for one Telegram result, or null when it cannot be
 *  sent from the website (private-group link, no usable format, or a
 *  non-sendable format). `fpQ` is the "&amp;fp=..." suffix ("" when
 *  no fingerprint). Exported for tests. */
export function telegramSendUrl(r, fpQ = "") {
  if (!r || r.flagged) return null;
  const post = parseTelegramPostUrl(r.url);
  if (!post) return null;
  const fmt = Array.isArray(r.formats) && r.formats.length
    ? String(r.formats[0]).toLowerCase()
    : "";
  if (!TG_SENDABLE_FORMATS.has(fmt)) return null;
  return "/api/send-to-kindle?lib=tg"
    + "&amp;h=" + encodeURIComponent(post.handle)
    + "&amp;p=" + post.postId
    + "&amp;f=" + fmt
    + "&amp;t=" + encodeURIComponent(r.title || "") + fpQ;
}

/** The reader URL for one Telegram result, or null when it cannot be
 *  read online (flagged, private-group link, or no EPUB format — the
 *  reader opens EPUB only, per site/reader/README.md). The reader
 *  fetches the book via /api/dl-token, so flagged books never reach
 *  it (the token endpoint returns 403). Exported for tests. */
export function telegramReaderUrl(r) {
  if (!r || r.flagged) return null;
  const post = parseTelegramPostUrl(r.url);
  if (!post) return null;
  const hasEpub = Array.isArray(r.formats)
    && r.formats.some((f) => String(f).toLowerCase().includes("epub"));
  if (!hasEpub) return null;
  return "/site/reader/?lib=tg"
    + "&amp;h=" + encodeURIComponent(post.handle)
    + "&amp;p=" + post.postId
    + "&amp;f=epub"
    + "&amp;title=" + encodeURIComponent(r.title || "");
}

// Rating + description for one book, via the same-origin
// /api/ratings endpoint (functions/api/ratings.js: Google Books first,
// Open Library as fallback). NEVER throws and NEVER returns a rating
// the endpoint did not confidently match: any failure — endpoint not
// deployed yet, upstream down, no match — yields
// { rating: null, description: null }, and the card simply shows no
// rating (never a fake 0). Exported for tests.
export async function fetchEnrichment(origin, title, author = "") {
  try {
    const u = new URL("/api/ratings", origin);
    u.searchParams.set("title", title || "");
    if (author) u.searchParams.set("author", author);
    const res = await fetch(u.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) return {rating: null, description: null};
    const data = await res.json();
    if (!data || data.ok !== true) return {rating: null, description: null};
    const rating = data.rating
      && Number.isFinite(Number(data.rating.value))
      && data.rating.value > 0 && data.rating.value <= 10
      && typeof data.rating.source === "string" && data.rating.source
      ? {
          value: Number(data.rating.value),
          count: Number(data.rating.count) || 0,
          source: data.rating.source,
        }
      : null;
    const description = data.description
      && typeof data.description.text === "string" && data.description.text
      && typeof data.description.source === "string" && data.description.source
      ? {text: data.description.text.slice(0, 2000), source: data.description.source}
      : null;
    return {rating, description};
  } catch (e) {
    console.warn("[book] ratings unavailable:", e && e.message);
    return {rating: null, description: null};
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") || "").trim();
  // Fingerprint from the user's personal catalog file (?fp=), when the
  // book page was opened from a catalog that carries it. The dictionary
  // files already sent link WITHOUT fp — then the page shows the email
  // form instead (see functions/api/send-to-kindle.js).
  const fp = (url.searchParams.get("fp") || "").trim();
  const fpQ = fp ? "&amp;fp=" + encodeURIComponent(fp) : "";
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const fpHidden = fp
    ? "<input type=\"hidden\" name=\"fp\" value=\"" + esc(fp) + "\"> "
    : "";

  const head = (title, qVal = q) => "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1C2826;background:#DFF1F4}"
    + "h1{font-size:1.4rem;margin-bottom:.2rem}h2{font-size:1.1rem;margin:.6rem 0 .2rem}"
    + "a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;margin:.3rem 0;"
    + "border-radius:6px;background:#44667b;color:#fff;text-decoration:none;font-weight:600}"
    + ".card{border:1px solid #C4E0EB;border-radius:8px;background:#fff;padding:.8rem 1rem;margin:.8rem 0}"
    + ".cover{max-width:120px;height:auto;border-radius:6px;border:1px solid #C4E0EB}"
    + ".rating{font-weight:600}.desc{font-size:.95rem}"
    + ".src{color:#555;font-size:.85rem}"
    + ".note{color:#555;font-size:.9rem}input[type=search]{font-size:1rem;padding:.4rem;width:70%}"
    + "input[type=submit]{font-size:1rem;padding:.4rem .8rem}</style>\n</head>\n<body>\n"
    + "<h1>RliBook</h1>\n"
    + "<form method=\"get\" action=\"/book\">"
    + "<input type=\"search\" name=\"q\" value=\"" + esc(qVal) + "\" "
    + "placeholder=\"ابحث بالعنوان أو المؤلف…\" aria-label=\"بحث\"> "
    + fpHidden
    + "<input type=\"submit\" value=\"بحث\"></form>\n";

  const foot = "<p class=\"note\"><a href=\"/\">الرئيسية</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a> · "
    + "<a href=\"https://t.me/RliBook_bot\">البوت @RliBook_bot</a></p>\n"
    + "</body></html>";

  if (!q) {
    const body = head("بحث")
      + "<p>ابحث في المكتبات الخمس: خازندار، صحوه، المكتبة الإلكترونية، "
      + "هنداوي، DOAB.</p>\n"
      + "<p class=\"note\">للبحث في فهرس تيليجرام، استخدم "
      + "<a href=\"/telegram/\">صفحة فهرس تيليجرام</a>.</p>\n"
      + foot;
    return new Response(body, {headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate"}});
  }

  if (q.length > MAX_Q_LEN) {
    const body = head("بحث", q.slice(0, MAX_Q_LEN))
      + "<p>كلمة البحث طويلة جداً — جرّب كلمة أقصر من العنوان أو اسم المؤلف.</p>\n"
      + foot;
    return new Response(body, {status: 400, headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate"}});
  }

  const LIBS = [
    {slug: "khazendar", label: "خازندار", kind: "drive"},
    {slug: "sahwa", label: "مكتبة صحوه", kind: "drive"},
    {slug: "electronic", label: "المكتبة الإلكترونية", kind: "drive"},
    {slug: "hindawi", label: "هنداوي", kind: "hindawi"},
    {slug: "doab", label: "DOAB", kind: "doab"},
  ];
  const needle = q.toLowerCase();
  // Start the Telegram search NOW so it runs in parallel with the
  // OPDS loop below (wall-clock overlap; network wait is not CPU).
  // The promise is made non-rejecting here, so even if the OPDS loop
  // returns early (500 on a missing index) there is no unhandled
  // rejection from the Telegram half.
  const tgPromise = fetchTelegramResults(url.origin, q)
    .catch(() => ({available: false, total: 0, coverage: null, results: []}));
  // An OPDS index that cannot be read (missing file, bad JSON) is a
  // 500 — but a 500 the user can act on: a full page naming the
  // library, with links to the Telegram index and home, never a bare
  // error line and never partial results presented as complete.
  const opdsFail = (lib) => {
    const body = head("خطأ")
      + "<p>تعذّر تحميل فهرس مكتبة " + esc(lib.label)
      + " الآن — حاول مجدداً بعد دقيقة.</p>\n"
      + "<p>إلى ذلك الحين: ابحث في <a href=\"/telegram/\">فهرس تيليجرام</a>"
      + " أو عُد إلى <a href=\"/\">الرئيسية</a>.</p>\n"
      + foot;
    return new Response(body, {status: 500, headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate"}});
  };
  const hits = [];
  for (const lib of LIBS) {
    let books;
    try {
      const idxUrl = new URL("/" + lib.slug + "/search-index.json", url.origin);
      const res = await fetch(idxUrl.toString(), {headers: {"accept": "application/json"}});
      if (!res.ok) return opdsFail(lib);
      books = await res.json();
      if (!Array.isArray(books)) return opdsFail(lib);
    } catch (e) {
      return opdsFail(lib);
    }
    for (const b of books) {
      if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(needle)) {
        hits.push({lib, b});
        if (hits.length >= 100) break;
      }
    }
    if (hits.length >= 100) break;
  }

  // Telegram half: resolves to { available, total, coverage, results } — never
  // throws, never 500s the page. available:false means "not searched"
  // (endpoint/D1 not live yet); available:true + 0 results means
  // "searched, nothing found".
  const tg = await tgPromise;

  const fmt = (b) => {
    const m = (b.m || b.f || "").toLowerCase();
    if (m.includes("pdf")) return "PDF";
    if (m.includes("epub")) return "EPUB";
    if (m.includes("msword") || m.includes("wordprocessingml")) return "DOC";
    if (m.includes("mobi") || m.includes("x-mobipocket")) return "MOBI";
    if (m.includes("text/plain")) return "TXT";
    if (m.includes("azw")) return "AZW3";
    return (b.f || b.m || "").toUpperCase();
  };

  // Raw format code for the send-to-kindle endpoint (sendable: epub/pdf/
  // doc/docx/txt — the endpoint refuses mobi/azw3, which Send-to-Kindle
  // no longer accepts by email).
  const fmtCode = (b) => {
    const m = (b.m || b.f || "").toLowerCase();
    if (m.includes("pdf")) return "pdf";
    if (m.includes("epub")) return "epub";
    if (m.includes("wordprocessingml")) return "docx";
    if (m.includes("msword")) return "doc";
    if (m.includes("mobi") || m.includes("x-mobipocket")) return "mobi";
    if (m.includes("text/plain")) return "txt";
    if (m.includes("azw")) return "azw3";
    return (b.f || "epub").toLowerCase();
  };

  let body = head("بحث: " + q);
  if (hits.length === 0 && tg.results.length === 0) {
    if (tg.available) {
      // Telegram WAS searched (endpoint + D1 live) and found nothing
      // either — say so, instead of sending the user to the index.
      // While the D1 import is still running (finishes Thu 2026-11-19)
      // a missing book may only be missing from D1 so far: say so,
      // but only when the endpoint reports D1 as still partial — the
      // note disappears on its own once the import finishes.
      body += "<p>لم نجد «" + esc(q) + "» في كل المكتبات (الخمس + تيليجرام).</p>\n"
        + "<p>جرّب كلمة أخرى من العنوان أو اسم المؤلف.</p>\n";
      if (tg.coverage && tg.coverage.partial) {
        body += "<p class=\"note\">ملاحظة: فهرس تيليجرام ما زال يُستورَد — "
          + "يكتمل الخميس 19 نوفمبر 2026، فالكتاب قد يظهر لاحقًا.</p>\n";
      }
      body += foot;
    } else {
      // Telegram was NOT searched (endpoint/D1 not live yet) — the
      // exact page /book rendered before unified search, unchanged,
      // except the hardcoded Telegram count is dropped (the count is
      // shown on the homepage/stats). No partial-import note here:
      // this branch points at the static /telegram/ index (the full
      // manifest), not the partial D1 search.
      body += "<p>لم نجد «" + esc(q) + "» في المكتبات الخمس.</p>\n"
        + "<p>الكتاب قد يكون في <a href=\"/telegram/\">فهرس تيليجرام</a> "
        + "— ابحث عنه هناك بالعنوان أو المؤلف.</p>\n"
        + foot;
    }
    return new Response(body, {headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate"}});
  }

  const shown = hits.length + tg.results.length;
  body += "<p>وجدنا " + shown + " نتيجة لـ «" + esc(q) + "»:</p>\n";
  for (const {lib, b} of hits) {
    // Send by email only works for the formats Send-to-Kindle accepts
    // (epub/pdf/doc/docx/txt). A MOBI/AZW3 book gets NO send button —
    // the endpoint would refuse it — and a note pointing at the bot
    // instead, so the page never shows a button that is certain to fail.
    // (No MOBI/AZW3 book is in the five indexes today, 2026-11-14, so
    // this is defensive: a future catalog rebuild may add one.)
    const sendable = TG_SENDABLE_FORMATS.has(fmtCode(b));
    const sendUrl = sendable
      ? "/api/send-to-kindle?lib=" + lib.slug
        + "&amp;id=" + encodeURIComponent(b.i)
        + "&amp;f=" + fmtCode(b)
        + "&amp;t=" + encodeURIComponent(b.t || "") + fpQ
      : null;
    // "Read online" (Block 11b reader): EPUB only — the reader opens
    // EPUB books, so a PDF/DOC/MOBI book gets no button (its honest
    // page lives in the reader itself). Same URL contract as
    // site/reader/README.md (buildReaderUrl): lib + id + title + author.
    const readerUrl = fmtCode(b) === "epub"
      ? "/site/reader/?lib=" + lib.slug
        + "&amp;id=" + encodeURIComponent(b.i)
        + "&amp;title=" + encodeURIComponent(b.t || "")
        + (b.a ? "&amp;author=" + encodeURIComponent(b.a) : "")
      : null;
    body += "<div class=\"card\"><h2>" + esc(b.t) + "</h2>\n";
    if (b.a) body += "<p>المؤلف: " + esc(b.a) + "</p>\n";
    body += "<p>" + esc(lib.label) + " · " + esc(fmt(b)) + "</p>\n";
    if (readerUrl) body += "<p><a class=\"btn\" href=\"" + readerUrl + "\">📖 اقرأ أونلاين</a></p>\n";
    if (sendUrl) {
      body += "<p><a class=\"btn\" href=\"" + sendUrl + "\">أرسل إلى جهازي</a></p>\n";
    } else {
      body += "<p class=\"note\">لا يمكن إرسال هذا الكتاب من الموقع — "
        + "اطلبه من البوت "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n";
    }
    body += "</div>\n";
  }

  // ---- Telegram results: same card layout, same SEND button --------
  // The button is the send action (via the proxy fetch in
  // functions/api/send-to-kindle.js, lib=tg); the source is plain
  // TEXT under the book info, never the button label and never a
  // t.me link — tapping a source link opened the Telegram website,
  // which is not a download. Flagged (commercial) books get NO send
  // button and NO reading on the website, per the website rule
  // (flagged = shown with a "تجاري" marker, reachable via the bot, which
  // enforces the 3/day cap); a book that cannot be sent (private
  // group, no usable format, MOBI/AZW3/KFX) gets a note instead.
  if (tg.results.length > 0) {
    body += "<h2>من تيليجرام"
      + (tg.total > tg.results.length
        ? " (" + tg.results.length + " من " + tg.total + ")"
        : "")
      + "</h2>\n";
    // Partial-import note (same gate as the no-match page): while D1
    // is still a partial snapshot the Telegram results on this page
    // are incomplete — more matches may appear once the import
    // finishes (Thu 2026-11-19). Shown only while coverage.partial
    // is true, so it disappears on its own when the import finishes.
    if (tg.coverage && tg.coverage.partial) {
      body += "<p class=\"note\">ملاحظة: فهرس تيليجرام ما زال يُستورَد — "
        + "يكتمل الخميس 19 نوفمبر 2026، فقد تكون هناك نتائج أخرى لم تظهر بعد.</p>\n";
    }
    // Enrichment (Block 9): one /api/ratings subrequest per Telegram
    // card, in parallel (max TG_LIMIT = 10 — inside the 50-subrequest
    // budget). Each call never throws and returns nulls on any failure,
    // so a missing/unreachable ratings endpoint only means "no rating
    // shown". OPDS cards are NOT enriched: up to 100 cards x external
    // fetches would blow the budget and slow the Kindle page.
    const enrichments = await Promise.all(
      tg.results.map((r) => fetchEnrichment(url.origin, r.title, r.author)),
    );
    for (let i = 0; i < tg.results.length; i++) {
      const r = tg.results[i];
      const enr = enrichments[i] || {rating: null, description: null};
      body += "<div class=\"card\"><h2>" + esc(r.title) + "</h2>\n";
      // Cover (Block 4 pairing): shown ONLY when the pairing supplied
      // an embedded cover. No cover -> no <img> at all, never a
      // placeholder image (a wrong cover is worse than no cover).
      if (r.cover) {
        body += "<p><img class=\"cover\" src=\"" + esc(r.cover)
          + "\" alt=\"غلاف: " + esc(r.title) + "\" width=\"120\"></p>\n";
      }
      if (r.author) body += "<p>المؤلف: " + esc(r.author) + "</p>\n";
      // Rating: shown ONLY when the endpoint confidently matched the
      // book. No rating -> NOTHING here (never a fake "0/10": a missing
      // rating must not look like a bad rating).
      if (enr.rating) {
        body += "<p class=\"rating\">⭐ " + esc(String(enr.rating.value)) + "/10"
          + (enr.rating.count
            ? " · " + esc(String(enr.rating.count)) + " تقييمًا" : "")
          + " <span class=\"src\">— التقييم من " + esc(enr.rating.source)
          + "</span></p>\n";
      }
      // Description: Telegram post text first, Google Books second.
      // Short (a few lines) and always with its source.
      const postDesc = (r.description || "").replace(/\s+/g, " ").trim();
      const desc = postDesc
        ? {text: postDesc.slice(0, 400), source: "منشور تيليجرام"}
        : enr.description;
      if (desc && desc.text) {
        body += "<p class=\"desc\">" + esc(desc.text)
          + " <span class=\"src\">(الوصف من " + esc(desc.source) + ")</span></p>\n";
      }
      body += "<p>تيليجرام"
        + (r.formats.length ? " · " + esc(r.formats.join("، ")) : "")
        + (r.flagged ? " · تجاري" : "")
        + "</p>\n";
      body += "<p>المصدر: " + esc(r.source || (r.kind === "group" ? "مجموعة" : "قناة")) + "</p>\n";
      if (r.flagged) {
        body += "<p class=\"note\">هذا الكتاب تجاري (عليه علامة) — الموقع لا يتيح تحميله أو إرساله. "
          + "للوصول إليه، اطلبه من قناة النشر عبر بوت تليجرام "
          + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n";
      } else {
        // "Read online" (Block 11b reader): EPUB only, never flagged.
        // Same URL contract as site/reader/README.md.
        const readerUrl = telegramReaderUrl(r);
        if (readerUrl) body += "<p><a class=\"btn\" href=\"" + readerUrl + "\">📖 اقرأ أونلاين</a></p>\n";
        const sendUrl = telegramSendUrl(r, fpQ);
        if (sendUrl) {
          body += "<p><a class=\"btn\" href=\"" + sendUrl + "\">أرسل إلى جهازي</a></p>\n";
        } else {
          body += "<p class=\"note\">لا يمكن إرسال هذا الكتاب من الموقع — "
            + "اطلبه من البوت "
            + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n";
        }
      }
      body += "</div>\n";
    }
    body += "<p class=\"note\">زر «أرسل إلى جهازي» على كتب تيليجرام يجلب الملف "
      + "من تيليجرام ثم يرسله إلى بريد جهازك.</p>\n";
  }

  // Footer note whenever ANY send button is on the page (OPDS cards,
  // or a sendable non-flagged Telegram card) — a page with no send
  // button must not promise one.
  const anySend = hits.some(({b}) => TG_SENDABLE_FORMATS.has(fmtCode(b)))
    || tg.results.some((r) => telegramSendUrl(r, fpQ) !== null);
  if (anySend) {
    body += "<p class=\"note\">متصفح جهازك لا ينزّل EPUB/PDF — زر «أرسل إلى جهازي» يرسل الكتاب "
      + "إلى بريد جهازك، فيظهر في مكتبتك خلال دقائق. "
      + (fp
        ? "ميلك محفوظ في البوت — لن يُطلب منك كتابته."
        : "سيُطلب منك كتابة بريد جهازك مرة واحدة لكل كتاب — أو أرسله للبوت "
          + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a> ليُحفظ.")
      + "</p>\n";
  }
  body += foot;
  return new Response(body, {headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate"}});
}
