// Cloudflare Pages Function: "Convert to EPUB" (RliBook, 2026-11-18 rework).
// Route: GET /api/convert-book?lib=tg&h=<handle>&p=<post>&f=pdf&t=<title>&fp=<fp>
//
//   GET /api/convert-book?lib=tg&h=khazendar&p=12345&f=pdf&t=...&fp=<fp>
//     -> 200 text/html — "جارٍ التجهيز…" page (Kindle-browser friendly):
//        the book was accepted for conversion and the EPUB will reach
//        the linked Kindle email in a few minutes.
//
// WHY THIS EXISTS (the Kindle-direct Convert button): a reader tapping
// "Convert" under "أرسل لميل قارئي" on a book card is often ON
// THE KINDLE ITSELF — and a Kindle browser cannot run the Telegram
// Mini App, so the web_app button is useless there. This endpoint
// does the whole tap server-side: it fetches the PDF from the proxy
// (the same signed download the send-to-kindle endpoint uses, WITHOUT
// burning the 5/day download budget), POSTs the bytes to the bot
// worker's /convert-book with the reader's fingerprint, and the bot
// converts (converter service) and emails the EPUB to the linked
// Kindle email — no Mini App, no extra taps, no direct EPUB download
// on the website (the no-download rule still holds: the EPUB is only
// ever emailed, never linked).
//
// Identity: fp=<fingerprint> from the user's personal catalog file —
// the SAME bearer /api/send-to-kindle trusts. The bot resolves it
// (fp:<token> -> tg_id -> kindle_email). No fp -> an informational
// page (open the book from the catalog file or the bot first), never
// a conversion. A forged fp resolves to nobody in the bot and gets
// E_NO_EMAIL; even a stolen fp can only send to the VICTIM's own
// Kindle email, never the attacker's, and the 3/day + fair-use caps
// bound the damage.
//
// Env (Pages dashboard -> Settings -> Functions; secrets, never in repo):
//   RLIBOOK_KV      (required) — the SAME KV namespace the bot uses.
//                     Needed for the flagged/hidden checks. Without
//                     it the endpoint refuses (503).
//   PROXY_BASE_URL  (required) — the download proxy base, e.g.
//                     https://rlibook-download.injectcloud.space.
//   PROXY_SIGNING_KEY (required) — the SAME value as the proxy's
//                     secret. Unset -> honest 503 (same as send-to-kindle).
// No email keys are needed here: the bot sends the email itself.
//
// Flow: validate params (tg + pdf + fp) -> flagged/hidden refuse ->
// fetch the PDF from the proxy (size + %PDF magic checked) -> POST
// { fp, filename, pdfBase64, handle, postId, title } to the bot
// worker -> the bot's business code decides the page shown.
// The bot's limits (3/day, fair use 3/hour, 10 MB) are enforced by
// the bot; this endpoint only pre-checks the size so a huge file is
// never uploaded to the bot in the first place.

import { isFlaggedBook, isHiddenBook } from "./dl-token.js";
import { magicBytesOk, proxyDownloadUrl, safeFilename } from "./send-to-kindle.js";

// The bot worker — the same base [[path]].js uses for the /kindle/
// delivery page. The website has no env var for it; the URL is
// stable (the worker's own subdomain).
export const WORKER_BASE = "https://rlibook-bot.mohamedyou1357.workers.dev";

// Mirror of the bot's CONVERT_MAX_INPUT_BYTES (src/convert.ts):
// the converter service rejects anything bigger, so a larger PDF is
// refused here before any bytes are uploaded to the bot.
export const CONVERT_MAX_INPUT_BYTES = 10 * 1024 * 1024;

// The bot's t.me link, for the "link your email first" page.
export const BOT_LINK = "https://t.me/RliBook_bot";

/** Arabic page text for each business code the bot's /convert-book
 *  can return. Exported for tests. waitMinutes is only used for
 *  E_FAIR_USE. */
