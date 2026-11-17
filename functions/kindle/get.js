// Cloudflare Pages Function: "Get on Kindle" delivery page (RliBook).
// Route: GET /kindle/get?lib=<slug>&id=<book id>&f=<fmt>&t=<title>[&fp=...]
//        GET /kindle/get?lib=tg&h=<handle>&p=<post_id>&f=<fmt>&t=<title>[&fp=...]
//
//   GET /kindle/get?lib=hindawi&id=13028368&f=epub&t=...
//     -> 200 text/html — the 4 numbered steps: (1) open the short
//        link on a phone/computer, (2) download the file there,
//        (3) upload it at amazon.com/sendtokindle, (4) turn on the
//        Kindle's Wi-Fi and wait. Step 3 names Amazon's exact
//        buttons — "Select files from device" / "Drag and drop
//        files here" / "Add to your library" / "Send" — plus the
//        supported-types list and the 200 MB limit, because no
//        website can pre-fill Amazon's file input (see the verdict
//        doc: the user uploads the file themselves, always).
//        Plus the plain-HTML reader link
//        (EPUB/PDF/TXT, token-gated) and the email link (unlimited — the primary
//        path; this page is the download alternative).
//
// This is the SECONDARY Kindle delivery path (2026-11-16: the
// primary path on the book card is now Send-to-Kindle by email,
// unlimited; this page is the download route for phone/computer
// users). It mints a fresh token on every visit (same
// mintTokenForBook as /api/dl-token, same caps: 5 downloads/day)
// and shows the short link /k/<code> (10 minutes, one book). The
// page says so honestly: the Kindle browser itself cannot download
// EPUBs — Amazon blocks it by design — so the file is downloaded
// on the phone/computer first, then uploaded to Amazon, which
// converts it and delivers it to the Kindle library.
//
// Per-family behaviour (docs/ereader-detection.md §4.2): the steps
// depend on the detected family (detectEReaderFamily). Kindle (and
// no UA — the default) gets the phone → Send-to-Kindle steps +
// reader + email links. Kobo/PocketBook get direct-download steps
// — tap the short link ON the device, it lands in the library —
// with NO amazon.com/sendtokindle link and NO email link (both are
// Kindle-only; Kobo has no email service). A generic e-reader UA
// gets a labelled try-direct version. Token minting, caps, the
// short link, and the flag denylist are identical for every family:
// the UA changes instructions only, never the budget.
// UA IS ROUTING ONLY, NEVER ACCESS CONTROL (2026-11-16): the UA
// picks which instructions and which format to offer (EPUB to
// Kobo/PocketBook, PDF + Send-to-Kindle guidance to Kindle). It
// proves nothing about the visitor's device — it is self-asserted
// and trivially spoofed (see docs/ereader-detection.md §3) — and it
// never changes who may download: the single-use token + 5/day
// per-device budget gate every family identically. The user accepted
// UA spoofing as a non-issue for e-readers (embedded/dumb devices);
// the gate stays a deterrent + token budget, not a hard block.
// KINDLE PDF PATH (2026-11-16): PDF is the only format a stock
// Kindle reads natively, so a PDF book gets direct-download steps
// ON the Kindle browser (one tap on the short link). FLAG: this
// step was NOT confirmed in an Amazon primary doc — it needs a
// real device test. EPUB books keep the phone → Send-to-Kindle
// steps. HONEST KINDLE CAVEAT (on the page itself): there is NO way
// to get an EPUB into a stock Kindle library without the user
// either using email or using a phone/computer for Send to Kindle.
// DUAL PATHS (2026-11-16): every device lists 2+ ways — Kobo:
// direct browser download + Mini App; PocketBook: direct download
// + Send-to-PocketBook email + Cloud/Dropbox/USB; Kindle: email
// (primary) + Send to Kindle for Web + USB (PDF: direct too).
//
// Plain HTML, NO JavaScript at all (the Kindle browser is ES5-level
// and the page must work with JS off), `cache-control: no-store`.
// Flagged (commercial) Telegram books: 403, no token minted.
// Hidden (owner-removed) Telegram books: 403, no token minted —
// the `hidden` error comes from mintTokenForBook (WS2's dl-token.js
// hidden gate; that file must be merged before this branch can fire).
// Proxy/signing key unconfigured: honest 503, never a dead button.
// GET only; anything else is 405.
//
// Mini App hub (Workstream 3b): the page carries the two Mini App
// loader scripts (telegram-web-app.js + /site/assets/telegram-
// webapp.js, both defer) and the short-link anchor carries
// `data-tg-download`. Inside Telegram, telegram-webapp.js adds the
// `tg-webapp` class to <html> (revealing `.tg-only` notes) and
// intercepts the short link, opening it with Telegram.WebApp.
// openLink() in the device browser — where downloads work —
// instead of inside the in-app webview. Outside Telegram both
// scripts are inert (no Telegram object -> no-op) and the page is
// exactly the plain-HTML page above. The Kindle browser ignores
// the deferred scripts (they never block rendering).

