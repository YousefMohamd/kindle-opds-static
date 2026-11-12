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
// Data: the five public OPDS libraries (khazendar, sahwa,
// electronic, hindawi, doab) PLUS the Telegram catalog — unified
// search. Telegram results come from GET /api/tg-search
// (functions/api/tg-search.js), which queries the TG_D1 database
// (D1 + FTS5, 321k books). /book does NOT query D1 itself: the
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
// with one difference in the action: the button opens the source
// t.me post ("📖 المصدر"). There is NO "📧 أرسل إلى كيندلي" button
// on Telegram cards — functions/api/send-to-kindle.js can only fetch
// books from the five OPDS libraries (Drive / Hindawi / DOAB URLs);
// it cannot fetch a Telegram post, and no fetch-from-proxy step
// exists yet. Flagged (commercial) Telegram books show a ⚑ marker
// and NO source link, per the website rule that flagged books are
// flagged but not readable/downloadable on the site — they point at
// the bot instead, which enforces the 3/day cap.
//
// Graceful degradation (never a 500 from the Telegram half): the
// tg-search fetch is wrapped so it can only resolve to
// { available, total, results } — a throw, a non-200 status, a
// { ok: false } body, or malformed results all yield
// available:false + no results, and /book falls back to OPDS-only.
// OPDS failures keep their existing behaviour (500 naming the
// failed index) — unchanged by this work.
//
// Download honesty: the Kindle's built-in browser REFUSES to download
// EPUB/PDF ("Invalid File Type — Only .AZW, .PRC, .MOBI or .TXT"), and
// the dialog's ".AZW" does NOT cover ".azw3" (BicBucStriim #287: *.azw3
// hits the same error, *.mobi downloads). So there is no direct browser
// download for these books. The "📧 أرسل إلى كيندلي" button therefore
// sends the book by Send-to-Kindle email instead
// (functions/api/send-to-kindle.js): EPUB by email IS accepted — Amazon
// converts it to AZW3/KFX on delivery. The old direct-download link
// stays as a secondary link (PC / USB), and the page says so plainly.
//
// Free-tier friendly: same cost profile as /opds/search (five static
// JSON fetches, ~3 MB total, no KV, no D1) + one same-origin
// subrequest to /api/tg-search (1 of the 50/subrequest budget) whose
// reply is ~2 KB. Network wait does not count toward the 10 ms CPU
// limit; /book's own CPU grows by only the ~0.02 ms to parse it.

const TG_LIMIT = 10; // Telegram cards per page (OPDS stays capped at 100)

