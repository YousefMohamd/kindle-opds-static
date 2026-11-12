// Cloudflare Pages Function: "Send to my Kindle" (RliBook, Problem 1).
// Route: GET /api/send-to-kindle?lib=<slug>&id=<book id>&f=<fmt>&t=<title>
//        [&fp=<fingerprint> | &to=<name@kindle.com>]
//
//   GET /api/send-to-kindle?lib=hindawi&id=13028368&f=epub&t=...&fp=<fp>
//     -> 200 text/html — confirmation page (Kindle-browser friendly):
//        "sent to mo***@kindle.com — check your library in a few minutes".
//
// WHY THIS EXISTS (the Kindle download format blocker, 2026-11-12):
// The Kindle's built-in browser refuses to download EPUB/PDF at all:
//   "Invalid File Type — Only files with the extension .AZW, .PRC, .MOBI
//    or .TXT can be downloaded to your Kindle."
// And the dialog's ".AZW" does NOT cover ".azw3": an independent report
// (BicBucStriim #287) shows a *.azw3 download hitting the same error
// while the same book as *.mobi downloads fine. So there is NO direct
// browser download for the catalog's EPUB/PDF books — not even via AZW3.
// (The Block 2 proxy does not fix this either: it streams the ORIGINAL
// format, so an EPUB book still arrives as an EPUB the browser blocks.)
//
// The working path is Amazon's own Send-to-Kindle email: EPUB is
// ACCEPTED by email (Amazon converts it to AZW3/KFX on delivery) while
// MOBI/AZW by email was discontinued in late 2023. So this Function
// fetches the original EPUB/PDF, attaches it to an email from
// send@rlibook.tech, and sends it to the user's @kindle.com address
// via the Resend API — the same sender + API key the bot already uses
// successfully for the catalog file (v4.7.3, tested end-to-end
// 2026-11-12). No new host, no card, no payment, no conversion.
//
// Identity (who the Kindle email belongs to) — two ways, first wins:
//   1. fp=<fingerprint>: the fingerprint from the user's personal
//      catalog file. KV fp:<token> -> {"tg_id": N}, then
//      kindle_email:<tg_id> -> the @kindle.com address the user gave
//      the bot. No typing, no spoofing another user's address.
//   2. to=<name@kindle.com>: typed into the form on the /book page.
//      Only used when no fingerprint is present (the dictionary files
//      already sent to users link to /book WITHOUT a fingerprint).
//      Validated to end in @kindle.com; rate-limited per destination
//      and per IP (below). Amazon drops mail from unapproved senders
//      anyway, so this can only reach people who already approved
//      send@rlibook.tech — i.e. RliBook users.
//   Neither present -> an HTML page with the email form (GET, no JS),
//   so a bare link to this endpoint still works on the Kindle browser.
//
// Env (Pages dashboard -> Settings -> Functions; secrets, never in repo):
//   RESEND_API_KEY  (required) — the SAME Resend key the bot uses.
//                     Secrets are per-project: the bot's key does NOT
//                     carry over to Pages; add it to the Pages project.
//   RLIBOOK_KV      (required) — KV binding, the SAME namespace the bot
//                     uses (id b5c90a91d24c424db87bf09e3883654f).
//                     Needed for fp lookup AND for rate-limit counters.
//                     Without it the endpoint refuses (503).
//   PROXY_BASE_URL  (Telegram books only, optional for now) — e.g.
//                     https://rlibook-download-proxy.onrender.com (no trailing
//                     slash). Unset -> Telegram sends fail cleanly with
//                     an honest 503 page; OPDS sends are unaffected.
//   PROXY_SIGNING_KEY (Telegram books only) — the SAME value as the
//                     proxy's secret (generate once, reuse both sides).
//                     Unset -> same honest 503 as above.
//
// Limits (abuse bounds; Resend free tier is 100 emails/day anyway):
//   MAX_FILE_BYTES  25 MB raw (~33 MB base64, under Resend's 40 MB
//                   per-email cap after encoding, and inside a Worker's
//                   128 MB memory). Send-to-Kindle itself caps at 50 MB.
//   DAILY_PER_DEST  5 sends/day per destination address.
//   DAILY_PER_IP    20 sends/day per client IP.
//   Only EPUB / PDF / DOC / DOCX / TXT are sent (Send-to-Kindle's list).
//   MOBI/AZW are REFUSED here — Amazon rejects them by email now —
//   with a page that says so and points at the direct-download link.
//
// Free-tier friendly: 2-4 KV ops + 2 fetches (book + Resend) per send.