import {
  parseBookParams,
  mintTokenForBook,
  issueShortLink,
  resolveOpdsAcquisitionUrl,
  makeReaderToken,
  isPersonalBook,
  READER_TOKEN_TTL_SECONDS,
} from "../api/dl-token.js";
import { detectEReaderFamily, EREADER_FAMILIES } from "./[[path]].js";

// Formats Send to Kindle for Web accepts for upload. A book in any
// other format (MOBI/AZW3/KFX) cannot be uploaded there — its step 3
// is a USB/Calibre note instead of the Amazon link, so the page
// never shows a step that is certain to fail.
export const SENDTOKINDLE_WEB_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);
// Formats the plain-HTML reader opens (functions/read.js).
export const READER_FORMATS = new Set(["epub", "pdf", "txt"]);
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
  + "ol li{margin:.6rem 0}"
  + ".tg-only{display:none}"
  + "html.tg-webapp .tg-only{display:block}";

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
    + "<style>" + CSS + "</style>\n"
    + "<script defer src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n"
    + "<script defer src=\"/site/assets/telegram-webapp.js\"></script>\n</head>\n<body>\n"
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

/** The reader link for one book, or "" when the reader cannot open
 *  it. The link carries a fresh reader token (1 hour, this book
 *  only — see functions/api/dl-token.js makeReaderToken). Reading
 *  is free and unlimited: this mints NO download token and burns
 *  no download quota, so it is also offered on the 429 page.
 *  `opts` (personal books, 2026-11-16): { fp, title } — verified
 *  server-side (isPersonalBook); an own book's token carries "o":1
 *  so /read renews it without any flag re-check.
 *  Exported for tests. */