// Query the Telegram catalog via the /api/tg-search endpoint.
// NEVER throws and NEVER returns a partial/untrusted result: any
// failure — endpoint not deployed yet (404), D1 not bound (503),
// D1 empty, non-JSON or { ok: false } reply — yields
// { available: false, total: 0, results: [] }, and the caller falls
// back to OPDS-only. `available: true` means the endpoint answered
// with ok:true (even with zero results: D1 was searched and is empty
// for this query). Each result is validated: a title and a t.me post
// URL are required, anything else is dropped, so a bad endpoint reply
// can never inject an arbitrary link into the page.
// `origin` is the request origin (same-origin subrequest, like the
// OPDS index fetches below). Exported for tests.
export async function fetchTelegramResults(origin, q, limit = TG_LIMIT) {
  try {
    const tgUrl = new URL("/api/tg-search", origin);
    tgUrl.searchParams.set("q", q);
    tgUrl.searchParams.set("limit", String(limit));
    const res = await fetch(tgUrl.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) return {available: false, total: 0, results: []};
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.results)) {
      return {available: false, total: 0, results: []};
    }
    const results = [];
    for (const r of data.results) {
      if (!r || typeof r.title !== "string" || !r.title) continue;
      if (typeof r.url !== "string" || !/^https:\/\/t\.me\//.test(r.url)) continue;
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
      });
    }
    return {
      available: true,
      total: Number.isFinite(data.total) ? data.total : results.length,
      results,
    };
  } catch (e) {
    console.warn("[book] telegram search unavailable:", e && e.message);
    return {available: false, total: 0, results: []};
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
  // Start the Telegram search NOW so it runs in parallel with the
  // OPDS loop below (wall-clock overlap; network wait is not CPU).
  // The promise is made non-rejecting here, so even if the OPDS loop
  // returns early (500 on a missing index) there is no unhandled
  // rejection from the Telegram half.
  const tgPromise = fetchTelegramResults(url.origin, q)
    .catch(() => ({available: false, total: 0, results: []}));
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

  // Telegram half: resolves to { available, total, results } — never
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
      body += "<p>لم نجد «" + esc(q) + "» في كل المكتبات (الخمس + تيليجرام).</p>\n"
        + "<p>جرّب كلمة أخرى من العنوان أو اسم المؤلف.</p>\n"
        + foot;
    } else {
      // Telegram was NOT searched (endpoint/D1 not live yet) — the
      // exact page /book rendered before unified search, unchanged.
      body += "<p>لم نجد «" + esc(q) + "» في المكتبات الخمس.</p>\n"
        + "<p>الكتاب قد يكون في <a href=\"/telegram/\">فهرس تيليجرام</a> "
        + "(323 ألف كتاب) — ابحث عنه هناك بالعنوان أو المؤلف.</p>\n"
        + foot;
    }
    return new Response(body, {headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate"}});
  }

  const shown = hits.length + tg.results.length;
  body += "<p>وجدنا " + shown + " نتيجة لـ «" + esc(q) + "»:</p>\n";
  for (const {lib, b, href} of hits) {
    const sendUrl = "/api/send-to-kindle?lib=" + lib.slug
      + "&amp;id=" + encodeURIComponent(b.i)
      + "&amp;f=" + fmtCode(b)
      + "&amp;t=" + encodeURIComponent(b.t || "") + fpQ;
    body += "<div class=\"card\"><h2>" + esc(b.t) + "</h2>\n";
    if (b.a) body += "<p>المؤلف: " + esc(b.a) + "</p>\n";
    body += "<p>" + esc(lib.label) + " · " + esc(fmt(b)) + "</p>\n";
    body += "<p><a class=\"btn\" href=\"" + sendUrl + "\">📧 أرسل إلى كيندلي</a></p>\n";
    body += "<p class=\"note\"><a href=\"" + esc(href) + "\">تنزيل مباشر</a> "
      + "(من متصفح عادي أو USB — متصفح الكيندل يرفض EPUB/PDF)</p>\n";
    body += "</div>\n";
  }

  // ---- Telegram results: same card layout, different action --------
  // No "📧 أرسل إلى كيندلي" button here — send-to-kindle can only
  // fetch OPDS-library books (see header). The action is the source
  // t.me post. Flagged (commercial) books get no source link, per the
  // website rule (flagged = shown, not readable/downloadable here);
  // they point at the bot, which enforces the 3/day cap.
  if (tg.results.length > 0) {
    body += "<h2>من تيليجرام"
      + (tg.total > tg.results.length
        ? " (" + tg.results.length + " من " + tg.total + ")"
        : "")
      + "</h2>\n";
    for (const r of tg.results) {
      body += "<div class=\"card\"><h2>" + esc(r.title) + "</h2>\n";
      if (r.author) body += "<p>المؤلف: " + esc(r.author) + "</p>\n";
      body += "<p>تيليجرام · " + esc(r.source || (r.kind === "group" ? "مجموعة" : "قناة"))
        + (r.formats.length ? " · " + esc(r.formats.join("، ")) : "")
        + (r.flagged ? " · ⚑ تجاري" : "")
        + "</p>\n";
      if (r.flagged) {
        body += "<p class=\"note\">⚑ كتاب تجاري — اطلبه من البوت "
          + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a> "
          + "(يخضع لحدّ الكتب التجارية).</p>\n";
      } else {
        body += "<p><a class=\"btn\" href=\"" + esc(r.url) + "\">📖 المصدر (تيليجرام)</a></p>\n";
      }
      body += "</div>\n";
    }
    body += "<p class=\"note\">كتب تيليجرام تُؤخذ من المصدر مباشرة — "
      + "الإرسال إلى كيندلي بالبريد لهذه الكتب غير متاح بعد "
      + "(يحتاج جلب الملف من تيليجرام أولاً).</p>\n";
  }

  // Footer notes, only for the halves actually shown: the send-to-
  // Kindle note only when an OPDS card (with a send button) is on
  // the page — a Telegram-only page must not promise a send button.
  if (hits.length > 0) {
    body += "<p class=\"note\">متصفح الكيندل لا ينزّل EPUB/PDF — زر «أرسل إلى كيندلي» يرسل الكتاب "
      + "إلى ميل الكيندل الخاص بك، فيظهر في مكتبتك خلال دقائق. "
      + (fp
        ? "ميلك محفوظ في البوت — لن يُطلب منك كتابته."
        : "سيُطلب منك كتابة ميل الكيندل مرة واحدة لكل كتاب — أو أرسله للبوت "
          + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a> ليُحفظ.")
      + "</p>\n";
  }
  body += foot;
  return new Response(body, {headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate"}});
}
