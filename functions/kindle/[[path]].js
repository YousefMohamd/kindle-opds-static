// Cloudflare Pages Function: /kindle/* proxy to the RliBook bot Worker,
// PLUS the local Kindle entry page at the bare /kindle and /kindle/
// paths (kindleEntryPage — Kindle layout when the UA contains an
// e-reader substring, standard layout + note otherwise; never a
// block page). Route: GET /kindle/* (functions/kindle/[[path]].js —
// catch-all under /kindle/, so /kindle, /kindle/, /kindle/menu,
// /kindle/search… all land here).
//
// Why a proxy: the catalog EPUB's menu links (Search / Libraries /
// Latest / My Private Books) open the "Kindle-mode" pages, which are
// Worker routes served from the bot's own origin
// (https://rlibook-bot.mohamedyou1357.workers.dev/kindle/…). The
// dictionary file opens rlibook.tech — so the user saw TWO different
// websites. The /kindle/ pages now live on rlibook.tech too, through
// this proxy, and the bot (v4.8.42) builds the catalog's menu links
// against the site instead of the Worker origin.
//
// How it works: the request path + query are forwarded verbatim to
// the Worker (the fp/q params ride along), with one extra header —
// `x-rlibook-origin: https://rlibook.tech` — so the Worker generates
// rlibook.tech links in the HTML instead of workers.dev links (the
// Worker accepts that header ONLY when it is exactly the site
// origin; the fp is still verified against KV for private books, so
// the header grants nothing). The Worker's response (status + body +
// content-type) is passed through, except that absolute Worker
// /kindle/ links inside HTML responses are rewritten to rlibook.tech
// (see rewriteKindleLinks — the Worker does not honor the header yet,
// verified live 2026-11-14, so the rewrite is what actually keeps the
// user on one website).
//
// GET only — the /kindle/ pages are read-only; anything else is 405.
// A Worker fetch failure is 502 (never a crash, never a stack trace).
// Free-tier friendly: one subrequest per page view, no KV/D1, no
// storage. No secrets, no env vars.

const WORKER_BASE = "https://rlibook-bot.mohamedyou1357.workers.dev";
const PUBLIC_ORIGIN = "https://rlibook.tech";
const WORKER_KINDLE = WORKER_BASE + "/kindle/";
const PUBLIC_KINDLE = PUBLIC_ORIGIN + "/kindle/";

// E-reader detection (Kindle delivery, design §3.1): the User-Agent
// contains one of these substrings (case-insensitive). Only
// "Kindle" is the verified-required one; the others are best-effort
// conveniences and are never presented as verified. This is a
// SUBSTRING match on purpose — UA strings vary by firmware and by
// desktop mode, and an exact match would silently exclude real
// Kindles. It is also trivially spoofable (any desktop browser can
// send a Kindle UA), so it gates only the ENTRY-PAGE LAYOUT, never
// a download: see the note on isEReaderUA's limits in the docs.
// Exported for tests (functions/kindle/ua.test.mjs).
export const EREADER_UA_SUBSTRINGS = ["Kindle", "Kobo", "eReader", "EBRD", "PocketBook"];

export function isEReaderUA(ua) {
  const s = (ua || "").toLowerCase();
  for (const sub of EREADER_UA_SUBSTRINGS) {
    if (s.includes(sub.toLowerCase())) return true;
  }
  return false;
}