// Telegram books (lib=tg, W6): fetched from the Block 2 download proxy
// (see proxyDownloadUrl below) — the proxy streams the file from the
// Telegram post, and this endpoint emails it like any OPDS book.
// The proxy base URL is NOT set yet (PROXY_BASE_URL unset — the proxy
// is not deployed); until it is, Telegram sends fail cleanly with an
// honest "not configured" page (503), never silently.
import { makeToken } from "./dl-token.js";

export const RESEND_API_URL = "https://api.resend.com/emails";
export const KINDLE_SENDER = "send@rlibook.tech";
export const RESEND_FROM = "RliBook <send@rlibook.tech>";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DAILY_PER_DEST = 5;
export const DAILY_PER_IP = 20;
/** Idempotency window for one (destination + book): a repeat of the
 *  exact same send inside this window returns the confirmation page
 *  WITHOUT sending a second email (W4, 2026-11-12 — the triple-send
 *  fix). 600 s is long enough to swallow a double-tap / refresh /
 *  back-button re-send, short enough that a deliberate re-send after
 *  a few minutes still works. */
export const DEDUPE_TTL_SECONDS = 600;
export const SENDABLE_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);

const LIBS = {
  khazendar: { kind: "drive", label: "خازندار" },
  sahwa: { kind: "drive", label: "مكتبة صحوه" },
  electronic: { kind: "drive", label: "المكتبة الإلكترونية" },
  hindawi: { kind: "hindawi", label: "هنداوي" },
  doab: { kind: "doab", label: "DOAB" },
};

const FORMAT_MIME = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

/** A Kindle email address ends with @kindle.com (case-insensitive). */
export function isKindleEmail(addr) {
  const a = (addr || "").trim().toLowerCase();
  return /^[^\s@]+@kindle\.com$/.test(a);
}

/** Where the book file comes from — the same acquisition URLs as
 *  functions/book.js: Drive download, Hindawi EPUB, or the DOAB URL. */
export function resolveAcquisitionUrl(lib, id) {
  const l = LIBS[lib];
  if (!l) return null;
  if (!id) return null;
  if (l.kind === "drive") {
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) return null;
    return "https://drive.google.com/uc?id=" + id + "&export=download";
  }
  if (l.kind === "hindawi") {
    if (!/^\d{1,12}$/.test(id)) return null;
    return "https://www.hindawi.org/books/" + id + ".epub";
  }
  // doab: the id IS the full file URL (from the search index).
  if (!/^https:\/\/[^\s]+$/.test(id)) return null;
  return id;
}

/** Magic bytes must match the claimed format — a Drive warning page or
 *  a landing page is HTML, not a book, and must never be emailed. */
export function magicBytesOk(bytes, fmt) {
  if (!bytes || bytes.length < 4) return false;
  if (fmt === "pdf") {
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  }
  if (fmt === "epub" || fmt === "docx") {
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; // PK..
  }
  if (fmt === "doc") {
    return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0; // OLE
  }
  if (fmt === "txt") return true; // any bytes are plausible text
  return false;
}

/** Safe attachment filename. Amazon shows the book by its EPUB/PDF
 *  internal title, not the filename — so a pure-Arabic title, which
 *  has no safe ASCII form, falls back to a generic name and the book
 *  still appears under its real title on the Kindle. */