export function botErrorText(code, waitMinutes) {
  switch (code) {
    case "E_NO_EMAIL":
      return "لم نتمكن من معرفة ميل قارئك — تأكد أنك فتحت الكتاب من ملف "
        + "الكتالوج الخاص بك، وأن ميل الكيندل مربوط في البوت. "
        + "اربط الميل من البوت أولاً ثم جرّب التحويل مرة أخرى.";
    case "E_LIMIT":
      return "وصلت إلى الحد اليومي للتحويل (3 تحويلات في اليوم) — جرّب غداً.";
    case "E_FAIR_USE": {
      const mins = Number(waitMinutes) || 0;
      return mins > 0
        ? "حوّلت عدة مرات في الساعة الأخيرة — انتظر " + mins + " دقيقة ثم جرّب مرة أخرى."
        : "حوّلت عدة مرات في الساعة الأخيرة — انتظر قليلاً ثم جرّب مرة أخرى.";
    }
    case "E_NOT_AVAILABLE":
      return "هذا الكتاب غير متاح للتحويل.";
    case "E_TOO_BIG":
      return "حجم الملف أكبر من 10 ميجابايت — لا يمكن تحويله.";
    case "E_NO_CONVERTER":
      return "خدمة التحويل غير متاحة الآن — جرّب لاحقاً.";
    case "E_SUBMIT_FAILED":
      return "تعذّر بدء التحويل — جرّب لاحقاً.";
    default:
      return "تعذّر التحويل — جرّب لاحقاً.";
  }
}