// The Kindle entry page, served LOCALLY for the bare /kindle and
// /kindle/ paths (no Worker round-trip). Plain HTML, no JavaScript,
// `cache-control: no-store`: large buttons, a search form (GET
// /book — the same search the site already serves), and the short
// version of how to get a book on the device. A Kindle UA gets the
// Kindle layout + banner; any other visitor gets the same content
// in the standard layout with a note — never a block page (the
// delivery page is reachable without the Kindle UA by design).
// Exported for tests.
export function kindleEntryPage(request) {
  const ua = request.headers.get("user-agent") || "";
  const isKindle = isEReaderUA(ua);
  const banner = isKindle
    ? "<p><b>أنت على جهاز Kindle — هذه الصفحة مخصصة لجهازك.</b></p>\n"
    : "<p class=\"note\">هذه الصفحة مخصصة لأجهزة Kindle والقارئات الإلكترونية — "
      + "يمكنك البحث والقراءة من هنا أيضًا، والتنزيل يتم عبر صفحة «احصل على الكتاب».</p>\n";
  const body = "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>Kindle — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
    + "a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;margin:.3rem 0;"
    + "border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;font-weight:600}"
    + ".note{color:#555;font-size:.9rem}"
    + "input[type=search]{font-size:1rem;padding:.4rem;width:70%}"
    + "input[type=submit]{font-size:1rem;padding:.4rem .8rem}</style>\n</head>\n<body>\n"
    + "<h1>📚 RliBook</h1>\n"
    + banner
    + "<form method=\"get\" action=\"/book\">"
    + "<input type=\"search\" name=\"q\" placeholder=\"ابحث بالعنوان أو المؤلف…\" aria-label=\"بحث\"> "
    + "<input type=\"submit\" value=\"بحث\"></form>\n"
    + "<p><a class=\"btn\" href=\"/book\">ابحث في المكتبات</a></p>\n"
    + "<h2>كيف تحصل على كتاب على جهازك؟</h2>\n"
    + "<ol>\n"
    + "<li>ابحث عن الكتاب واضغط «احصل على الكتاب على جهازك».</li>\n"
    + "<li>افتح الرابط القصير من هاتفك أو حاسوبك ونزّل الملف (10 دقائق).</li>\n"
    + "<li>ارفع الملف في amazon.com/sendtokindle واختر جهازك.</li>\n"
    + "<li>افتح الواي فاي — سيظهر الكتاب في مكتبتك خلال دقائق.</li>\n"
    + "</ol>\n"
    + "<p class=\"note\">متصفح Kindle لا ينزّل ملفات EPUB مباشرة — لهذا ننزّلها على الهاتف أولًا. "
    + "أو اقرأ الكتاب الآن في المتصفح من زر «اقرأ أونلاين» في صفحة الكتاب.</p>\n"
    + "<p><a href=\"/\">← الرئيسية</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a> · "
    + "<a href=\"https://t.me/RliBook_bot\">البوت @RliBook_bot</a></p>\n"
    + "</body></html>";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Rewrite absolute Worker /kindle/ links to the public domain, in HTML
// only. VERIFIED LIVE 2026-11-14: the Worker does NOT (yet) honor the
// x-rlibook-origin header — a /kindle/ fetch with the header still
// returns workers.dev links — so the proxy rewrites them itself instead
// of depending on the Worker. If the Worker later honors the header,
// the rewrite is a no-op (nothing left to replace). Without this, a
// tap on "Latest" / "Libraries" inside a proxied page would jump the
// user back to the Worker domain — the exact "different website"
// problem this proxy exists to fix.
export function rewriteKindleLinks(html) {
  return html.split(WORKER_KINDLE).join(PUBLIC_KINDLE);
}

// A small HTML error page (Arabic, with a next step) instead of a
// bare error line: the proxy serves the Kindle browser, and a plain
// "Catalog unavailable" gives the user nothing to tap.
function errorPage(title, message, status) {
  const body = "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + title + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
    + "a{color:#0b5cad}</style>\n</head>\n<body>\n"
    + "<h1>RliBook</h1>\n<p>" + message + "</p>\n"
    + "<p><a href=\"/\">← الرئيسية</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a></p>\n</body></html>";
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Rewrite a Worker redirect target to the public domain, so a Worker
// 302 never jumps the user back to workers.dev (same "different
// website" problem the link rewrite fixes for HTML bodies). A
// relative Location, or one to any other host, passes through as-is.
export function rewriteLocation(location) {
  if (typeof location !== "string") return location;
  if (location.startsWith(WORKER_BASE)) {
    return PUBLIC_ORIGIN + location.slice(WORKER_BASE.length);
  }
  return location;
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") {
    return errorPage("خطأ", "هذه الصفحة تعمل برابط GET فقط.", 405);
  }
  const url = new URL(request.url);
  // The bare entry page (/kindle, /kindle/) is served locally — it
  // is the Kindle landing page, not a catalog page on the Worker.
  // Every deeper /kindle/* path still proxies to the Worker below.
  if (url.pathname === "/kindle" || url.pathname === "/kindle/") {
    return kindleEntryPage(request);
  }
  const target = WORKER_BASE + url.pathname + url.search;
  let res;
  try {
    res = await fetch(target, {
      headers: { "x-rlibook-origin": PUBLIC_ORIGIN },
    });
  } catch {
    return errorPage("الكتالوج غير متاح",
      "تعذّر الوصول إلى الكتالوج الآن — تحقق من الواي فاي وحاول مجدداً بعد دقيقة.",
      502);
  }
  const headers = new Headers();
  const contentType = res.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // Proxied HTML is personalised / dynamic: never cacheable, at the
  // edge or in the Kindle browser's own sticky cache (design §6.2.5).
  if (contentType && contentType.includes("text/html")) {
    headers.set("cache-control", "no-store");
  }
  // A redirect without its Location header is a blank page: forward
  // it (rewritten to the public domain), so the browser can follow it.
  const location = res.headers.get("location");
  if (location) headers.set("location", rewriteLocation(location));
  if (contentType && contentType.includes("text/html")) {
    return new Response(rewriteKindleLinks(await res.text()), {
      status: res.status,
      headers,
    });
  }
  return new Response(res.body, { status: res.status, headers });
}