export function safeFilename(title, lib, id, fmt) {
  const ascii = (title || "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["/\\:;<>?*|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const stem = ascii.replace(/[^A-Za-z0-9 _.-]/g, "_").replace(/_+/g, "_").trim();
  const clean = stem.replace(/ /g, "_").slice(0, 100).replace(/_+$/, "");
  if (clean && /[A-Za-z0-9]/.test(clean)) return clean + "." + fmt;
  const shortId = String(id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "book";
  return "rlibook-" + lib + "-" + shortId + "." + fmt;
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Idempotency key for one (destination + book) send. The identity is
 *  hashed, so no email address or book id ever appears in a KV key.
 *  `bookIdentity` is "lib:id" for OPDS books, "tg:<handle>:<postId>"
 *  for Telegram books. Exported for tests. */
export async function dedupeKeyFor(email, bookIdentity, fmt) {
  const id = await sha256hex(
    String(email).trim().toLowerCase() + "|" + bookIdentity + "|" + String(fmt).toLowerCase(),
  );
  return "stk:dedup:" + id;
}

function b64Encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return (local || "").slice(0, 2) + "***@" + (domain || "kindle.com");
}

const CSS = "body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
  + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
  + "h1{font-size:1.4rem}a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;"
  + "margin:.3rem 0;border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;"
  + "font-weight:600}.note{color:#555;font-size:.9rem}"
  + "input{font-size:1rem;padding:.4rem;width:70%}";

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

function emailFormHtml(lib, id, fmt, title, note, extraHidden = "") {
  const q = (v) => esc(v || "");
  return (note ? "<p>" + esc(note) + "</p>\n" : "")
    + "<p>اكتب بريد جهازك (ينتهي بـ <b>@kindle.com</b>) — "
    + "سنرسل الكتاب «" + esc(title || "هذا الكتاب") + "» إليه، وسيظهر في مكتبتك خلال دقائق.</p>\n"
    + "<form method=\"get\" action=\"/api/send-to-kindle\">\n"
    + "<input type=\"hidden\" name=\"lib\" value=\"" + q(lib) + "\">\n"
    + "<input type=\"hidden\" name=\"id\" value=\"" + q(id) + "\">\n"
    + extraHidden
    + "<input type=\"hidden\" name=\"f\" value=\"" + q(fmt) + "\">\n"
    + "<input type=\"hidden\" name=\"t\" value=\"" + q(title) + "\">\n"
    + "<input type=\"email\" name=\"to\" placeholder=\"name@kindle.com\" required> "
    + "<input type=\"submit\" value=\"أرسل إلى جهازي\"></form>\n"
    + "<p class=\"note\">مرة واحدة فقط: أضف <b>send@rlibook.tech</b> إلى المرسلين المعتمدين "
    + "في أمازون (amazon.com/myk) — وإلا لن يصل الكتاب. لو سبق وأضفته، لا تفعل شيئاً.</p>\n"
    + "<p class=\"note\"><a href=\"/book?q=" + encodeURIComponent(title || "") + "\">← رجوع إلى صفحة الكتاب</a></p>\n";
}

function emailForm(lib, id, fmt, title, note, extraHidden = "") {
  return page("أرسل إلى جهازي", emailFormHtml(lib, id, fmt, title, note, extraHidden));
}

/** One rate-limit counter: returns true if the caller is over the limit
 *  (and does NOT increment), false if under (and increments by 1).
 *  Exact-repeat protection is NOT this function's job — the dedupe key
 *  in onRequest (W4) handles that before this is called, so a repeat
 *  tap never reaches here and never burns quota. */
async function overLimit(kv, key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const fullKey = "stk:" + key + ":" + day;
  const cur = Number((await kv.get(fullKey)) || "0");
  if (!Number.isFinite(cur)) return false;
  if (cur >= limit) return true;
  await kv.put(fullKey, String(cur + 1), { expirationTtl: 86400 });
  return false;
}

/** Build the signed proxy download URL for one Telegram book, or null
 *  when the proxy is not configured (PROXY_BASE_URL or
 *  PROXY_SIGNING_KEY unset — the proxy is not deployed yet). The token
 *  is the same HMAC scheme the proxy verifies (see dl-token.js
 *  makeToken): 10-minute life, one book. Exported for tests. */
export async function proxyDownloadUrl(env, handle, postId, fmt) {
  const base = (env.PROXY_BASE_URL || "").trim().replace(/\/+$/, "");
  const signingKey = (env.PROXY_SIGNING_KEY || "").trim();
  if (!base || !signingKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const token = await makeToken(signingKey, handle, postId, fmt, 600, now);
  return base + "/dl?h=" + encodeURIComponent(handle)
    + "&p=" + postId
    + "&f=" + encodeURIComponent(fmt)
    + "&t=" + encodeURIComponent(token);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return page("خطأ", "<p>هذه الصفحة تعمل برابط GET فقط.</p>", 405);
  }
  const url = new URL(request.url);
  const lib = (url.searchParams.get("lib") || "").trim().toLowerCase();
  const id = (url.searchParams.get("id") || "").trim();
  const fmt = (url.searchParams.get("f") || "").trim().toLowerCase();
  const title = (url.searchParams.get("t") || "").trim().slice(0, 200);
  const fp = (url.searchParams.get("fp") || "").trim();
  const to = (url.searchParams.get("to") || "").trim().toLowerCase();
  // Telegram books (W6): lib=tg&h=<handle>&p=<post_id> instead of id.
  const isTg = lib === "tg";
  const tgHandle = (url.searchParams.get("h") || "").trim().replace(/^@+/, "").toLowerCase();
  const tgPostRaw = (url.searchParams.get("p") || "").trim();
  const tgPostId = /^\d{1,10}$/.test(tgPostRaw) ? Number(tgPostRaw) : null;
  // Hidden form fields that carry the Telegram identity through the
  // typed-email form (the form is a GET back to this same endpoint).
  const formExtra = isTg
    ? "<input type=\"hidden\" name=\"h\" value=\"" + esc(tgHandle) + "\">\n"
      + "<input type=\"hidden\" name=\"p\" value=\"" + esc(tgPostRaw) + "\">\n"
    : "";

  if (isTg) {
    if (!/^[a-z0-9_]{3,64}$/.test(tgHandle) || tgPostId === null) {
      return page("خطأ", "<p>رابط غير صحيح — لا توجد قناة أو منشور تيليجرام.</p>\n"
        + "<p><a href=\"/\">← الرئيسية</a></p>", 400);
    }
  } else if (!LIBS[lib] || !id) {
    return page("خطأ", "<p>رابط غير صحيح — لا توجد مكتبة أو كتاب.</p>\n"
      + "<p><a href=\"/\">← الرئيسية</a></p>", 400);
  }
  if (!SENDABLE_FORMATS.has(fmt)) {
    const direct = resolveAcquisitionUrl(lib, id);
    return page("لا يمكن الإرسال بهذه الصيغة",
      "<p>صيغة هذا الكتاب (" + esc(fmt.toUpperCase() || "?") + ") لا تقبلها خدمة "
      + "الإرسال بالبريد — أمازون أوقفت MOBI/AZW بالبريد في أواخر 2023.</p>\n"
      + (direct
        ? "<p>جرّب <a href=\"" + esc(direct) + "\">التنزيل المباشر</a> (من متصفح عادي أو USB).</p>\n"
        : "")
      + "<p><a href=\"/book?q=" + encodeURIComponent(title) + "\">← رجوع إلى صفحة الكتاب</a></p>", 400);
  }
  if (!env.RLIBOOK_KV) {
    return page("الخدمة غير جاهزة",
      "<p>خدمة الإرسال إلى جهازك غير مهيأة بعد على الخادم (لا يوجد ربط KV).</p>", 503);
  }
  const apiKey = (env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return page("الخدمة غير جاهزة",
      "<p>خدمة الإرسال إلى جهازك غير مهيأة بعد على الخادم (لا يوجد مفتاح بريد).</p>", 503);
  }

  // ---- resolve the destination Kindle email -------------------------
  let kindleEmail = null;
  let emailSource = null;
  if (fp) {
    let rec = null;
    try {
      rec = await env.RLIBOOK_KV.get("fp:" + fp, "json");
    } catch { rec = null; }
    const tgId = rec && Number.isSafeInteger(rec.tg_id) ? rec.tg_id : null;
    if (tgId) {
      const stored = await env.RLIBOOK_KV.get("kindle_email:" + tgId);
      if (stored && isKindleEmail(stored)) {
        kindleEmail = stored.trim().toLowerCase();
        emailSource = "fingerprint";
      }
    }
    if (!kindleEmail) {
      return page("لم نجد بريد جهازك",
        "<p>لم نجد بريد جهاز مرتبطاً بهذا الكتالوج.</p>\n"
        + "<p>افتح البوت <a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a> وأرسل بريد جهازك "
        + "الخاص بك (ينتهي بـ @kindle.com)، ثم عُد هنا.</p>\n"
        + "<p>أو اكتب الميل يدوياً الآن:</p>\n"
        + emailFormHtml(lib, id, fmt, title, null, formExtra), 400);
    }
  }
  if (!kindleEmail) {
    if (!to) {
      // No fingerprint and no typed email — show the form.
      return emailForm(lib, id, fmt, title,
        "هذا الكتاب من كتالوج بلا بصمة — اكتب بريد جهازك ليصل إليك.", formExtra);
    }
    if (!isKindleEmail(to)) {
      return emailForm(lib, id, fmt, title,
        "هذا ليس بريد جهاز صحيحاً — يجب أن ينتهي بـ @kindle.com.", formExtra);
    }
    kindleEmail = to;
    emailSource = "typed";
  }

  // ---- flagged check, Telegram books only (W3/W6) --------------------
  // Defense in depth: the website hides the send button for flagged
  // books, but a direct link to this endpoint must not bypass that.
  // Same denylist as tg-search.js / dl-token.js: a KV key
  // flag:<handle>:<post_id> means flagged/commercial -> no send, no
  // reading here; the book is reachable via the bot. OPDS books are
  // public-domain / CC libraries and are never flagged. Placed BEFORE
  // the dedupe claim so a refused book never occupies the window.
  if (isTg) {
    let flagged = false;
    try {
      flagged = (await env.RLIBOOK_KV.get(`flag:${tgHandle}:${tgPostId}`)) !== null;
    } catch { flagged = false; }
    if (flagged) {
      return page("⚑ كتاب تجاري",
        "<p>⚑ هذا كتاب تجاري — لا يمكن تنزيله أو إرساله من الموقع.</p>\n"
        + "<p>اطلبه عبر تيليجرام من البوت "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n"
        + "<p><a href=\"/book?q=" + encodeURIComponent(title) + "\">← رجوع إلى البحث</a></p>\n", 403);
    }
  }

  // ---- idempotency (W4 triple-send fix) ------------------------------
  // The send is a GET with a side effect: a double-tap, a refresh of
  // the confirmation page, or a back-button re-visit re-issues it, and
  // the daily caps (5/day) happily allowed all three through — that is
  // how one tap became three emails on 2026-11-12 (KV counter
  // stk:dest:<sha256>:2026-11-12 read back as "3"). So the FIRST thing
  // after the destination is known — before any rate-limit counter is
  // touched — is a per-(destination + book + format) dedupe key with a
  // short TTL. A repeat inside the window gets the confirmation page
  // again and NO second email. The key is claimed BEFORE the slow
  // book fetch, so the race window is milliseconds, not the seconds
  // the fetch takes. If the send then FAILS (book fetch or Resend),
  // the key is released again (see failPage below) so a real retry
  // is still possible. KV has no atomic compare-and-swap, so two
  // requests landing in the same millisecond could still both pass —
  // that window is ~ms wide and bounded by the daily caps.
  const bookIdentity = isTg ? "tg:" + tgHandle + ":" + tgPostId : lib + ":" + id;
  const dedupeKey = await dedupeKeyFor(kindleEmail, bookIdentity, fmt);
  let dedupeClaimed = false;
  // failPage: an error page AFTER the dedupe claim — release the key
  // so the user can retry this same book (a failed send must not
  // poison the idempotency window).
  const failPage = async (title, bodyHtml, status) => {
    if (dedupeClaimed) {
      try { await env.RLIBOOK_KV.delete(dedupeKey); } catch { /* best-effort */ }
      dedupeClaimed = false;
    }
    return page(title, bodyHtml, status);
  };
  try {
    if (await env.RLIBOOK_KV.get(dedupeKey)) {
      return page("✅ تم الإرسال",
        "<p>✅ هذا الكتاب أُرسل بالفعل إلى <b>" + esc(maskEmail(kindleEmail)) + "</b> قبل دقائق.</p>\n"
        + "<p>لم نرسله مرة أخرى — تحقق من مكتبتك (وتأكد أن الواي فاي يعمل في جهازك).</p>\n"
        + "<p class=\"note\">إن لم يصل بعد عدة دقائق، تأكد أن <b>send@rlibook.tech</b> مضاف إلى المرسلين المعتمدين "
        + "في amazon.com/myk، ثم أعد الإرسال.</p>\n"
        + "<p><a class=\"btn\" href=\"/book?q=" + encodeURIComponent(title) + "\">← رجوع إلى البحث</a></p>\n");
    }
    await env.RLIBOOK_KV.put(dedupeKey, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    dedupeClaimed = true;
  } catch { /* KV hiccup: fail open, the send proceeds without dedupe */ }

  // ---- rate limits (per destination, then per IP) --------------------
  const destKey = "dest:" + (await sha256hex(kindleEmail));
  if (await overLimit(env.RLIBOOK_KV, destKey, DAILY_PER_DEST)) {
    return await failPage("تم تجاوز الحد اليومي",
      "<p>أُرسلت 5 كتب اليوم إلى هذا الميل — جرّب مجدداً غداً.</p>\n"
      + "<p><a href=\"/book?q=" + encodeURIComponent(title) + "\">← رجوع إلى صفحة الكتاب</a></p>", 429);
  }
  const ip = (request.headers.get("cf-connecting-ip") || "unknown").trim().slice(0, 64);
  if (await overLimit(env.RLIBOOK_KV, "ip:" + ip.replace(/[^A-Za-z0-9.:-]/g, "_"), DAILY_PER_IP)) {
    return await failPage("تم تجاوز الحد اليومي",
      "<p>أُرسلت كتب كثيرة اليوم من هذا الاتصال — جرّب مجدداً غداً.</p>", 429);
  }

  // ---- fetch the book file ------------------------------------------
  // OPDS books: the acquisition URL (Drive / Hindawi / DOAB). Telegram
  // books (W6): the file bytes from the Block 2 proxy — the endpoint
  // mints a short-lived HMAC token (same scheme as dl-token.js) and
  // fetches <proxy>/dl?h=..&p=..&f=..&t=... . The proxy streams the
  // ORIGINAL format from Telegram, so the same safety as the OPDS
  // path applies below: content-length cap, HTML rejection, magic
  // bytes, 25 MB max. If the proxy is not configured yet
  // (PROXY_BASE_URL or PROXY_SIGNING_KEY unset — the proxy is not
  // deployed), the page says so honestly instead of failing silently.
  let srcUrl;
  if (isTg) {
    srcUrl = await proxyDownloadUrl(env, tgHandle, tgPostId, fmt);
    if (!srcUrl) {
      return await failPage("خدمة الجلب غير مهيأة",
        "<p>خدمة جلب كتب تيليجرام غير مهيأة بعد على الخادم — البروكسي لم يُنشر بعد.</p>\n"
        + "<p>جرّب مجدداً لاحقاً، أو اطلب الكتاب من البوت "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n", 503);
    }
  } else {
    srcUrl = resolveAcquisitionUrl(lib, id);
    if (!srcUrl) {
      return await failPage("خطأ", "<p>تعذّر تحديد رابط هذا الكتاب.</p>", 400);
    }
  }
  let res;
  try {
    res = await fetch(srcUrl, { headers: { "user-agent": "RliBook-send-to-kindle/1.0" }, redirect: "follow" });
  } catch (e) {
    return await failPage("تعذّر تنزيل الكتاب",
      "<p>تعذّر الوصول إلى مصدر الكتاب الآن — تحقق من الواي فاي وحاول مجدداً.</p>\n"
      + "<p class=\"note\">" + esc(e && e.message ? e.message : "fetch failed") + "</p>", 502);
  }
  if (!res.ok) {
    return await failPage("تعذّر تنزيل الكتاب",
      "<p>مصدر الكتاب ردّ بخطأ (HTTP " + res.status + ") — حاول مجدداً لاحقاً، "
      + "أو نزّل الكتاب من المتصفح العادي عبر USB.</p>", 502);
  }
  const len = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > MAX_FILE_BYTES) {
    return await failPage("الكتاب كبير جداً",
      "<p>حجم هذا الكتاب (" + Math.round(len / 1048576) + " MB) أكبر من حد الإرسال بالبريد (25 MB) — "
      + "نزّله من المتصفح العادي عبر USB.</p>", 413);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("text/html")) {
    // Drive's virus-scan warning page / a landing page — not a book.
    return await failPage("تعذّر تنزيل الكتاب",
      "<p>مصدر الكتاب عرض صفحة ويب بدلاً من الملف (غالباً فحص Drive) — "
      + "نزّل الكتاب من المتصفح العادي عبر USB، أو جرّب كتاباً آخر.</p>", 502);
  }
  let bytes;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return await failPage("تعذّر تنزيل الكتاب",
      "<p>انقطع تنزيل الكتاب — حاول مجدداً.</p>", 502);
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    return await failPage("الكتاب كبير جداً",
      "<p>حجم هذا الكتاب أكبر من حد الإرسال بالبريد (25 MB) — نزّله من المتصفح العادي عبر USB.</p>", 413);
  }
  if (!magicBytesOk(bytes, fmt)) {
    return await failPage("تعذّر تنزيل الكتاب",
      "<p>الملف الذي وصل ليس كتاب " + esc(fmt.toUpperCase()) + " صالحاً — "
      + "حاول مجدداً لاحقاً.</p>", 502);
  }

  // ---- send via Resend (same call the bot makes for the catalog) -----
  const filename = safeFilename(title, lib, id, fmt);
  const subject = ("RliBook: " + (title || filename)).slice(0, 120);
  const html = "<p>Your book from RliBook is attached.</p>"
    + "<p>كتابك من RliBook مرفق بهذا الميل — سيظهر في مكتبة جهازك خلال دقائق.</p>"
    + "<p>RliBook — Reply. Read. Fly.</p>";
  let sendRes;
  try {
    sendRes = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        // Resend sits behind Cloudflare, which answers 403 to requests
        // without a User-Agent. Verified live 2026-11-11 (bot): the same
        // POST without this header got 403, with it got 200.
        "User-Agent": "RliBook-bot/1.0",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [kindleEmail],
        subject,
        html,
        attachments: [{ filename, content: b64Encode(bytes) }],
      }),
    });
  } catch (e) {
    return await failPage("تعذّر الإرسال",
      "<p>تعذّر الاتصال بخدمة البريد الآن — حاول مجدداً بعد دقيقة.</p>", 502);
  }
  if (!sendRes.ok) {
    let detail = "HTTP " + sendRes.status;
    try {
      const data = await sendRes.json();
      if (data && data.error && data.error.message) detail = data.error.message;
      else if (data && data.message) detail = data.message;
    } catch { /* keep the status detail */ }
    return await failPage("تعذّر الإرسال",
      "<p>خدمة البريد رفضت الإرسال (" + esc(detail) + ") — حاول مجدداً لاحقاً.</p>", 502);
  }

  return page("✅ تم الإرسال",
    "<p>✅ تم إرسال «" + esc(title || filename) + "» إلى <b>" + esc(maskEmail(kindleEmail)) + "</b>.</p>\n"
    + "<p>تأكد أن الواي فاي يعمل في جهازك — سيظهر الكتاب في مكتبتك خلال دقائق "
    + "(أمازون تحوّل EPUB إلى صيغة مناسبة لجهازك عند الاستلام).</p>\n"
    + "<p class=\"note\">إن لم يصل: تأكد أن <b>send@rlibook.tech</b> مضاف إلى المرسلين المعتمدين "
    + "في amazon.com/myk، ثم أعد الإرسال.</p>\n"
    + "<p><a class=\"btn\" href=\"/book?q=" + encodeURIComponent(title) + "\">← رجوع إلى البحث</a></p>\n"
    + "<p><a href=\"/\">الرئيسية</a></p>\n");
}
