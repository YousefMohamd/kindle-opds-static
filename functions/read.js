// Cloudflare Pages Function: plain-HTML in-browser reader (RliBook).
// Route: GET /read?lib=<slug>&id=<book id> (OPDS books, EPUB only, v1)
//        GET /read?lib=tg&h=<handle>&p=<post_id> (Telegram books, EPUB only)
//
//   GET /read?lib=hindawi&id=13028368
//     -> 200 text/html — chapter 1 as plain HTML, no JavaScript at
//        all (the Gutenberg "Read now!" model, which works in the
//        Kindle browser). ?ch=N paginates by chapter.
//
// How it works: the Function fetches the EPUB (the same acquisition
// URLs as send-to-kindle.js for OPDS books; the signed proxy URL for
// Telegram books), unzips it server-side (EPUB is a ZIP of XHTML),
// and renders one spine chapter per page. No download, no file, no
// email, no Amazon involved — so none of the email failure modes
// apply. The trade-off, stated on the page: reading in the browser
// does not put the book in the Kindle library, has no cover/progress
// sync, and needs Wi-Fi while reading.
//
// Scope (v1): EPUB only. A PDF/DOC book gets an honest 400 page with
// a link to the delivery page instead. Flagged (commercial) Telegram
// books: 403, same KV denylist as dl-token.js — no reader and no
// download on the website. OPDS books are PD/CC and never flagged.
//
// Safety, same as the email endpoint: 25 MB cap, HTML content-type
// rejection (a Drive warning page is not a book), PK magic-bytes
// check, fetch failure -> 502. The chapter HTML is sanitised
// (script/style/iframe/object/form/embed stripped, event-handler
// attributes and javascript: links removed) — an EPUB from the
// catalog is trusted PD/CC content, but the reader still never
// executes anything from inside a book file.
//
// Free-tier friendly: one book fetch + CPU to unzip (ZIP inflate via
// DecompressionStream; a 25 MB EPUB is the cap, a typical book is
// far smaller). Zero D1 writes, no KV writes (one flag read for
// Telegram books).

import { parseBookParams, isFlaggedBook, resolveOpdsAcquisitionUrl } from "./api/dl-token.js";
import { magicBytesOk, proxyDownloadUrl } from "./api/send-to-kindle.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const CSS = "body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
  + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
  + "h1{font-size:1.4rem}a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;"
  + "margin:.3rem 0;border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;"
  + "font-weight:600}.note{color:#555;font-size:.9rem}"
  + ".nav{margin:1rem 0}.chapter{line-height:1.9}";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
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

// ---- minimal ZIP reader (EPUB = ZIP of XHTML) -----------------------
// Central-directory parse + stored (0) / deflate (8) entries only.
// A ZIP with any other compression method, or a broken central
// directory, is not an EPUB we can read -> null.
export async function unzipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = view.getUint16(eocd + 10, true);
  let cdOff = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < cdCount; n++) {
    if (cdOff + 46 > bytes.length) return null;
    if (view.getUint32(cdOff, true) !== 0x02014b50) return null;
    const method = view.getUint16(cdOff + 10, true);
    const csize = view.getUint32(cdOff + 20, true);
    const nameLen = view.getUint16(cdOff + 28, true);
    const extraLen = view.getUint16(cdOff + 30, true);
    const commentLen = view.getUint16(cdOff + 32, true);
    const lho = view.getUint32(cdOff + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cdOff + 46, cdOff + 46 + nameLen));
    entries.set(name, { method, csize, lho });
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.lho;
  if (off + 30 > bytes.length) return null;
  if (view.getUint32(off, true) !== 0x04034b50) return null;
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const start = off + 30 + nameLen + extraLen;
  const comp = bytes.subarray(start, start + entry.csize);
  if (comp.length !== entry.csize) return null;
  if (entry.method === 0) return comp;
  if (entry.method === 8) {
    try {
      const ds = new DecompressionStream("deflate-raw");
      const out = await new Response(
        new Blob([comp]).stream().pipeThrough(ds),
      ).arrayBuffer();
      return new Uint8Array(out);
    } catch {
      return null;
    }
  }
  return null;
}

function attr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(tag);
  return m ? m[1] : null;
}

function resolveZipPath(base, href) {
  const clean = href.split("#")[0].split("?")[0];
  const parts = (base + clean).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") { out.pop(); continue; }
    out.push(p);
  }
  return out.join("/");
}

/** First heading/title text in a chapter, stripped of tags. */
export function chapterTitle(xhtml, fallback) {
  const m = /<(h1|h2|title)[^>]*>([\s\S]*?)<\/\1>/.exec(xhtml);
  if (m) {
    const text = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (text) return unescapeXml(text).slice(0, 120);
  }
  return fallback;
}

