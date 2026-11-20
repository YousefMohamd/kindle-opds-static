// Cloudflare Pages Function: "Send to me in Telegram" (RliBook, v4.8.49).
// Route: GET /api/tg-send?lib=tg&h=<handle>&p=<post>&f=<format>&t=<title>&s=<size>&fp=<fp>
//
//   GET /api/tg-send?lib=tg&h=khazendar&p=12345&f=epub&t=...&s=2.7%20MB&fp=<fp>
//     -> 200 text/html — the book was sent into the reader's Telegram
//        chat (or the page explains why not).
//
// WHY THIS EXISTS (Telegram direct-send, design B.4/B.5): a reader
// tapping "أرسله لي في تيليجرام" on a book card gets the file
// straight in their Telegram chat — free, instant, no email quota.
// (No 📥 emoji on the website button — F2: old Kindles render 📥
// as tofu; the bot's in-Telegram button keeps the 📥, Telegram
// renders it fine.)
// Email stays primary (the only zero-step path into the Kindle
// library); this is the secondary button + the automatic overflow
// when the daily email cap is reached. The file does NOT auto-appear
// in the Kindle library — the page tells the reader the one manual
// step (Share → Kindle app → "Send to Kindle"), and the file's own
// caption in Telegram says the same.
//
// Identity: fp=<fingerprint> from the user's personal catalog file —
// the SAME bearer <redacted> trusts. The bot resolves it
// (fp:<token> -> tg_id) and sends the file to that user's chat. No
// fp -> an informational page (open the book from the catalog file
// or the bot first), never a send. A forged fp resolves to nobody in
// the bot and gets E_NO_USER; even a stolen fp can only send to the
// VICTIM's own chat, never the attacker's, and the 5/day download
// budget bounds the damage.
//
// Env (Pages dashboard -> Settings -> Functions; secrets, never in repo):
//   RLIBOOK_KV      (required) — the SAME KV namespace the bot uses.
//                     Needed for the flagged/hidden checks. Without
//                     it the endpoint refuses (503).
// No proxy keys are needed here: the bot mints the download token
// itself (via /api/dl-token) and fetches the file — this endpoint
// only forwards the identity + the book, never the bytes.
//
// Flow: validate params (tg + known format + fp) -> flagged/hidden
// refuse -> POST { fp, handle, postId, format, title, size } to the
// bot worker's /tg-send -> the bot's business code decides the page
// shown. The bot enforces the 5/day budget, the 19/40 MB paths, and
// the file_id cache; this endpoint only pre-checks the shape.

import { isFlaggedBook, isHiddenBook } from "./dl-token.js";
import { parseCookies, COOKIE_NAME } from "./identify.js";

// The bot worker — the same base [[path]].js uses for the /kindle/
// delivery page. The website has no env var for it; the URL is
// stable (the worker's own subdomain).
export const WORKER_BASE = "https://rlibook-bot.mohamedyou1357.workers.dev";

// The bot's t.me link, for the "link your identity first" page.
export const BOT_LINK = "https://t.me/RliBook_bot";

// The formats the download proxy carries (the same set as the
// proxy's FORMAT_MIME and the bot's /tg-send check). Anything else
// is refused here, before the bot is called.
export const TG_SENDABLE_FORMATS = new Set(["epub", "pdf", "mobi", "azw3", "kfx", "txt"]);

/** Arabic page text for each business code the bot's /tg-send can
 *  return. Exported for tests. */