function b64Encode(bytes) {
  // Chunked (the naive loop builds a ~13 MB string for a 10 MB PDF;
  // chunking keeps the intermediate strings small).
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = "body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
  + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
  + "h1{font-size:1.4rem}a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;"
  + "margin:.3rem 0;border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;"
  + "font-weight:600}.note{color:#555;font-size:.9rem}";

function page(title, bodyHtml, status = 200) {
  return new Response("<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>" + CSS + "</style>\n</head>\n<body>\n"
    + "<h1>RliBook</h1>\n" + bodyHtml + "\n</body></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function homeLink() {
  return "<p><a href=\"/\">← الرئيسية</a></p>";
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return page("خطأ", "<p>هذه الصفحة تعمل برابط GET فقط.</p>" + homeLink(), 405);
  }
  const url = new URL(request.url);
  const lib = (url.searchParams.get("lib") || "").trim().toLowerCase();
  const handle = (url.searchParams.get("h") || "").trim().replace(/^@+/, "").toLowerCase();
  const postRaw = (url.searchParams.get("p") || "").trim();
  const fmt = (url.searchParams.get("f") || "").trim().toLowerCase();
  const title = (url.searchParams.get("t") || "").trim().slice(0, 200);
  const fp = (url.searchParams.get("fp") || "").trim();

  // Telegram books only: OPDS books have no stable Telegram identity
  // for the bot's convert job (same rule as the in-bot Convert button).
  if (lib !== "tg") {
    return page("غير متاح",
      "<p>التحويل من الموقع متاح لكتب تيليجرام فقط.</p>" + homeLink(), 400);
  }
  if (!/^[a-z0-9_]{3,64}$/.test(handle) || !/^\d{1,10}$/.test(postRaw)) {
    return page("خطأ",
      "<p>رابط غير صحيح — لا توجد قناة أو منشور تيليجرام.</p>" + homeLink(), 400);
  }
  const postId = Number(postRaw);
  if (fmt !== "pdf") {
    return page("صيغة غير قابلة للتحويل",
      "<p>التحويل متاح لملفات PDF فقط — هذا الكتاب بصيغة "
      + esc(fmt.toUpperCase() || "?") + ".</p>" + homeLink(), 400);
  }
  if (!fp) {
    return page("نحتاج بصمتك أولاً",
      "<p>لتحويل هذا الكتاب وإرساله إلى ميل قارئك نحتاج أن نعرف من أنت — "
      + "افتح الكتاب من ملف الكتالوج الخاص بك (أو من البوت) ثم اضغط زر التحويل مرة أخرى.</p>\n"
      + "<p><a class=\"btn\" href=\"" + BOT_LINK + "\">فتح البوت</a></p>\n"
      + homeLink(), 200);
  }
  if (!env.RLIBOOK_KV) {
    return page("الخدمة غير جاهزة",
      "<p>خدمة التحويل غير مهيأة بعد على الخادم (لا يوجد ربط KV).</p>" + homeLink(), 503);
  }
  // Flagged / hidden: refuse before any fetch (same fail-closed
  // posture as send-to-kindle / dl-token).
  if (await isFlaggedBook(env, handle, postId) || await isHiddenBook(env, handle, postId)) {
    return page("غير متاح",
      "<p>" + esc(botErrorText("E_NOT_AVAILABLE")) + "</p>" + homeLink(), 400);
  }
  const srcUrl = await proxyDownloadUrl(env, handle, postId, "pdf");
  if (!srcUrl) {
    return page("الخدمة غير جاهزة",
      "<p>خدمة التحويل غير مهيأة بعد على الخادم (لا يوجد بروكسي تحميل).</p>"
      + homeLink(), 503);
  }
  let pdfRes;
  try {
    pdfRes = await fetch(srcUrl);
  } catch {
    return page("تعذّر التحميل",
      "<p>تعذّر جلب الكتاب من المصدر — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  if (!pdfRes.ok) {
    return page("تعذّر التحميل",
      "<p>تعذّر جلب الكتاب من المصدر (رمز " + pdfRes.status + ") — جرّب لاحقاً.</p>"
      + homeLink(), 502);
  }
  const declared = Number(pdfRes.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CONVERT_MAX_INPUT_BYTES) {
    return page("ملف كبير جداً",
      "<p>" + esc(botErrorText("E_TOO_BIG")) + "</p>" + homeLink(), 413);
  }
  let bytes;
  try {
    bytes = new Uint8Array(await pdfRes.arrayBuffer());
  } catch {
    return page("تعذّر التحميل",
      "<p>تعذّر قراءة الكتاب من المصدر — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  if (bytes.length === 0 || bytes.length > CONVERT_MAX_INPUT_BYTES) {
    return page("ملف كبير جداً",
      "<p>" + esc(botErrorText("E_TOO_BIG")) + "</p>" + homeLink(), 413);
  }
  if (!magicBytesOk(bytes, "pdf")) {
    return page("تعذّر التحميل",
      "<p>الملف الذي وصل ليس PDF صحيحاً — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  // Hand the PDF to the bot: it converts server-side and emails the
  // EPUB to the linked Kindle email (the bot enforces 3/day, fair
  // use, and the 10 MB cap — this endpoint only pre-checked the size).
  const filename = safeFilename(title, "tg", String(postId), "pdf");
  let botRes;
  try {
    botRes = await fetch(WORKER_BASE + "/convert-book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fp,
        filename,
        pdfBase64: b64Encode(bytes),
        handle,
        postId: String(postId),
        title,
      }),
    });
  } catch {
    return page("تعذّر التحويل",
      "<p>تعذّر الاتصال بخدمة التحويل — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  let result = null;
  try {
    result = await botRes.json();
  } catch {
    result = null;
  }
  if (!result || typeof result !== "object") {
    return page("تعذّر التحويل",
      "<p>خدمة التحويل ردّت رداً غير مفهوم — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  if (result.ok) {
    return page("جارٍ التجهيز…",
      "<h2>جارٍ التجهيز…</h2>\n"
      + "<p>تم استلام «" + esc(title || filename) + "» وبدأ التحويل إلى EPUB.</p>\n"
      + "<p>بعد التحويل سيصل الكتاب إلى <strong>ميل قارئك</strong> مباشرةً — "
      + "افتح الكيندل بعد بضع دقائق وستجده في مكتبتك.</p>\n"
      + "<p class=\"note\">لا حاجة لعمل شيء آخر — يمكنك إغلاق هذه الصفحة متى شئت.</p>\n"
      + homeLink(), 200);
  }
  const code = typeof result.code === "string" ? result.code : "E_SUBMIT_FAILED";
  const extra = code === "E_NO_EMAIL"
    ? "\n<p><a class=\"btn\" href=\"" + BOT_LINK + "\">فتح البوت</a></p>\n" : "";
  return page("تعذّر التحويل",
    "<p>" + esc(botErrorText(code, result.waitMinutes)) + "</p>" + extra + homeLink(), 200);
}
