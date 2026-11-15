// Cloudflare Pages Function: short-link resolver (RliBook).
// Route: GET /k/<code> — functions/k/[code].js (a dynamic-segment
// file: functions/k.js alone would match only the bare /k path, not
// /k/<code>, so the resolver lives here).
//
//   GET /k/Ab3dEf9hJk2mNn4p -> 302 to the stored download target
//   GET /k/<unknown|expired> -> 404 HTML page (expired link, not a download)
//
// The code is the random 16-char key written by issueShortLink in
// functions/api/dl-token.js (`k:<code>` in KV, 10-minute TTL). The
// target is the signed proxy URL for Telegram books and the public
// acquisition URL for OPDS books (see dl-token.js — the proxy cannot
// serve OPDS lib:id tokens yet). A code resolves to exactly ONE
// target: a code minted for book A never resolves to book B.
// The link stays valid for the full 10 minutes (design decision D5:
// single-use would burn the link on one failed phone download for
// no real security gain — the token itself expires in 10 minutes).
// No KV binding -> 404 (there is nothing to resolve against).
// `no-store` everywhere, so a sticky cache can never serve one
// user's redirect to another.

import { resolveShortLink } from "../api/dl-token.js";

function notFoundPage() {
  const body = "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>انتهى الرابط — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
    + "a{color:#0b5cad}</style>\n</head>\n<body>\n"
    + "<h1>RliBook</h1>\n"
    + "<p>هذا الرابط غير معروف أو انتهت صلاحيته (الروابط تعمل 10 دقائق ولكتاب واحد).</p>\n"
    + "<p>عُد إلى صفحة الكتاب واضغط «احصل على الكتاب على جهازك» مجدداً ليصلك رابط جديد.</p>\n"
    + "<p><a href=\"/\">← الرئيسية</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a></p>\n</body></html>";
  return new Response(body, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The short code from the request: Pages passes it as
 *  params.code for [code].js; the pathname is the fallback (and
 *  what the tests use). Exported for tests. */
export function extractShortCode(url, params = {}) {
  if (params && typeof params.code === "string" && params.code) return params.code;
  const m = /^\/k\/([^/?#]+)/.exec(url.pathname || "");
  return m ? decodeURIComponent(m[1]) : "";
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return new Response("method_not_allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const code = extractShortCode(url, context.params || {});
  if (!/^[A-Za-z0-9]{16}$/.test(code)) {
    return notFoundPage();
  }
  const entry = await resolveShortLink(env, code);
  if (!entry) {
    return notFoundPage();
  }
  return new Response(null, {
    status: 302,
    headers: { location: entry.url, "cache-control": "no-store" },
  });
}