export function botErrorText(code) {
  switch (code) {
    case "E_NO_USER":
      return "لم نتمكن من معرفة من أنت — تأكد أنك فتحت الكتاب من ملف "
        + "الكتالوج الخاص بك، وأن حسابك مربوط في البوت. "
        + "افتح البوت أولاً ثم جرّب مرة أخرى.";
    case "E_LIMIT":
      return "وصلت إلى حد التحميل اليومي (5 كتب في اليوم) — جرّب غداً، "
        + "أو أرسل الكتاب إلى ميل قارئك.";
    case "E_NOT_AVAILABLE":
      return "هذا الكتاب غير متاح للإرسال في تيليجرام.";
    case "E_TOO_BIG":
      return "حجم الملف أكبر من 40 ميجابايت — لا يمكن إرساله في تيليجرام. "
        + "أرسله إلى ميل قارئك بدلاً من ذلك.";
    case "E_SEND_FAILED":
      return "تعذّر الإرسال — جرّب لاحقاً.";
    default:
      return "تعذّر الإرسال — جرّب لاحقاً.";
  }
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
    + "<h1>📚 RliBook</h1>\n" + bodyHtml + "\n</body></html>", {
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
  const size = (url.searchParams.get("s") || "").trim().slice(0, 32);
  const fp = (url.searchParams.get("fp") || "").trim()
    // Auto-recognition (2026-11-20): ?fp= wins; otherwise the rlb_fp
    // cookie set by /api/identify — so a reader recognised on the
    // homepage does not have to re-open the book from the catalog.
    || (parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME] || "").trim();

  // Telegram books only: OPDS books have no stable Telegram identity
  // for the bot to send to (same rule as the Convert button).
  if (lib !== "tg") {
    return page("غير متاح",
      "<p>الإرسال إلى تيليجرام من الموقع متاح لكتب تيليجرام فقط.</p>" + homeLink(), 400);
  }
  if (!/^[a-z0-9_]{3,64}$/.test(handle) || !/^\d{1,10}$/.test(postRaw)) {
    return page("خطأ",
      "<p>رابط غير صحيح — لا توجد قناة أو منشور تيليجرام.</p>" + homeLink(), 400);
  }
  const postId = Number(postRaw);
  if (!TG_SENDABLE_FORMATS.has(fmt)) {
    return page("صيغة غير مدعومة",
      "<p>الإرسال إلى تيليجرام متاح لصيغ الكتب فقط — هذا الكتاب بصيغة "
      + esc(fmt.toUpperCase() || "?") + ".</p>" + homeLink(), 400);
  }
  if (!fp) {
    return page("نحتاج بصمتك أولاً",
      "<p>لإرسال هذا الكتاب إلى تيليجرام نحتاج أن نعرف من أنت — "
      + "افتح الكتاب من ملف الكتالوج الخاص بك، أو اربط حسابك من الصفحة الرئيسية (أو من البوت) ثم اضغط زر الإرسال مرة أخرى.</p>\n"
      + "<p><a class=\"btn\" href=\"" + BOT_LINK + "\">فتح البوت</a></p>\n"
      + homeLink(), 200);
  }
  if (!env.RLIBOOK_KV) {
    return page("الخدمة غير جاهزة",
      "<p>خدمة الإرسال غير مهيأة بعد على الخادم (لا يوجد ربط KV).</p>" + homeLink(), 503);
  }
  // Flagged / hidden: refuse before calling the bot (same fail-closed
  // posture as convert-book / dl-token).
  if (await isFlaggedBook(env, handle, postId) || await isHiddenBook(env, handle, postId)) {
    return page("غير متاح",
      "<p>" + esc(botErrorText("E_NOT_AVAILABLE")) + "</p>" + homeLink(), 400);
  }
  // Hand the identity + the book to the bot: it mints the download
  // token, picks the send path (file_id / URL / upload), sends the
  // file into the user's chat, and caches the file_id. The bot
  // enforces the 5/day budget — this endpoint only pre-checked the
  // shape.
  let botRes;
  try {
    botRes = await fetch(WORKER_BASE + "/tg-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fp,
        handle,
        postId: String(postId),
        format: fmt,
        title,
        size,
      }),
    });
  } catch {
    return page("تعذّر الإرسال",
      "<p>تعذّر الاتصال بخدمة الإرسال — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  let result = null;
  try {
    result = await botRes.json();
  } catch {
    result = null;
  }
  if (!result || typeof result !== "object") {
    return page("تعذّر الإرسال",
      "<p>خدمة الإرسال ردّت رداً غير مفهوم — جرّب لاحقاً.</p>" + homeLink(), 502);
  }
  if (result.ok) {
    return page("✅ تم الإرسال إلى تيليجرام",
      "<h2>✅ تم الإرسال إلى تيليجرام</h2>\n"
      + "<p>«" + esc(title || "الكتاب") + "» وصل إلى محادثتك في تيليجرام — افتح البوت وستجده هناك.</p>\n"
      + "<p>ليظهر على الكيندل: افتح الملف في تيليجرام، اضغط «مشاركة»، اختر تطبيق Kindle ثم «Send to Kindle» — "
      + "وسيظهر في مكتبتك على الكيندل.</p>\n"
      + "<p class=\"note\">الإرسال إلى تيليجرام فوري وبلا حد يومي — أما الإرسال بالإيميل فهو الوحيد الذي يضع الكتاب في مكتبتك تلقائياً.</p>\n"
      + homeLink(), 200);
  }
  const code = typeof result.code === "string" ? result.code : "E_SEND_FAILED";
  const extra = code === "E_NO_USER"
    ? "\n<p><a class=\"btn\" href=\"" + BOT_LINK + "\">فتح البوت</a></p>\n" : "";
  return page("تعذّر الإرسال",
    "<p>" + esc(botErrorText(code)) + "</p>" + extra + homeLink(), 200);
}
