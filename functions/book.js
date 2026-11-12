// Cloudflare Pages Function: human-readable HTML book/search page (RliBook).
// Route: GET /book?q=...
//
//   GET /book?q=الصلح
//     -> 200 text/html — the matching books as a plain readable page:
//        title, author, library, format, a "تحميل" link (the acquisition
//        URL from the catalog: Drive download, Hindawi EPUB, or DOAB EPUB)
//        and a search form. No JavaScript, minimal CSS, tiny page —
//        built for the Kindle experimental browser.
//
// Why this exists: the catalog dictionary links to a book page. The old
// link pointed at /opds/search, which returns an Atom XML feed — the
// Kindle browser shows that as raw XML code ("corrupted embed code").
// This page renders the SAME search (same five search-index.json files,
// same substring matching as functions/opds/search.js) as HTML.
//
// Data: the five public OPDS libraries only (khazendar, sahwa,
// electronic, hindawi, doab). Telegram books are NOT in these indexes —
// a Telegram title returns the no-match page with a link to the
// /telegram/ index search. (Telegram search via D1 is a later step;
// see functions/api/tg-search.js.)
//
// Download honesty: the "تحميل" link downloads the ORIGINAL file
// (EPUB/PDF/DOC). A Kindle does not read a downloaded EPUB as a book —
// the direct AZW3 download for Kindle comes with the Block 2 proxy
// (functions/api/dl-token.js). The page says so in one line; it does
// not promise a Kindle-ready download it cannot deliver yet.
//
// Free-tier friendly: same cost profile as /opds/search (five static
// JSON fetches, ~3 MB total, no KV, no D1).

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const head = (title) => "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
    + "h1{font-size:1.4rem;margin-bottom:.2rem}h2{font-size:1.1rem;margin:.6rem 0 .2rem}"
    + "a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;margin:.3rem 0;"
    + "border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;font-weight:600}"
    + ".card{border:1px solid #ccc;border-radius:8px;background:#fff;padding:.8rem 1rem;margin:.8rem 0}"
    + ".note{color:#555;font-size:.9rem}input[type=search]{font-size:1rem;padding:.4rem;width:70%}"
    + "input[type=submit]{font-size:1rem;padding:.4rem .8rem}</style>\n</head>\n<body>\n"
    + "<h1>📚 RliBook</h1>\n"
    + "<form method=\"get\" action=\"/book\">"
    + "<input type=\"search\" name=\"q\" value=\"" + esc(q) + "\" "
    + "placeholder=\"ابحث بالعنوان أو المؤلف…\" aria-label=\"بحث\"> "
    + "<input type=\"submit\" value=\"بحث\"></form>\n";

  const foot = "<p class=\"note\"><a href=\"/\">الرئيسية</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a> · "
    + "<a href=\"https://t.me/RliBook_bot\">البوت @RliBook_bot</a></p>\n"
    + "</body></html>";

  if (!q) {
    const body = head("بحث")
      + "<p>ابحث في المكتبات الخمس: خازندار، صحوه، المكتبة الإلكترونية، "
      + "هنداوي، DOAB.</p>\n"
      + "<p class=\"note\">للبحث في فهرس تيليجرام (323 ألف كتاب)، استخدم "
      + "<a href=\"/telegram/\">صفحة فهرس تيليجرام</a>.</p>\n"
      + foot;
    return new Response(body, {headers: {
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
  const hits = [];
  for (const lib of LIBS) {
    const idxUrl = new URL("/" + lib.slug + "/search-index.json", url.origin);
    const res = await fetch(idxUrl.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) {
      return new Response("search index not found: /" + lib.slug + "/search-index.json",
        {status: 500, headers: {"content-type": "text/plain; charset=utf-8"}});
    }
    const books = await res.json();
    for (const b of books) {
      if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(needle)) {
        let href;
        if (lib.kind === "drive") href = "https://drive.google.com/uc?id=" + b.i + "&export=download";
        else if (lib.kind === "hindawi") href = "https://www.hindawi.org/books/" + b.i + ".epub";
        else href = b.i;
        hits.push({lib, b, href});
        if (hits.length >= 100) break;
      }
    }
    if (hits.length >= 100) break;
  }

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

  let body = head("بحث: " + q);
  if (hits.length === 0) {
    body += "<p>لم نجد «" + esc(q) + "» في المكتبات الخمس.</p>\n"
      + "<p>الكتاب قد يكون في <a href=\"/telegram/\">فهرس تيليجرام</a> "
      + "(323 ألف كتاب) — ابحث عنه هناك بالعنوان أو المؤلف.</p>\n"
      + foot;
    return new Response(body, {headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate"}});
  }

  body += "<p>وجدنا " + hits.length + " نتيجة لـ «" + esc(q) + "»:</p>\n";
  for (const {lib, b, href} of hits) {
    body += "<div class=\"card\"><h2>" + esc(b.t) + "</h2>\n";
    if (b.a) body += "<p>المؤلف: " + esc(b.a) + "</p>\n";
    body += "<p>" + esc(lib.label) + " · " + esc(fmt(b)) + "</p>\n";
    body += "<p><a class=\"btn\" href=\"" + esc(href) + "\">تحميل</a></p>\n";
    body += "</div>\n";
  }
  body += "<p class=\"note\">التنزيل المباشر بصيغة Kindle (AZW3) قريباً — "
    + "حالياً الرابط ينزّل الملف الأصلي (EPUB/PDF).</p>\n" + foot;
  return new Response(body, {headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate"}});
}
