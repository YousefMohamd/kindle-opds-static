// Cloudflare Pages Function: "Get on Kindle" delivery page (RliBook).
// Route: GET /kindle/get?lib=<slug>&id=<book id>&f=<fmt>&t=<title>[&fp=...]
//        GET /kindle/get?lib=tg&h=<handle>&p=<post_id>&f=<fmt>&t=<title>[&fp=...]
//
//   GET /kindle/get?lib=hindawi&id=13028368&f=epub&t=...
//     -> 200 text/html — the 4 numbered steps: (1) open the short
//        link on a phone/computer, (2) download the file there,
//        (3) upload it at amazon.com/sendtokindle, (4) turn on the
//        Kindle's Wi-Fi and wait. Plus the plain-HTML reader link
//        (EPUB only) and the email fallback link.
//
// This is the PRIMARY Kindle delivery path. It mints a fresh token
// on every visit (same mintTokenForBook as /api/dl-token, same caps:
// 20/day per IP, 5/day anonymous, 20/day fingerprinted) and shows
// the short link /k/<code> (10 minutes, one book). The page says so
// honestly: the Kindle browser itself cannot download EPUBs —
// Amazon blocks it by design — so the file is downloaded on the
// phone/computer first, then uploaded to Amazon, which converts it
// and delivers it to the Kindle library.
//
// Plain HTML, NO JavaScript at all (the Kindle browser is ES5-level
// and the page must work with JS off), `cache-control: no-store`.
// Flagged (commercial) Telegram books: 403, no token minted.
// Proxy/signing key unconfigured: honest 503, never a dead button.
// GET only; anything else is 405.

import {
  parseBookParams,
  mintTokenForBook,
  issueShortLink,
  resolveOpdsAcquisitionUrl,
} from "../api/dl-token.js";

// Formats Send to Kindle for Web accepts for upload. A book in any
// other format (MOBI/AZW3/KFX) cannot be uploaded there — its step 3
// is a USB/Calibre note instead of the Amazon link, so the page
// never shows a step that is certain to fail.
export const SENDTOKINDLE_WEB_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);
// Formats the email fallback accepts (send-to-kindle.js).
const EMAIL_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);