export async function readerLinkFor(env, book, opts = {}) {
  if (!READER_FORMATS.has(book.fmt)) return "";
  const key = (env.PROXY_SIGNING_KEY || "").trim();
  if (!key) return "";
  const handle = book.kind === "tg" ? book.handle : book.lib;
  const postId = book.kind === "tg" ? book.postId : book.id;
  const own = book.kind === "tg"
    && (await isPersonalBook(env, opts.fp || "", opts.title || ""));
  const rtok = await makeReaderToken(key, handle, postId, book.fmt,
    READER_TOKEN_TTL_SECONDS, undefined, own);
  return "<p><a href=\"/read?" + bookQuery(book)
    + "&amp;rtok=" + encodeURIComponent(rtok)
    + "\">📖 أو اقرأ الآن في المتصفح</a></p>\n";
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
  // Personal book? Verified server-side (fp + title against the
  // private feed). Own books skip the flag gate and the mint caps
  // in mintTokenForBook (the hidden check still applies) and get an
  // own reader token below.
  const own = book.kind === "tg" && (await isPersonalBook(env, fp, title));
  const result = await mintTokenForBook(env, book, { ip, fp, own });
  if (!result.ok) {
    if (result.error === "flagged") {
      return page("⚑ كتاب تجاري",
        "<p>⚑ هذا الكتاب تجاري (عليه علامة) — الموقع لا يتيح تحميله أو إرساله.</p>\n"
        + "<p>للوصول إليه، اطلبه من قناة النشر عبر بوت تليجرام "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n"
        + backLink, 403);
    }
    if (result.error === "hidden") {
      // Owner-hide (Workstream 2b): the book was removed by the
      // owner — no download, no steps, no bot direction (it is not
      // in the bot's search either).
      // Precedence (verified in dl-token.js mintTokenForBook):
      // flag is checked BEFORE hidden, and this page checks
      // "flagged" first too — so a book with BOTH keys gets
      // the flagged page. This hidden page only shows for a
      // book that is hidden but NOT flagged.
      return page("🚫 كتاب غير متاح",
        "<p>🚫 هذا الكتاب أزاله المالك، فلم يعد متاحاً.</p>\n"
        + "<p><a href=\"/book\">← رجوع إلى البحث</a></p>\n", 403);
    }
    if (result.error === "not_configured" || result.error === "proxy_not_configured") {
      return page("خدمة التنزيل غير مهيأة",
        "<p>خدمة التنزيل غير مهيأة بعد على الخادم — حاول مجدداً لاحقاً.</p>\n"
        + backLink, 503);
    }
    if (result.status === 429) {
      // The download cap is hit, but reading is free and unlimited
      // and does not burn download quota — still offer the reader.
      const readerLink = await readerLinkFor(env, book, { fp, title });
      return page("تم تجاوز الحد اليومي",
        "<p>طلبت روابط تنزيل كثيرة اليوم (الحد 5 كتب في اليوم) — جرّب مجدداً غداً، "
        + "أو أرسل الكتاب بالإيميل فهو بلا حد يومي.</p>\n"
        + (readerLink
          ? "<p class=\"note\">القراءة في المتصفح مجانية ولا تُحسب من حد التنزيل اليومي.</p>\n" + readerLink
          : "")
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

  // Family-specific steps (docs/ereader-detection.md §4.2). The
  // token above is already minted — every family pays the same
  // budget; only the instructions differ. Kindle (and no UA, the
  // default) keeps the phone → Send-to-Kindle steps. Kobo and
  // PocketBook download directly on the device, so the Send-to-
  // Kindle-Web link and the email link are BOTH hidden for them:
  // the first is Amazon-only, the second sends to a Kindle
  // address (Kobo has no email service; PocketBook's own address
  // is the user's, never ours). Generic gets a try-direct version
  // labelled unverified on the page.
  const family = detectEReaderFamily(request.headers.get("user-agent") || "");
  const fam = family ? EREADER_FAMILIES[family] : null;

  // Step 3 depends on the format: Send to Kindle for Web accepts
  // EPUB/PDF/DOC/DOCX/TXT; anything else goes by USB (Calibre).
  const step3 = SENDTOKINDLE_WEB_FORMATS.has(book.fmt)
    ? "<li><b>الخطوة 3:</b> افتح <a href=\"https://www.amazon.com/sendtokindle\">amazon.com/sendtokindle</a> "
      + "من هاتفك/حاسوبك وسجّل دخولك بحساب أمازون المسجّل عليه جهاز Kindle، ثم اضغط زر «Select files from device» "
      + "(أو اسحب الملف إلى منطقة «Drag and drop files here»)، واختر ملف " + esc(fmtLabel) + " الذي نزّلته في الخطوة 2، "
      + "وتأكّد من تفعيل «Add to your library»، ثم اضغط «Send».</li>\n"
    : "<li><b>الخطوة 3:</b> صيغة هذا الكتاب (" + esc(fmtLabel) + ") لا يقبلها موقع Send to Kindle — "
      + "انقل الملف إلى جهازك عبر USB (ببرنامج Calibre مثلاً).</li>\n";

  // Reader link: EPUB/PDF/TXT (the plain-HTML reader opens those),
  // token-gated, minted here — reading burns no download quota.
  // Email link: only the formats send-to-kindle.js accepts. Email is
  // the primary path (unlimited, no daily cap) — this page says so,
  // so a user who hit the 5/day download cap sees the alternative.
  // (Shown only for Kindle/default — the endpoint sends to a Kindle
  // address; Kobo/PocketBook get no email link, per the family body below.)
  const readerLink = await readerLinkFor(env, book, { fp, title });
  const emailParams = bookQuery(book)
    + "&amp;t=" + encodeURIComponent(title || "")
    + (fp ? "&amp;fp=" + encodeURIComponent(fp) : "");
  const emailLink = EMAIL_FORMATS.has(book.fmt)
    ? "<p><a href=\"/api/send-to-kindle?" + emailParams + "\">أرسله بالإيميل — بلا حد يومي (لمن أضاف المرسل من قبل)</a></p>\n"
    : "";

  const tenMinuteNote = "<p class=\"note\">الرابط يعمل مرة واحدة فقط، خلال 10 دقائق، ولكتاب واحد (5 كتب في اليوم كحد أقصى) — إن استخدمته أو انتهى، عُد هنا واضغط الزر مجدداً.</p>\n";
  const titleLine = title ? "<p>الكتاب: «" + esc(title) + "» (" + esc(fmtLabel) + ")</p>\n" : "";

  let body;
  if (family === "kobo" || family === "pocketbook") {
    // Direct download on the device (verified: both browsers save
    // the file into the library). The short link IS the download:
    // the device browser follows /k/<code> and saves the file.
    // Format note from the family table: a format the device opens
    // natively says so; anything else says it may need Calibre/USB.
    const native = fam.nativeFormats && fam.nativeFormats.includes(book.fmt);
    const formatNote = native
      ? "<p class=\"note\">صيغة هذا الكتاب (" + esc(fmtLabel) + ") يفتحها جهاز "
        + esc(fam.label) + " مباشرة.</p>\n"
      : "<p class=\"note\">صيغة هذا الكتاب (" + esc(fmtLabel) + ") قد لا يفتحها جهاز "
        + esc(fam.label) + " مباشرة — نزّلها على حاسوبك وحوّلها ببرنامج Calibre ثم انقلها عبر USB.</p>\n";
    // Second way per device (dual paths, 2026-11-16). Kobo: the
    // Telegram Mini App — the tg-only note below is the second way
    // (tap the link in Telegram, it opens in the device browser).
    // PocketBook: Send-to-PocketBook email (the user's own
    // username@pbsync.com address — the book page's email button
    // accepts it; confirm send@rlibook.tech once on the device) +
    // PocketBook Cloud / Dropbox / USB. No endpoint link is printed
    // here: the family tests forbid /api/send-to-kindle on this
    // page (the email button lives on the book page instead).
    const secondPath = family === "kobo"
      ? "<p class=\"note\"><b>طريقة ثانية:</b> إن كنت في تيليجرام، اضغط الرابط من داخل التطبيق — سيُفتح في متصفح جهازك وينزّل الكتاب مباشرة.</p>\n"
      : "<p class=\"note\"><b>طريقة ثانية:</b> أرسل الملف إلى بريد PocketBook الخاص بك (username@pbsync.com) — من صفحة الكتاب اضغط «أرسله بالإيميل» واكتب بريد جهازك (أضف send@rlibook.tech إلى المرسلين المسموحين مرة واحدة).</p>\n"
        + "<p class=\"note\"><b>طريقة ثالثة:</b> انقل الملف عبر PocketBook Cloud أو Dropbox أو USB.</p>\n";
    body = "<h1>احصل على الكتاب على جهازك</h1>\n"
      + titleLine
      + "<p class=\"note\">متصفح جهاز " + esc(fam.label)
      + " ينزّل الكتاب مباشرة — اضغط الرابط أدناه هنا على جهازك.</p>\n"
      + "<ol>\n"
      + "<li><b>الخطوة 1:</b> اضغط هذا الرابط هنا على جهازك:</li>\n"
      + "</ol>\n"
      + "<p class=\"short\"><a data-tg-download href=\"" + esc(shownHref) + "\">" + esc(shownUrl) + "</a></p>\n"
      + "<p class=\"note tg-only\">في تيليجرام: اضغط الرابط وسيُفتح في متصفح جهازك لتنزيل الملف — من هناك سيظهر في مكتبتك.</p>\n"
      + "<ol start=\"2\">\n"
      + "<li><b>الخطوة 2:</b> سينزّل ملف " + esc(fmtLabel) + " ويظهر في مكتبتك.</li>\n"
      + "<li><b>الخطوة 3:</b> إن لم ينزّل المتصفح الملف، افتح الرابط نفسه من هاتفك أو حاسوبك وانقل الملف عبر USB.</li>\n"
      + "</ol>\n"
      + secondPath
      + formatNote
      + tenMinuteNote
      + readerLink
      + backLink;
  } else if (family === "generic") {
    // Unverified device token (eReader/EBRD): say so, offer the
    // direct attempt first, USB as the fallback. No Send-to-Kindle
    // link, no email link — both are Kindle-only.
    body = "<h1>احصل على الكتاب على جهازك</h1>\n"
      + titleLine
      + "<p class=\"note\">لم نتحقق من جهازك تحديدًا — جرّب التنزيل المباشر أولًا، وإن لم يعمل فانقل الملف عبر USB.</p>\n"
      + "<ol>\n"
      + "<li><b>الخطوة 1:</b> اضغط هذا الرابط هنا على جهازك:</li>\n"
      + "</ol>\n"
      + "<p class=\"short\"><a data-tg-download href=\"" + esc(shownHref) + "\">" + esc(shownUrl) + "</a></p>\n"
      + "<p class=\"note tg-only\">في تيليجرام: اضغط الرابط وسيُفتح في متصفح جهازك لتنزيل الملف.</p>\n"
      + "<ol start=\"2\">\n"
      + "<li><b>الخطوة 2:</b> إن نزّل المتصفح الملف، سيظهر في مكتبتك.</li>\n"
      + "<li><b>الخطوة 3:</b> إن لم ينزّل المتصفح الملف، افتح الرابط نفسه من هاتفك أو حاسوبك وانقل الملف عبر USB.</li>\n"
      + "</ol>\n"
      + tenMinuteNote
      + readerLink
      + backLink;
  } else if (book.fmt === "pdf") {
    // KINDLE PDF PATH (2026-11-16): PDF is the only format a stock
    // Kindle reads natively, so the one-tap path is a direct download
    // in the Kindle browser itself. FLAG — NEEDS A REAL DEVICE TEST:
    // this step was NOT confirmed in an Amazon primary doc; treat it
    // as likely until a Kindle device test confirms it. Email + Send
    // to Kindle stay available below as the verified alternatives.
    body = "<h1>احصل على الكتاب على جهازك</h1>\n"
      + titleLine
      + "<p class=\"note\">هذا الكتاب بصيغة PDF — والصيغة الوحيدة التي يقرؤها Kindle مباشرة — فيمكنك تنزيله هنا على جهازك بضغطة واحدة.</p>\n"
      + "<p class=\"note\">ملاحظة: هذه الخطوة لم نتحقق منها على جهاز Kindle حقيقي بعد — إن لم يعمل التنزيل المباشر، استخدم الإيميل أو Send to Kindle أدناه.</p>\n"
      + "<ol>\n"
      + "<li><b>الخطوة 1:</b> اضغط هذا الرابط هنا على جهاز Kindle:</li>\n"
      + "</ol>\n"
      + "<p class=\"short\"><a data-tg-download href=\"" + esc(shownHref) + "\">" + esc(shownUrl) + "</a></p>\n"
      + "<ol start=\"2\">\n"
      + "<li><b>الخطوة 2:</b> سينزّل ملف PDF ويظهر في مكتبتك.</li>\n"
      + "<li><b>الخطوة 3:</b> إن لم ينزّل المتصفح الملف، استخدم الإيميل (أدناه) أو ارفع الملف في amazon.com/sendtokindle من هاتفك/حاسوبك (اضغط «Select files from device» واختر ملف PDF، ثم «Send»).</li>\n"
      + "</ol>\n"
      + tenMinuteNote
      + readerLink
      + emailLink
      + backLink;
  } else {
    body = "<h1>احصل على الكتاب على جهازك</h1>\n"
      + titleLine
      + "<p class=\"note\">متصفح Kindle لا ينزّل ملفات EPUB — لهذا ننزّلها على الهاتف أولًا، "
      + "ثم نرفعها لأمازون فيصل الكتاب إلى جهازك.</p>\n"
      // HONEST KINDLE CAVEAT (2026-11-16, must stay on the page):
      // no way to get an EPUB into a stock Kindle library without
      // email or a phone/computer for Send to Kindle. PDF is the
      // one-tap path (see the PDF branch above).
      + "<p class=\"note\"><b>بصراحة:</b> لا توجد طريقة لإدخال ملف EPUB إلى مكتبة Kindle مباشرة دون إيميل أو دون هاتف/حاسوب لرفعه في Send to Kindle — الإيميل (أدناه) هو الطريق الأساسي، ورفعه من الهاتف هو البديل. أما الكتب بصيغة PDF فتنزّل مباشرة على الجهاز.</p>\n"
      + "<ol>\n"
      + "<li><b>الخطوة 1:</b> افتح هذا الرابط من هاتفك أو حاسوبك:</li>\n"
      + "</ol>\n"
      + "<p class=\"short\"><a data-tg-download href=\"" + esc(shownHref) + "\">" + esc(shownUrl) + "</a></p>\n"
      + "<p class=\"note tg-only\">في تيليجرام: اضغط الرابط وسيُفتح في متصفح جهازك لتنزيل الملف — من هناك ارفعه إلى Send to Kindle.</p>\n"
      + "<ol start=\"2\">\n"
      + "<li><b>الخطوة 2:</b> نزّل ملف " + esc(fmtLabel) + " على هاتفك/حاسوبك (ضغطة واحدة على الرابط) — على الهاتف ستجد الملف في مجلد التنزيلات (Downloads)، وستختاره من هناك في الخطوة 3.</li>\n"
      + step3
      + "<li><b>الخطوة 4:</b> افتح الواي فاي في جهازك — سيظهر الكتاب في مكتبتك خلال دقائق.</li>\n"
      + "</ol>\n"
      + "<p class=\"note\">الصيغ التي يقبلها موقع أمازون: PDF و DOC و DOCX و TXT و RTF و HTM و HTML و PNG و GIF و JPG و JPEG و BMP و EPUB — وأقصى حجم للملف 200 MB.</p>\n"
      + "<p class=\"note\"><b>مهم:</b> أمازون لا يجلب الملف من RliBook — أنت من يرفعه بنفسك من جهازك في الخطوة 3؛ رابطنا يفتح صفحة أمازون فقط، ولا يمكن لأي موقع أن يملأ خانة رفع الملفات بدلاً عنك.</p>\n"
      + "<p class=\"note\"><b>طريقة ثالثة:</b> انقل الملف إلى جهازك عبر USB (ببرنامج Calibre مثلاً) إن لم يعمل الإيميل أو Send to Kindle.</p>\n"
      + tenMinuteNote
      + "<p class=\"note\">ليس لديك Kindle؟ بعد الخطوة 2 افتح الملف في أي تطبيق قراءة على هاتفك أو حاسوبك — وصل الكتاب إليك، ولا حاجة للخطوتين 3 و 4.</p>\n"
      + readerLink
      + emailLink
      + backLink;
  }
  return page("احصل على الكتاب على جهازك", body, 200);
}