/** Chapter body HTML, sanitised: script/style/iframe/object/form/
/// embed/link/meta removed, event-handler attributes removed,
/// javascript: links neutralised. Everything else (p, h1-h6, img,
/// a, lists, tables) passes through — the reader never executes
/// anything from inside a book file, and there is no <script> on
/// the page itself either. */
export function sanitizeChapterHtml(xhtml) {
  let body = xhtml;
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  if (m) body = m[1];
  body = body
    .replace(/<(script|style|iframe|object|form|embed|link|meta|base)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|form|embed|link|meta|base)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"')
    .replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
  return body;
}

/** Parse an EPUB's bytes into { title, chapters: [{ title, html }] }.
 *  Returns null when the file is not a readable EPUB (bad ZIP, no
 *  container.xml, no OPF, empty spine). Exported for tests. */
export async function parseEpub(bytes) {
  const entries = await unzipEntries(bytes);
  if (!entries) return null;
  const containerEntry = entries.get("META-INF/container.xml");
  if (!containerEntry) return null;
  const containerBytes = await readZipEntry(bytes, containerEntry);
  if (!containerBytes) return null;
  const containerText = new TextDecoder().decode(containerBytes);
  const rootMatch = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerText);
  if (!rootMatch) return null;
  const opfPath = decodeURIComponent(rootMatch[1]);
  const opfEntry = entries.get(opfPath);
  if (!opfEntry) return null;
  const opfBytes = await readZipEntry(bytes, opfEntry);
  if (!opfBytes) return null;
  const opfText = new TextDecoder().decode(opfBytes);
  const titleMatch = /<dc:title[^>]*>([^<]*)<\/dc:title>/.exec(opfText);
  const title = titleMatch ? unescapeXml(titleMatch[1]).trim().slice(0, 200) : "";
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map();
  const itemTags = opfText.match(/<item\b[^>]*>/g) || [];
  for (const tag of itemTags) {
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    const mediaType = attr(tag, "media-type") || "";
    if (id && href) manifest.set(id, { href, mediaType });
  }
  const spine = [];
  const refTags = opfText.match(/<itemref\b[^>]*>/g) || [];
  for (const tag of refTags) {
    const idref = attr(tag, "idref");
    if (idref) spine.push(idref);
  }
  const chapters = [];
  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item) continue;
    if (!/xhtml|xml/.test(item.mediaType)) continue;
    const path = resolveZipPath(base, decodeURIComponent(item.href));
    const entry = entries.get(path);
    if (!entry) continue;
    const chBytes = await readZipEntry(bytes, entry);
    if (!chBytes) continue;
    const xhtml = new TextDecoder().decode(chBytes);
    chapters.push({
      title: chapterTitle(xhtml, "الفصل " + (chapters.length + 1)),
      html: sanitizeChapterHtml(xhtml),
    });
  }
  if (!chapters.length) return null;
  return { title, chapters };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return page("خطأ", "<p>هذه الصفحة تعمل برابط GET فقط.</p>", 405);
  }
  const url = new URL(request.url);
  const book = parseBookParams(url.searchParams, { defaultFormat: "epub" });
  if (!book.ok) {
    return page("رابط غير صحيح",
      "<p>رابط غير صحيح — لا توجد مكتبة أو كتاب.</p>\n"
      + "<p><a href=\"/\">← الرئيسية</a></p>", 400);
  }
  const title = (url.searchParams.get("t") || "").trim().slice(0, 200);
  const backToBook = title
    ? "/book?q=" + encodeURIComponent(title)
    : "/";
  // The reader opens EPUB only (v1). Any other format gets an honest
  // page with the delivery-page link instead of a broken reader.
  if (book.fmt !== "epub") {
    const getParams = book.kind === "tg"
      ? "lib=tg&amp;h=" + encodeURIComponent(book.handle) + "&amp;p=" + book.postId
      : "lib=" + encodeURIComponent(book.lib) + "&amp;id=" + encodeURIComponent(book.id);
    return page("لا يمكن القراءة هنا",
      "<p>هذا الكتاب بصيغة " + esc(book.fmt.toUpperCase()) + " — القارئ يفتح كتب EPUB فقط.</p>\n"
      + "<p>احصل عليه على جهازك من <a href=\"/kindle/get?" + getParams
      + "&amp;f=" + book.fmt + "\">صفحة «احصل على الكتاب على جهازك»</a>.</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 400);
  }

  // Flagged Telegram books: no reader on the website (same denylist
  // as dl-token.js). OPDS books are PD/CC and never flagged.
  if (book.kind === "tg" && (await isFlaggedBook(env, book.handle, book.postId))) {
    return page("⚑ كتاب تجاري",
      "<p>⚑ هذا الكتاب تجاري (عليه علامة) — الموقع لا يتيح تحميله أو قراءته.</p>\n"
      + "<p>للوصول إليه، اطلبه من قناة النشر عبر بوت تليجرام "
      + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 403);
  }

  // ---- fetch the book file ------------------------------------------
  let srcUrl;
  if (book.kind === "tg") {
    srcUrl = await proxyDownloadUrl(env, book.handle, book.postId, "epub");
    if (!srcUrl) {
      return page("خدمة الجلب غير مهيأة",
        "<p>خدمة جلب كتب تيليجرام غير مهيأة بعد على الخادم — البروكسي لم يُنشر بعد.</p>\n"
        + "<p>جرّب مجدداً لاحقاً، أو اطلب الكتاب من البوت "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n", 503);
    }
  } else {
    srcUrl = resolveOpdsAcquisitionUrl(book.lib, book.id);
    if (!srcUrl) {
      return page("خطأ", "<p>تعذّر تحديد رابط هذا الكتاب.</p>", 400);
    }
  }
  let res;
  try {
    res = await fetch(srcUrl, { headers: { "user-agent": "RliBook-reader/1.0" }, redirect: "follow" });
  } catch (e) {
    return page("تعذّر تنزيل الكتاب",
      "<p>تعذّر الوصول إلى مصدر الكتاب الآن — تحقق من الواي فاي وحاول مجدداً.</p>\n"
      + "<p class=\"note\">" + esc(e && e.message ? e.message : "fetch failed") + "</p>", 502);
  }
  if (!res.ok) {
    return page("تعذّر تنزيل الكتاب",
      "<p>مصدر الكتاب ردّ بخطأ (HTTP " + res.status + ") — حاول مجدداً لاحقاً.</p>", 502);
  }
  const len = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > MAX_FILE_BYTES) {
    return page("الكتاب كبير جداً",
      "<p>حجم هذا الكتاب أكبر من حد القراءة في المتصفح (25 MB) — احصل عليه على جهازك من صفحة الكتاب.</p>", 413);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("text/html")) {
    return page("تعذّر تنزيل الكتاب",
      "<p>مصدر الكتاب عرض صفحة ويب بدلاً من الملف (غالباً فحص Drive) — جرّب كتاباً آخر.</p>", 502);
  }
  let bytes;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return page("تعذّر تنزيل الكتاب",
      "<p>انقطع تنزيل الكتاب — حاول مجدداً.</p>", 502);
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    return page("الكتاب كبير جداً",
      "<p>حجم هذا الكتاب أكبر من حد القراءة في المتصفح (25 MB).</p>", 413);
  }
  if (!magicBytesOk(bytes, "epub")) {
    return page("تعذّر تنزيل الكتاب",
      "<p>الملف الذي وصل ليس كتاب EPUB صالحاً — حاول مجدداً لاحقاً.</p>", 502);
  }
  const epub = await parseEpub(bytes);
  if (!epub) {
    return page("تعذّر قراءة الكتاب",
      "<p>تعذّر قراءة هذا الملف ككتاب EPUB — قد يكون تالفاً أو بصيغة غير مدعومة.</p>\n"
      + "<p>احصل عليه على جهازك من صفحة الكتاب.</p>", 502);
  }

  // ---- render one chapter -------------------------------------------
  const chRaw = Number(url.searchParams.get("ch") || "1");
  const ch = Number.isFinite(chRaw) ? Math.max(1, Math.min(epub.chapters.length, Math.floor(chRaw))) : 1;
  const chapter = epub.chapters[ch - 1];
  const bookTitle = epub.title || title || "كتاب";
  const selfParams = book.kind === "tg"
    ? "lib=tg&amp;h=" + encodeURIComponent(book.handle) + "&amp;p=" + book.postId
    : "lib=" + encodeURIComponent(book.lib) + "&amp;id=" + encodeURIComponent(book.id);
  const navLink = (n, label) => "<a href=\"/read?" + selfParams + "&amp;ch=" + n + "\">" + label + "</a>";
  const nav = "<p class=\"nav\">"
    + (ch > 1 ? navLink(ch - 1, "→ الفصل السابق") + " · " : "")
    + "الفصل " + ch + " من " + epub.chapters.length
    + (ch < epub.chapters.length ? " · " + navLink(ch + 1, "الفصل التالي ←") : "")
    + "</p>\n";
  const getParams = selfParams + "&amp;f=epub"
    + (title ? "&amp;t=" + encodeURIComponent(title) : "");
  const body = "<h1>" + esc(bookTitle) + "</h1>\n"
    + "<h2>" + esc(chapter.title) + "</h2>\n"
    + nav
    + "<div class=\"chapter\">\n" + chapter.html + "\n</div>\n"
    + nav
    + "<p class=\"note\">القراءة هنا في المتصفح فقط — الكتاب لا يُضاف إلى مكتبة جهازك من هنا. "
    + "للحصول عليه على جهازك: <a href=\"/kindle/get?" + getParams + "\">صفحة «احصل على الكتاب على جهازك»</a>.</p>\n"
    + "<p><a href=\"" + esc(backToBook) + "\">← رجوع إلى البحث</a></p>\n";
  return page(bookTitle + " — " + chapter.title, body, 200);
}