const CSS = "body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
  + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
  + "h1{font-size:1.4rem}a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;"
  + "margin:.3rem 0;border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;"
  + "font-weight:600}.note{color:#555;font-size:.9rem}"
  + ".short{font-size:1.3rem;font-weight:700;direction:ltr;text-align:center;"
  + "background:#fff;border:1px solid #0b5cad;border-radius:8px;padding:.8rem .4rem;"
  + "word-break:break-all;margin:.5rem 0}"
  + "ol li{margin:.6rem 0}";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title, bodyHtml, status = 200) {
  return new Response("<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>" + CSS + "</style>\n</head>\n<body>\n"
    + "<h1>📚 RliBook</h1>\n" + bodyHtml + "\n</body></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The identity query string for one book, reused by the reader and
 *  email links on this page (no fp here — those endpoints take it
 *  separately). Exported for tests. */
export function bookQuery(book) {
  if (book.kind === "tg") {
    return "lib=tg&amp;h=" + encodeURIComponent(book.handle)
      + "&amp;p=" + book.postId
      + "&amp;f=" + book.fmt;
  }
  return "lib=" + encodeURIComponent(book.lib)
    + "&amp;id=" + encodeURIComponent(book.id)
    + "&amp;f=" + book.fmt;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return page("خطأ", "<p>هذه الصفحة تعمل برابط GET فقط.</p>", 405);
  }
  const url = new URL(request.url);
  const title = (url.searchParams.get("t") || "").trim().slice(0, 200);
  const fp = (url.searchParams.get("fp") || "").trim().slice(0, 128);
  const book = parseBookParams(url.searchParams, { defaultFormat: "epub" });
  if (!book.ok) {
    return page("رابط غير صحيح",
      "<p>رابط غير صحيح — لا توجد مكتبة أو كتاب.</p>\n"
      + "<p><a href=\"/\">← الرئيسية</a></p>", 400);
  }
  const backLink = title
    ? "<p><a href=\"/book?q=" + encodeURIComponent(title) + "\">← رجوع إلى صفحة الكتاب</a></p>\n"
    : "<p><a href=\"/\">← الرئيسية</a></p>\n";

  const ip = (request.headers.get("cf-connecting-ip") || "unknown").trim().slice(0, 64);
  const result = await mintTokenForBook(env, book, { ip, fp });
  if (!result.ok) {
    if (result.error === "flagged") {
      return page("⚑ كتاب تجاري",
        "<p>⚑ هذا الكتاب تجاري (عليه علامة) — الموقع لا يتيح تحميله أو إرساله.</p>\n"
        + "<p>للوصول إليه، اطلبه من قناة النشر عبر بوت تليجرام "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n"
        + backLink, 403);
    }
    if (result.error === "not_configured" || result.error === "proxy_not_configured") {
      return page("خدمة التنزيل غير مهيأة",
        "<p>خدمة التنزيل غير مهيأة بعد على الخادم — حاول مجدداً لاحقاً، "
        + "أو اقرأ الكتاب في المتصفح من الرابط أدناه.</p>\n"
        + backLink, 503);
    }
    if (result.status === 429) {
      return page("تم تجاوز الحد اليومي",
        "<p>طلبت روابط تنزيل كثيرة اليوم — جرّب مجدداً غداً.</p>\n"
        + backLink, 429);
    }
    return page("خطأ", "<p>تعذّر تجهيز رابط التنزيل الآن — حاول مجدداً بعد دقيقة.</p>\n"
      + backLink, result.status || 500);
  }

  // The short link (10 minutes, one book). Without KV there is no
  // short link — show the target URL itself (still token-gated for
  // Telegram books, still the public source URL for OPDS books).
  const short = await issueShortLink(env, book, result);
  const target = book.kind === "tg"
    ? result.url
    : resolveOpdsAcquisitionUrl(book.lib, book.id);
  const shownUrl = short
    ? url.origin.replace(/^https?:\/\//, "") + short
    : target;
  const shownHref = short ? url.origin + short : target;
  const fmtLabel = book.fmt.toUpperCase();

  // Step 3 depends on the format: Send to Kindle for Web accepts
  // EPUB/PDF/DOC/DOCX/TXT; anything else goes by USB (Calibre).
  const step3 = SENDTOKINDLE_WEB_FORMATS.has(book.fmt)
    ? "<li><b>الخطوة 3:</b> افتح <a href=\"https://www.amazon.com/sendtokindle\">amazon.com/sendtokindle</a> "
      + "من هاتفك/حاسوبك، اختر جهاز Kindle الخاص بك، ثم ارفع الملف.</li>\n"
    : "<li><b>الخطوة 3:</b> صيغة هذا الكتاب (" + esc(fmtLabel) + ") لا يقبلها موقع Send to Kindle — "
      + "انقل الملف إلى جهازك عبر USB (ببرنامج Calibre مثلاً).</li>\n";

  // Reader link: EPUB only (the plain-HTML reader opens EPUB books).
  // Email link: only the formats send-to-kindle.js accepts.
  const readerLink = book.fmt === "epub"
    ? "<p><a href=\"/read?" + bookQuery(book) + "\">📖 أو اقرأ الآن في المتصفح</a></p>\n"
    : "";
  const emailParams = bookQuery(book)
    + "&amp;t=" + encodeURIComponent(title || "")
    + (fp ? "&amp;fp=" + encodeURIComponent(fp) : "");
  const emailLink = EMAIL_FORMATS.has(book.fmt)
    ? "<p><a href=\"/api/send-to-kindle?" + emailParams + "\">أرسله بالإيميل (لمن أضاف المرسل من قبل)</a></p>\n"
    : "";

  const body = "<h1>احصل على الكتاب على جهازك</h1>\n"
    + (title ? "<p>الكتاب: «" + esc(title) + "» (" + esc(fmtLabel) + ")</p>\n" : "")
    + "<p class=\"note\">متصفح Kindle لا ينزّل ملفات EPUB — لهذا ننزّلها على الهاتف أولًا، "
    + "ثم نرفعها لأمازون فيصل الكتاب إلى جهازك.</p>\n"
    + "<ol>\n"
    + "<li><b>الخطوة 1:</b> افتح هذا الرابط من هاتفك أو حاسوبك:</li>\n"
    + "</ol>\n"
    + "<p class=\"short\"><a href=\"" + esc(shownHref) + "\">" + esc(shownUrl) + "</a></p>\n"
    + "<ol start=\"2\">\n"
    + "<li><b>الخطوة 2:</b> نزّل ملف " + esc(fmtLabel) + " على هاتفك/حاسوبك (ضغطة واحدة على الرابط).</li>\n"
    + step3
    + "<li><b>الخطوة 4:</b> افتح الواي فاي في جهازك — سيظهر الكتاب في مكتبتك خلال دقائق.</li>\n"
    + "</ol>\n"
    + "<p class=\"note\">الرابط يعمل لمدة 10 دقائق ولكتاب واحد فقط — إن انتهى، عُد هنا واضغط الزر مجدداً.</p>\n"
    + readerLink
    + emailLink
    + backLink;
  return page("احصل على الكتاب على جهازك", body, 200);
}
