// Cloudflare Pages Function: plain-HTML in-browser reader (RliBook).
// Route: GET /read?lib=<slug>&id=<book id>&f=<fmt>&rtok=<reader token>
//        GET /read?lib=tg&h=<handle>&p=<post_id>&f=<fmt>&rtok=<token>
//
//   GET /read?lib=hindawi&id=13028368&f=epub&rtok=v1....
//     -> 200 text/html — chapter 1 as plain HTML, no download, no
//        file, no email, no Amazon involved. ?ch=N paginates by
//        chapter (EPUB), by PDF page (PDF) or by text page (TXT).
//
// Formats (v2): EPUB (server-side unzip + chapter pagination),
// PDF (minimal pure-JS text extractor — no dependency, see parsePdf)
// and TXT (plain text, paginated). MOBI/AZW3/KFX/DOC/DOCX are NOT
// readable here (see the honest 400 page + the workstream doc);
// the delivery page explains the USB/Calibre route for them.
//
// The reader is READING ONLY: it never shows a download button or a
// bare file URL. The book file is fetched server-side and the browser
// only ever sees one rendered unit (one chapter / one PDF page /
// one text page) as HTML. Anti-download layers (v2):
//   1. Reader token (?rtok=): HMAC-SHA256, 1 hour, single-book,
//      minted by /kindle/get or /api/read-token — no token, no
//      chapter. A token cannot download anything (its "k":"read"
//      field makes the download proxy reject it).
//   2. Paginated fragments only — one unit per response, and a
//      per-unit HTML cap (200 KB), so the whole book is never in
//      one response.
//   3. cache-control: no-store + CSP (no external loads except the
//      Google sign-in script, loaded only when the user taps sync)
//      + X-Robots-Tag: noindex + nosniff. No raw file URL anywhere.
//   Honest limit: these layers stop bulk extraction and casual
//   copying, not a determined reader — text on screen can always be
//   screenshotted or copied by hand. Selection is a feature, not a
//   hole: see below.
//
// Selection, notes & highlights (v2): the chapter page carries one
// small inline script (ES5, defensive — the page still reads with
// JS off). It gives: native text selection (mouse + touch
// long-press), a freehand mode (finger drag builds a selection via
// caretRangeFromPoint), highlights (4 colours) + notes, saved on
// the device in localStorage, an export of the USER's notes only
// (JSON + Markdown file download — the book content is never
// exported), and an optional Google Drive sync (Google Identity
// Services, drive.file scope, client ID from env
// GOOGLE_OAUTH_CLIENT_ID; empty = the button says it is not set
// up). Apple has no public web upload API and CloudKit JS needs a
// paid Apple Developer membership, so Apple users use the local
// file download (save it to iCloud Drive from the share sheet).
//
// Safety, same as the email endpoint: 25 MB cap, HTML content-type
// rejection (a Drive warning page is not a book), magic-bytes
// check per format, fetch failure -> 502. Chapter HTML is
// sanitised (script/style/iframe/object/form/embed stripped,
// event-handler attributes and javascript: links removed) — a book
// file is never executed, and the only <script> on the page is the
// reader's own.
//
// Free-tier friendly: one book fetch + CPU to unzip ONLY the one
// chapter/page being shown (parseEpubChapter for EPUB, parseBook
// per unit for PDF/TXT). The first version inflated, decoded and
// sanitised EVERY chapter on EVERY request — 105–200 ms CPU for a
// 150-chapter book against a 10 ms budget — which is the shape of
// a 1102. Zero D1 writes, no KV writes (one flag read for Telegram
// books, plus the token HMAC).

import { parseBookParams, isFlaggedBook, isHiddenBook, resolveOpdsAcquisitionUrl, verifyReaderToken, readerTokenOwn, makeReaderToken, READER_TOKEN_TTL_SECONDS } from "./api/dl-token.js";
import { magicBytesOk, proxyDownloadUrl } from "./api/send-to-kindle.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
// One rendered unit (chapter / PDF page / text page) is never
// served larger than this — a long chapter is cut at a paragraph
// boundary with a note, so no single response carries the book.
export const MAX_UNIT_HTML_CHARS = 200 * 1024;
// Formats the reader can open. Anything else -> honest 400.
export const READABLE_FORMATS = new Set(["epub", "pdf", "txt"]);

const CSS = "body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
  + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
  + "h1{font-size:1.4rem}a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;"
  + "margin:.3rem 0;border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;"
  + "font-weight:600}.note{color:#555;font-size:.9rem}"
  + ".nav{margin:1rem 0}.chapter{line-height:1.9}"
  + ".chapter p{margin:.6em 0}"
  + ".toolbar{border:1px solid #c9d6e3;border-radius:8px;padding:.6rem;margin:1rem 0;background:#f2f7fb}"
  + ".toolbar button{margin:.15rem;padding:.35rem .6rem;border-radius:6px;border:1px solid #0b5cad;"
  + "background:#fff;color:#0b5cad;font-weight:600;cursor:pointer}"
  + ".toolbar button[aria-pressed=\"true\"]{background:#0b5cad;color:#fff}"
  + ".toolbar .status{color:#555;font-size:.9rem;margin:.3rem 0 0}"
  + "mark.rlb-hl{padding:0 .1em;border-radius:2px}"
  + ".notes-list{list-style:none;padding:0}"
  + ".notes-list li{border-top:1px solid #ddd;padding:.4rem 0;font-size:.95rem}"
  + ".notes-list .hl-text{padding:0 .2em;border-radius:2px}"
  + ".notes-list button{margin:0 .2rem}";

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

// Security headers on every reader response: no-store (nothing is
// cached anywhere), a tight CSP (the only script allowed is the
// reader's own inline one, plus the Google sign-in script which
// loads only when the user taps Drive sync), noindex (a chapter
// page must never be indexed) and nosniff.
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' https://accounts.google.com; connect-src https://www.googleapis.com https://accounts.google.com; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function page(title, bodyHtml, status = 200) {
  return new Response("<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>" + CSS + "</style>\n</head>\n<body>\n"
    + "<h1>📚 RliBook</h1>\n" + bodyHtml + "\n</body></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
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

/** Parse only an EPUB's structure (container.xml + OPF): the book
 *  title and the ordered spine paths. Inflates nothing but the two
 *  small XML files, so this stays cheap even for a 500-chapter book.
 *  Returns { title, spine: [zipPath, ...], entries } or null when the
 *  file is not a readable EPUB. `entries` is the central-directory
 *  map, kept so callers can read one chapter without re-parsing it.
 *  Exported for tests. */
export async function parseEpubIndex(bytes) {
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
    if (!idref) continue;
    const item = manifest.get(idref);
    if (!item) continue;
    if (!/xhtml|xml/.test(item.mediaType)) continue;
    spine.push(resolveZipPath(base, decodeURIComponent(item.href)));
  }
  return { title, spine, entries };
}

/** Inflate, decode and sanitise ONE spine chapter. Exported for tests. */
async function readChapter(bytes, entries, path, fallbackNumber) {
  const entry = entries.get(path);
  if (!entry) return null;
  const chBytes = await readZipEntry(bytes, entry);
  if (!chBytes) return null;
  const xhtml = new TextDecoder().decode(chBytes);
  const title = chapterTitle(xhtml, "");
  return {
    title: title || "الفصل " + fallbackNumber,
    html: sanitizeChapterHtml(xhtml),
  };
}

/** Parse an EPUB's bytes into { title, chapters: [{ title, html }] }.
 *  Returns null when the file is not a readable EPUB (bad ZIP, no
 *  container.xml, no OPF, empty spine). Kept for compatibility and
 *  tests — the request path uses parseEpubChapter instead (one
 *  chapter per request). Exported for tests. */
export async function parseEpub(bytes) {
  const index = await parseEpubIndex(bytes);
  if (!index) return null;
  const chapters = [];
  for (const path of index.spine) {
    const ch = await readChapter(bytes, index.entries, path, chapters.length + 1);
    if (!ch) continue;
    chapters.push(ch);
  }
  if (!chapters.length) return null;
  return { title: index.title, chapters };
}

/** Parse ONE chapter of an EPUB (0-based index, clamped into range)
 *  and return { title, chapter: { title, html }, chapterNumber,
 *  totalChapters }, or null when the file is not a readable EPUB or
 *  the chapter cannot be read. ONLY the requested chapter is
 *  inflated, decoded and sanitised — inflating the whole book here
 *  cost 105–200 ms CPU for a 150-chapter book (measured locally,
 *  Node 24, vs ~0.7 ms for one chapter) against Cloudflare's 10 ms
 *  free-tier budget, i.e. the shape of an 1102 on any real book.
 *  Exported for tests. */
export async function parseEpubChapter(bytes, chapterIndex) {
  const index = await parseEpubIndex(bytes);
  if (!index || !index.spine.length) return null;
  const n = Number.isFinite(chapterIndex)
    ? Math.max(0, Math.min(index.spine.length - 1, Math.floor(chapterIndex)))
    : 0;
  const chapter = await readChapter(bytes, index.entries, index.spine[n], n + 1);
  if (!chapter) return null;
  return { title: index.title, chapter, chapterNumber: n + 1, totalChapters: index.spine.length };
}

// ---- minimal PDF text extractor -------------------------------------
// Pure JS, no dependency: a Worker has no pdftotext, and pdf.js
// would blow the free-tier bundle limit. It handles: classic xref
// (or an object scan when the xref is broken), FlateDecode +
// uncompressed streams, the Tj / TJ / ' / " text operators with a
// line-break heuristic (Td / TD / T* / Tm), WinAnsi / MacRoman /
// Standard encodings, /Differences, and /ToUnicode (bfchar /
// bfrange, 1- and 2-byte codes). It does NOT handle: xref streams
// (the object scan still finds the objects), LZW / ASCII85 /
// JBIG2 streams, Type0/CID fonts without a ToUnicode map, or
// encrypted files (those return null — an honest "cannot read").
// A page whose text cannot be extracted keeps its place with a
// one-line note, so pagination never shifts. Text is ALWAYS
// escaped before it becomes HTML — PDF content is untrusted.

function latin1(bytes) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function pdfSkipWs(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0") { i++; continue; }
    if (c === "%") { while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    break;
  }
  return i;
}

/** Tiny PDF value parser. Values are tagged so the caller can tell
 *  them apart: { dict }, { arr }, { name }, { str, hex? },
 *  { ref, gen }, numbers, booleans, null. Exported for tests. */
export function pdfParseValue(s, i) {
  i = pdfSkipWs(s, i);
  if (i >= s.length) return { value: null, next: i };
  const c = s[i];
  if (c === "<" && s[i + 1] === "<") {
    i += 2;
    const dict = {};
    while (true) {
      i = pdfSkipWs(s, i);
      if (s[i] === ">" && s[i + 1] === ">") { i += 2; break; }
      if (i >= s.length) break;
      if (s[i] !== "/") { i++; continue; }
      const keyRes = pdfParseValue(s, i);
      const key = keyRes.value && keyRes.value.name;
      if (!key) { i = keyRes.next; continue; }
      const valRes = pdfParseValue(s, keyRes.next);
      dict[key] = valRes.value;
      i = valRes.next;
    }
    return { value: { dict }, next: i };
  }
  if (c === "[") {
    i++;
    const arr = [];
    while (true) {
      i = pdfSkipWs(s, i);
      if (s[i] === "]") { i++; break; }
      if (i >= s.length) break;
      const r = pdfParseValue(s, i);
      arr.push(r.value);
      i = r.next;
    }
    return { value: { arr }, next: i };
  }
  if (c === "/") {
    let j = i + 1;
    while (j < s.length && !/[\s\[\]()<>/%]/.test(s[j])) j++;
    return { value: { name: s.slice(i + 1, j) }, next: j };
  }
  if (c === "(") {
    let j = i + 1;
    let depth = 1;
    let out = "";
    while (j < s.length && depth > 0) {
      const ch = s[j];
      if (ch === "\\") {
        const n = s[j + 1];
        if (n === "n") { out += "\n"; j += 2; }
        else if (n === "r") { out += "\r"; j += 2; }
        else if (n === "t") { out += "\t"; j += 2; }
        else if (n === "b") { out += "\b"; j += 2; }
        else if (n === "f") { out += "\f"; j += 2; }
        else if (n === "(" || n === ")" || n === "\\") { out += n; j += 2; }
        else if (n >= "0" && n <= "7") {
          let oct = "";
          let k = j + 1;
          while (k < s.length && oct.length < 3 && s[k] >= "0" && s[k] <= "7") { oct += s[k]; k++; }
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          j = k;
        } else if (n === "\r" || n === "\n") { j += (n === "\r" && s[j + 2] === "\n") ? 3 : 2; }
        else { out += n || ""; j += 2; }
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { j++; break; } }
      if (depth > 0) out += ch;
      j++;
    }
    return { value: { str: out }, next: j };
  }
  if (c === "<") {
    let j = i + 1;
    let hex = "";
    while (j < s.length && s[j] !== ">") { if (!/\s/.test(s[j])) hex += s[j]; j++; }
    if (hex.length % 2) hex += "0";
    let out = "";
    for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
    return { value: { str: out, hex: true }, next: j + 1 };
  }
  const m = /^(true|false|null|-?\d+(?:\.\d+)?)/.exec(s.slice(i, i + 32));
  if (m) {
    const tok = m[1];
    const j = i + tok.length;
    if (/^-?\d+$/.test(tok)) {
      const m2 = /^(\s+)(\d+)\s+R/.exec(s.slice(j, j + 24));
      if (m2) return { value: { ref: Number(tok), gen: Number(m2[2]) }, next: j + m2[0].length };
      return { value: Number(tok), next: j };
    }
    if (/^-?\d+\.\d+$/.test(tok)) return { value: Number(tok), next: j };
    return { value: tok === "true" ? true : tok === "false" ? false : null, next: j };
  }
  const w = /^[A-Za-z]+/.exec(s.slice(i, i + 24));
  if (w) return { value: { keyword: w[0] }, next: i + w[0].length };
  return { value: null, next: i + 1 };
}

/** Scan every `N G obj ... endobj` in the file. A stream's bytes
 *  are skipped by /Length (when it is a direct number) so a literal
 *  "endobj" inside binary data cannot end the object early; an
 *  indirect /Length (`/Length 3 0 R`, as LibreOffice writes) is
 *  resolved in a second pass once every object is known.
 *  Returns { text, objs } with objs: num -> { body, streamStart,
 *  streamEnd } (stream offsets are byte offsets into `bytes`, or
 *  -1 when the object has no stream). Exported for tests. */
export function pdfObjects(bytes) {
  const s = latin1(bytes);
  const objs = new Map();
  // The leading (^|[^\d]) matters: without it, "123 0 obj" also
  // matches as a phantom "23 0 obj" and overwrites the real
  // object 23 (a real bug, found on a LibreOffice PDF).
  const re = /(^|[^\d])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = Number(m[2]);
    const start = re.lastIndex;
    let end = s.indexOf("endobj", start);
    if (end < 0) break;
    const head = s.slice(start, Math.min(start + 4096, end));
    // Direct /Length only: an indirect `/Length 3 0 R` must NOT
    // match. The (?!\d) is load-bearing — without it, (\d+) can
    // backtrack and match the "2" of "24" in `/Length 24 0 R`,
    // which silently truncates the stream (a real bug, found on a
    // LibreOffice PDF whose lengths are indirect).
    const lm = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(head);
    const sm = /stream\r?\n/.exec(head);
    if (lm && sm) {
      const dataStart = start + sm.index + sm[0].length;
      const end2 = s.indexOf("endobj", dataStart + Number(lm[1]));
      if (end2 >= 0) end = end2;
    }
    const body = s.slice(start, end);
    let streamStart = -1;
    let streamEnd = -1;
    let lengthRef = -1;
    const sm2 = /stream(\r\n|\n|\r)/.exec(body);
    if (sm2) {
      streamStart = start + sm2.index + sm2[0].length;
      const lm2 = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(body.slice(0, sm2.index));
      if (lm2) {
        streamEnd = streamStart + Number(lm2[1]);
      } else {
        const lr = /\/Length\s+(\d+)\s+\d+\s+R/.exec(body.slice(0, sm2.index));
        if (lr) lengthRef = Number(lr[1]);
        const es = s.indexOf("endstream", streamStart);
        streamEnd = es >= 0 ? es : end;
      }
    }
    objs.set(num, { body, streamStart, streamEnd, lengthRef });
    re.lastIndex = end + 6;
  }
  // Second pass: resolve indirect /Length references (the length
  // object is usually a bare number) and re-slice the stream bounds.
  for (const [, obj] of objs) {
    if (obj.lengthRef < 0 || obj.streamStart < 0) continue;
    const lenObj = objs.get(obj.lengthRef);
    if (!lenObj) continue;
    const lenMatch = /(-?\d+)/.exec(lenObj.body);
    if (!lenMatch) continue;
    const len = Number(lenMatch[1]);
    if (Number.isFinite(len) && len >= 0 && obj.streamStart + len <= bytes.length) {
      obj.streamEnd = obj.streamStart + len;
    }
  }
  return { text: s, objs };
}

async function inflateBytes(bytes) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const out = await new Response(
        new Blob([bytes]).stream().pipeThrough(ds),
      ).arrayBuffer();
      return new Uint8Array(out);
    } catch { /* try the other flavour */ }
  }
  return null;
}

/** Decoded bytes of a stream object, or null when the filter is
 *  unsupported (LZW / ASCII85 / JBIG2 / ...) or the inflate fails.
 *  `bytes` is the whole file; the object's stream bounds come from
 *  pdfObjects. Exported for tests. */
export async function pdfStreamBytes(obj, bytes) {
  if (!obj || obj.streamStart < 0 || obj.streamEnd < obj.streamStart) return null;
  const raw = bytes.subarray(obj.streamStart, Math.min(obj.streamEnd, bytes.length));
  const dictRes = pdfParseValue(obj.body, 0);
  const dict = dictRes.value && dictRes.value.dict;
  if (!dict) return raw;
  const filter = dict["Filter"];
  const names = [];
  if (filter && filter.name) names.push(filter.name);
  else if (filter && filter.arr) {
    for (const f of filter.arr) if (f && f.name) names.push(f.name);
  }
  if (!names.length) return raw;
  if (names.length === 1 && names[0] === "FlateDecode") {
    const out = await inflateBytes(raw);
    if (out) return out;
    // No usable /Length (an indirect reference we could not
    // resolve): the slice runs to "endstream" and includes the EOL
    // before it, which DecompressionStream rejects as trailing
    // junk. Retry with the trailing EOL stripped.
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--;
    if (end < raw.length) return inflateBytes(raw.subarray(0, end));
    return null;
  }
  return null;
}

async function pdfStreamText(obj, bytes) {
  const data = await pdfStreamBytes(obj, bytes);
  return data ? latin1(data) : null;
}

// ---- font decoding --------------------------------------------------
// Windows-1252 high half (0x80-0x9F); the rest of WinAnsi is Latin-1.
const WINANSI_HIGH = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡",
  136: "ˆ", 137: "‰", 138: "Š", 139: "‹", 140: "Œ", 142: "Ž", 145: "‘",
  146: "’", 147: "“", 148: "”", 149: "•", 150: "–", 151: "—", 152: "˜",
  153: "™", 154: "š", 155: "›", 156: "œ", 158: "ž", 159: "Ÿ",
};
// MacRoman high half (0x80-0xFF), in order.
const MACROMAN_HIGH = ("ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø"
  + "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ").split("");
// Adobe StandardEncoding high half: only the defined codes.
const STANDARD_HIGH = {
  161: "exclamdown", 162: "cent", 163: "sterling", 164: "fraction", 165: "yen",
  166: "florin", 167: "section", 168: "currency", 169: "quotesingle",
  170: "quotedblleft", 171: "guillemotleft", 172: "guilsinglleft",
  173: "guilsinglright", 174: "fi", 175: "fl", 177: "endash", 178: "dagger",
  179: "daggerdbl", 180: "periodcentered", 182: "paragraph", 183: "bullet",
  184: "quotesinglbase", 185: "quotedblbase", 186: "quotedblright",
  187: "guillemotright", 188: "ellipsis", 189: "perthousand",
  191: "questiondown", 193: "grave", 194: "acute", 195: "circumflex",
  196: "tilde", 197: "macron", 198: "breve", 199: "dotaccent",
  200: "dieresis", 202: "ring", 203: "cedilla", 204: "hungarumlaut",
  205: "ogonek", 206: "caron", 207: "emdash", 225: "AE", 227: "ordfeminine",
  232: "Lslash", 233: "Oslash", 234: "OE", 235: "ordmasculine", 241: "ae",
  245: "dotlessi", 248: "lslash", 249: "oslash", 250: "oe", 251: "germandbls",
};
// Adobe Glyph List subset — the names a /Differences array or a
// StandardEncoding table actually uses. Single letters and digit
// names fall through to the generic rules below.
const AGL = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$",
  percent: "%", ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")",
  asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?",
  at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^",
  underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}",
  asciitilde: "~", endash: "–", emdash: "—", quoteleft: "‘", quoteright: "’",
  quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„",
  dagger: "†", daggerdbl: "‡", bullet: "•", ellipsis: "…", perthousand: "‰",
  guilsinglleft: "‹", guilsinglright: "›", guillemotleft: "«", guillemotright: "»",
  fi: "fi", fl: "fl", ffi: "ffi", ffl: "ffl", Euro: "€", sterling: "£", yen: "¥",
  currency: "¤", cent: "¢", brokenbar: "¦", dieresis: "¨", copyright: "©",
  ordfeminine: "ª", logicalnot: "¬", registered: "®", macron: "¯", degree: "°",
  plusminus: "±", acute: "´", mu: "µ", paragraph: "¶", periodcentered: "·",
  cedilla: "¸", ordmasculine: "º", questiondown: "¿", exclamdown: "¡",
  fraction: "⁄", florin: "ƒ", section: "§", germandbls: "ß", dotlessi: "ı",
  AE: "Æ", ae: "æ", OE: "Œ", oe: "œ", Oslash: "Ø", oslash: "ø", Lslash: "Ł",
  lslash: "ł", circumflex: "ˆ", tilde: "˜", breve: "˘", dotaccent: "˙",
  ring: "˚", hungarumlaut: "˝", ogonek: "˛", caron: "ˇ",
};
const DIGIT_NAMES = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

export function glyphToUnicode(name) {
  if (AGL[name] !== undefined) return AGL[name];
  if (DIGIT_NAMES[name] !== undefined) return DIGIT_NAMES[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  return "";
}

function encodingTable(baseName) {
  const table = new Array(256).fill("");
  for (let i = 0; i < 128; i++) table[i] = String.fromCharCode(i);
  if (baseName === "WinAnsiEncoding") {
    for (let i = 128; i < 160; i++) table[i] = WINANSI_HIGH[i] || "";
    for (let i = 160; i < 256; i++) table[i] = String.fromCharCode(i);
  } else if (baseName === "MacRomanEncoding") {
    for (let i = 0; i < 128; i++) table[i] = MACROMAN_HIGH[i] || "";
  } else if (baseName === "StandardEncoding") {
    for (const code of Object.keys(STANDARD_HIGH)) {
      table[Number(code)] = glyphToUnicode(STANDARD_HIGH[code]);
    }
  }
  return table;
}

function parseDifferences(encDict) {
  const diff = encDict["Differences"];
  if (!diff || !diff.arr) return null;
  const map = new Map();
  let code = 0;
  for (const v of diff.arr) {
    if (typeof v === "number") code = v;
    else if (v && v.name) { map.set(code, glyphToUnicode(v.name)); code++; }
  }
  return map;
}

function parseToUnicode(text) {
  const map = new Map();
  let twoByte = false;
  // A lam-alef ligature (one source code -> lam + alef, two
  // characters) is stored as the single presentation-form character
  // instead (U+FEFB etc.): the bidi reorder reverses characters,
  // and a two-character ligature would come out swapped
  // ("للاختبار" -> "لالختبار"). The presentation form renders
  // identically and keeps one code == one character.
  const ligature = (dst) => {
    if (dst === "لا") return "ﻻ";
    if (dst === "لآ") return "ﻵ";
    if (dst === "لأ") return "ﻷ";
    if (dst === "لإ") return "ﻹ";
    return dst;
  };
  const uni = (hex) => {
    let out = "";
    if (hex.length >= 4 && hex.length % 4 === 0) {
      for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    } else {
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return ligature(out);
  };
  let m;
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(text)) !== null) {
    const lineRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g;
    let l;
    while ((l = lineRe.exec(m[1])) !== null) {
      if (l[1].length === 4) twoByte = true;
      map.set(parseInt(l[1], 16), uni(l[2]));
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text)) !== null) {
    const lineRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
    let l;
    while ((l = lineRe.exec(m[1])) !== null) {
      const lo = parseInt(l[1], 16);
      const hi = parseInt(l[2], 16);
      if (l[1].length === 4) twoByte = true;
      if (l[3] !== undefined) {
        const base = parseInt(l[3], 16);
        for (let c = lo; c <= hi && c - lo < 512; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else if (l[4] !== undefined) {
        const arr = [...l[4].matchAll(/<([0-9A-Fa-f]+)>/g)];
        arr.forEach((a, idx) => map.set(lo + idx, uni(a[1])));
      }
    }
  }
  return { map, twoByte };
}

/** Decoder for one font: { twoByte, decode(latin1String) }.
 *  ToUnicode wins when present; otherwise the declared encoding
 *  (WinAnsi by default) plus /Differences. Exported for tests. */
export async function pdfFontDecoder(fontDict, objs, bytes) {
  const tu = fontDict["ToUnicode"];
  if (tu && tu.ref !== undefined) {
    const obj = objs.get(tu.ref);
    if (obj) {
      const text = await pdfStreamText(obj, bytes);
      if (text) {
        const parsed = parseToUnicode(text);
        if (parsed.map.size) {
          const { map, twoByte } = parsed;
          return {
            twoByte,
            decode: (s) => {
              let out = "";
              if (twoByte) {
                for (let i = 0; i + 1 < s.length; i += 2) {
                  out += map.get((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)) || "";
                }
              } else {
                for (let i = 0; i < s.length; i++) out += map.get(s.charCodeAt(i)) || "";
              }
              return out;
            },
          };
        }
      }
    }
  }
  const enc = fontDict["Encoding"];
  let baseName = "WinAnsiEncoding";
  let diffMap = null;
  if (enc) {
    if (enc.name) baseName = enc.name;
    else if (enc.dict) {
      if (enc.dict["BaseEncoding"] && enc.dict["BaseEncoding"].name) baseName = enc.dict["BaseEncoding"].name;
      diffMap = parseDifferences(enc.dict);
    }
  }
  const table = encodingTable(baseName);
  if (diffMap) for (const [c, ch] of diffMap) table[c] = ch;
  return {
    twoByte: false,
    decode: (s) => {
      let out = "";
      for (let i = 0; i < s.length; i++) out += table[s.charCodeAt(i)] || "";
      return out;
    },
  };
}

// ---- PDF content-stream text ----------------------------------------
// Tokeniser for a decoded content stream: literal/hex strings,
// names, numbers, operators (incl. ' " T*) and TJ arrays.
function pdfContentTokens(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "%") { while (i < n && s[i] !== "\n") i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0") { i++; continue; }
    if (c === "(" || (c === "<" && s[i + 1] !== "<")) {
      const r = pdfParseValue(s, i);
      tokens.push({ t: "str", v: r.value ? r.value.str : "" });
      i = r.next;
      continue;
    }
    if (c === "[") {
      const arr = [];
      i++;
      while (i < n) {
        const ch = s[i];
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
        if (ch === "]") { i++; break; }
        if (ch === "(" || (ch === "<" && s[i + 1] !== "<")) {
          const r = pdfParseValue(s, i);
          arr.push({ t: "str", v: r.value ? r.value.str : "" });
          i = r.next;
          continue;
        }
        const m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i, i + 24));
        if (m) { arr.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
        i++;
      }
      tokens.push({ t: "arr", v: arr });
      continue;
    }
    if (c === "/") {
      const m = /^\/([^\s\[\]()<>/%]+)/.exec(s.slice(i, i + 64));
      if (m) { tokens.push({ t: "name", v: m[1] }); i += m[0].length; continue; }
      i++;
      continue;
    }
    const m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i, i + 24));
    if (m) { tokens.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
    const w = /^[A-Za-z'\"*]+/.exec(s.slice(i, i + 16));
    if (w) { tokens.push({ t: "op", v: w[0] }); i += w[0].length; continue; }
    i++;
  }
  return tokens;
}

/** Plain text of one decoded content stream. `getDecoder(name)` is
 *  called for Tf (returns the font's decoder, or a default). The
 *  line-break rules are heuristic: Td/TD with a vertical move, T*,
 *  Tm with a changed baseline, and ' / " all start a new line; a
 *  large negative TJ kern inserts a space. Exported for tests. */
export function pdfTextFromTokens(tokens, getDecoder) {
  let out = "";
  const stack = [];
  let font = null;
  let curY = null;
  const pushText = (str) => { out += font ? font.decode(str) : str; };
  const lastStr = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].t === "str") return stack[k].v;
    return null;
  };
  for (const tok of tokens) {
    if (tok.t !== "op") {
      stack.push(tok);
      if (stack.length > 10) stack.shift();
      continue;
    }
    const op = tok.v;
    if (op === "Tf") {
      let name = null;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].t === "name") { name = stack[k].v; break; }
      }
      if (name) font = getDecoder(name);
    } else if (op === "Tj") {
      const s = lastStr();
      if (s !== null) pushText(s);
    } else if (op === "TJ") {
      let arr = null;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].t === "arr") { arr = stack[k].v; break; }
      }
      if (arr) {
        for (const it of arr) {
          if (it.t === "str") pushText(it.v);
          else if (it.t === "num" && it.v < -100) out += " ";
        }
      }
    } else if (op === "'") {
      out += "\n";
      const s = lastStr();
      if (s !== null) pushText(s);
    } else if (op === '"') {
      out += "\n";
      const s = lastStr();
      if (s !== null) pushText(s);
    } else if (op === "Td" || op === "TD") {
      const nums = stack.filter((t) => t.t === "num").map((t) => t.v);
      if (nums.length >= 2) {
        if (nums[1] !== 0) { out += "\n"; curY = curY === null ? nums[1] : curY + nums[1]; }
        else if (nums[0] !== 0) out += " ";
      }
    } else if (op === "T*") {
      out += "\n";
    } else if (op === "Tm") {
      const nums = stack.filter((t) => t.t === "num").map((t) => t.v);
      if (nums.length >= 6) {
        const y = nums[5];
        if (curY !== null && Math.abs(y - curY) > 0.5) out += "\n";
        curY = y;
      }
    }
    stack.length = 0;
  }
  return out;
}

function pdfTextToHtml(text) {
  const paras = [];
  let cur = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (!t) {
      if (cur.length) { paras.push(cur.join(" ")); cur = []; }
      continue;
    }
    cur.push(t);
  }
  if (cur.length) paras.push(cur.join(" "));
  if (!paras.length) return "";
  return paras.map((p) => "<p>" + esc(p) + "</p>").join("\n");
}

// ---- RTL (bidi) reorder for PDF text --------------------------------
// PDF text has no direction metadata: some producers store Arabic
// in LOGICAL order (InDesign / TeX / most publishers — reads
// correctly as extracted) and others in VISUAL order (LibreOffice
// and some Word exports — each display line is stored left-to-right
// as it appears, so Arabic words come out letter-reversed).
// Reordering blindly would break the logical case, so the decision
// is made per DOCUMENT (one file comes from one producer): the
// document is visual-order when its words start with ة/ى (teh
// marbuta / alef maksura — letters that end Arabic words and
// essentially never start one) more often than they end with them.
// A visual document's RTL lines are then reordered (UBA-lite:
// reverse the order of direction runs and the characters inside
// RTL runs; numbers and Latin runs keep their internal order).
// A line with no signal of its own is still reordered when its
// document is visual (a heading like "الفصل الثاني" has no ة/ى).
// A logical document is never touched. Exported for tests.
export function bidiVisualStats(text) {
  let startsFinal = 0;
  let endsFinal = 0;
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    const letters = [...w].filter((c) => bidiClass(c) === "R");
    if (!letters.length) continue;
    if (letters[0] === "ة" || letters[0] === "ى") startsFinal++;
    const last = letters[letters.length - 1];
    if (last === "ة" || last === "ى") endsFinal++;
  }
  return { startsFinal, endsFinal };
}

export function reorderBidiLine(line, force = false) {
  const chars = [...line];
  let firstStrong = null;
  for (const ch of chars) {
    const k = bidiClass(ch);
    if (k === "R" || k === "L") { firstStrong = k; break; }
  }
  if (firstStrong !== "R") return line;
  if (!force) {
    const { startsFinal, endsFinal } = bidiVisualStats(line);
    if (startsFinal === 0 || startsFinal <= endsFinal) return line;
  }
  // Visual order confirmed: reorder the direction runs.
  const runs = [];
  for (const ch of chars) {
    const k = bidiClass(ch);
    const lvl = k === "R" ? 1 : 2;
    if (runs.length && runs[runs.length - 1].lvl === lvl && k !== "N") {
      runs[runs.length - 1].text += ch;
    } else if (runs.length && k === "N") {
      runs[runs.length - 1].text += ch;
    } else {
      runs.push({ lvl, text: ch });
    }
  }
  const out = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    out.push(r.lvl === 1 ? [...r.text].reverse().join("") : r.text);
  }
  return out.join("");
}

function bidiClass(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 0x0590 && c <= 0x05ff) || (c >= 0x0600 && c <= 0x06ff)
    || (c >= 0x0750 && c <= 0x077f) || (c >= 0x08a0 && c <= 0x08ff)
    || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return "R";
  if ((c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a)
    || (c >= 0x00c0 && c <= 0x024f)) return "L";
  if (c >= 0x0030 && c <= 0x0039) return "EN";
  if (c >= 0x0660 && c <= 0x0669) return "AN";
  return "N";
}

function pdfStringToUnicode(v) {
  if (!v || typeof v.str !== "string") return "";
  const s = v.str;
  if (s.length >= 2 && s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < s.length; i += 2) {
      out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    }
    return out;
  }
  return s;
}

/** Parse a PDF's bytes into { title, pages: [{ title, html }] } —
 *  the same shape as parseEpub, so the renderer is shared (one
 *  PDF page = one reader unit). Returns null when the file is not
 *  a readable PDF (bad header, encrypted, no pages, or no page
 *  yields any text). Exported for tests. */
export async function parsePdf(bytes) {
  if (!bytes || bytes.length < 5) return null;
  if (latin1(bytes.subarray(0, 5)) !== "%PDF-") return null;
  const { text, objs } = pdfObjects(bytes);
  if (!objs.size) return null;
  if (/\/Encrypt\s/.test(text)) return null;

  // Document title: the first /Title string in any object.
  let title = "";
  for (const [, obj] of objs) {
    const m = /\/Title\s*(\((?:[^()\\]|\\.)*\)|<[^>]*>)/.exec(obj.body);
    if (m) {
      const v = pdfParseValue(m[1], 0).value;
      title = pdfStringToUnicode(v).trim().slice(0, 200);
      if (title) break;
    }
  }

  // Page tree: walk /Pages -> /Kids in order; fall back to any
  // /Type /Page object in file order.
  const pageList = [];
  const seen = new Set();
  const walk = (num) => {
    if (seen.has(num)) return;
    const obj = objs.get(num);
    if (!obj) return;
    seen.add(num);
    const parsed = pdfParseValue(obj.body, 0);
    const d = parsed.value && parsed.value.dict;
    if (!d) return;
    const type = d["Type"] && d["Type"].name;
    if (type === "Page") { pageList.push({ ref: num, dict: d }); return; }
    if (type === "Pages" && d["Kids"] && d["Kids"].arr) {
      for (const k of d["Kids"].arr) if (k && k.ref !== undefined) walk(k.ref);
    }
  };
  for (const [num, obj] of objs) {
    const parsed = pdfParseValue(obj.body, 0);
    const d = parsed.value && parsed.value.dict;
    if (d && d["Type"] && d["Type"].name === "Pages") walk(num);
  }
  if (!pageList.length) {
    for (const [num, obj] of objs) {
      const parsed = pdfParseValue(obj.body, 0);
      const d = parsed.value && parsed.value.dict;
      if (d && d["Type"] && d["Type"].name === "Page") pageList.push({ ref: num, dict: d });
    }
  }
  if (!pageList.length) return null;

  // Fonts: merged from every /Resources in the file (font names
  // are file-global in practice; a page inherits its parent's
  // resources, which this merge approximates).
  const fontDicts = new Map();
  const collectFonts = (resValue) => {
    if (!resValue) return;
    let res = resValue;
    if (res.ref !== undefined) {
      const o = objs.get(res.ref);
      if (!o) return;
      const p = pdfParseValue(o.body, 0);
      res = p.value;
    }
    if (!res || !res.dict) return;
    const font = res.dict["Font"];
    if (!font) return;
    let fontDict = font;
    if (font.ref !== undefined) {
      const o = objs.get(font.ref);
      if (!o) return;
      const p = pdfParseValue(o.body, 0);
      fontDict = p.value;
    }
    if (!fontDict || !fontDict.dict) return;
    for (const name of Object.keys(fontDict.dict)) {
      const entry = fontDict.dict[name];
      if (!entry) continue;
      let fd = entry;
      if (entry.ref !== undefined) {
        const o = objs.get(entry.ref);
        if (!o) continue;
        const p = pdfParseValue(o.body, 0);
        fd = p.value;
      }
      if (fd && fd.dict) fontDicts.set(name, fd.dict);
    }
  };
  for (const [, obj] of objs) {
    const parsed = pdfParseValue(obj.body, 0);
    const d = parsed.value && parsed.value.dict;
    if (d && d["Resources"]) collectFonts(d["Resources"]);
  }
  const decoderCache = new Map();
  const defaultDecoder = {
    twoByte: false,
    decode: (s) => {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += c < 128 ? s[i] : (WINANSI_HIGH[c] || String.fromCharCode(c));
      }
      return out;
    },
  };
  // Decoders are async (a ToUnicode stream may need inflate), so
  // they are built once up front (a book has few fonts) and the
  // synchronous token walk below uses the resolved map.
  const resolvedDecoders = new Map();
  for (const name of fontDicts.keys()) {
    if (!decoderCache.has(name)) {
      decoderCache.set(name, await pdfFontDecoder(fontDicts.get(name), objs, bytes));
    }
    resolvedDecoders.set(name, decoderCache.get(name));
  }
  const finalGetDecoder = (name) => resolvedDecoders.get(name) || defaultDecoder;

  const pageTexts = [];
  for (const pg of pageList) {
    const contents = pg.dict["Contents"];
    const refs = [];
    if (contents) {
      if (contents.ref !== undefined) refs.push(contents.ref);
      else if (contents.arr) {
        for (const c of contents.arr) if (c && c.ref !== undefined) refs.push(c.ref);
      }
    }
    let pageText = "";
    for (const ref of refs) {
      const obj = objs.get(ref);
      if (!obj) continue;
      const data = await pdfStreamBytes(obj, bytes);
      if (!data) continue;
      const tokens = pdfContentTokens(latin1(data));
      pageText += pdfTextFromTokens(tokens, finalGetDecoder);
    }
    pageTexts.push(pageText);
  }
  if (!pageTexts.some((t) => t.trim())) return null;
  // RTL direction is decided per DOCUMENT (one file, one producer):
  // a visual-order document's RTL lines are reordered to logical
  // order; a logical-order document is never touched.
  const stats = bidiVisualStats(pageTexts.join("\n"));
  const visualRTL = stats.startsFinal > 0 && stats.startsFinal > stats.endsFinal;
  const orderedTexts = visualRTL
    ? pageTexts.map((t) => t.split("\n").map((l) => reorderBidiLine(l, true)).join("\n"))
    : pageTexts;
  const pages = orderedTexts.map((text, i) => {
    const html = pdfTextToHtml(text);
    return {
      title: "صفحة " + (i + 1),
      html: html || "<p class=\"note\">هذه الصفحة بلا نص قابل للاستخراج — قد تكون صورة ممسوحة ضوئياً.</p>",
    };
  });
  if (!title) {
    // The first non-empty line of the first page — not the
    // paragraph-joined text, which would swallow the whole page.
    const firstLine = (orderedTexts[0] || "").split(/\r\n|\r|\n/).find((l) => l.trim()) || "";
    title = firstLine.trim().slice(0, 120);
  }
  return { title, pages };
}

// ---- TXT ------------------------------------------------------------
// Plain text, paginated at paragraph boundaries (~6,000 chars a
// page). The first non-empty line is the title. Invalid UTF-8
// bytes become replacement characters rather than failing.
export function parseTxt(bytes) {
  if (!bytes || !bytes.length) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  if (!text.trim()) return null;
  const lines = text.split(/\r\n|\r|\n/);
  const title = (lines.find((l) => l.trim()) || "").trim().slice(0, 120) || "كتاب نصي";
  const rawPages = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur.length + p.length + 2 > 6000 && cur) { rawPages.push(cur); cur = p; }
    else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) rawPages.push(cur);
  const units = [];
  for (const pg of rawPages) {
    if (pg.length <= 8000) { units.push(pg); continue; }
    for (let i = 0; i < pg.length; i += 6000) units.push(pg.slice(i, i + 6000));
  }
  if (!units.length) return null;
  return {
    title,
    pages: units.map((u, i) => ({
      title: "صفحة " + (i + 1),
      html: u.split(/\n/).map((l) => (l.trim() ? "<p>" + esc(l.trim()) + "</p>" : "")).join("\n")
        || "<p class=\"note\">صفحة فارغة.</p>",
    })),
  };
}

/** Parse any readable format into the shared shape
 *  { title, units: [{ title, html }] } — EPUB chapters, PDF pages
 *  or TXT pages. Returns null for an unreadable file. */
export async function parseBook(bytes, fmt) {
  if (fmt === "epub") {
    const epub = await parseEpub(bytes);
    return epub ? { title: epub.title, units: epub.chapters } : null;
  }
  if (fmt === "pdf") {
    const pdf = await parsePdf(bytes);
    return pdf ? { title: pdf.title, units: pdf.pages } : null;
  }
  if (fmt === "txt") {
    const txt = parseTxt(bytes);
    return txt ? { title: txt.title, units: txt.pages } : null;
  }
  return null;
}

// ---- notes & highlights: the user's own data -----------------------
// The storage key for one book's notes/highlights (localStorage on
// the device). It is a HASH of the book identity, not the identity
// itself: for DOAB books the id IS the file URL, and the reader
// must never publish a bare file URL — not even inside a
// localStorage key in the page source. FNV-1a, the same short hash
// the site reader uses for its book keys. Exported for tests.
export function notesStorageKey(book) {
  const id = book.kind === "tg"
    ? "tg:" + book.handle + ":" + book.postId
    : book.lib + ":" + book.id;
  const s = id + ":" + book.fmt;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return "rlibook-reader-notes:b" + ("0000000" + h.toString(16)).slice(-8);
}

/** Build the notes/highlights export — the USER's data only (their
 *  selected quotes, colours, notes, unit numbers, timestamps).
 *  The book content is never exported: only the short quoted
 *  selection the user highlighted, exactly like a Kindle
 *  "My Clippings" file. Returns { json, markdown, jsonFilename,
 *  mdFilename, count }. `meta` is { title, bookKey, format } and
 *  `items` are [{ text, color, note, unit, createdAt }]. The
 *  client script in this file builds the same shape in the browser;
 *  keep the field names in sync. Exported for tests. */
export function buildNotesExport(meta, items) {
  const clean = (items || []).filter((h) => h && typeof h.text === "string" && h.text.trim());
  const exportedAt = new Date().toISOString();
  const doc = {
    app: "RliBook",
    version: 1,
    kind: "notes",
    book: { title: meta.title || "", key: meta.bookKey || "", format: meta.format || "" },
    exportedAt,
    count: clean.length,
    items: clean.map((h) => ({
      text: h.text,
      color: h.color || "yellow",
      note: h.note || "",
      unit: Number(h.unit) || 1,
      createdAt: h.createdAt || exportedAt,
    })),
  };
  const json = JSON.stringify(doc, null, 2);
  const lines = [
    "# ملاحظاتي وتمييزاتي — " + (meta.title || "كتاب"),
    "",
    "صُدّرت من RliBook في " + exportedAt,
    "",
  ];
  for (const h of doc.items) {
    lines.push("> " + h.text);
    if (h.note) lines.push("", "ملاحظة: " + h.note);
    lines.push("", "— الفصل/الصفحة " + h.unit + " · " + h.color, "");
  }
  const markdown = lines.join("\n");
  const stem = (meta.title || "rlibook-notes")
    .replace(/[\x00-\x1f\x7f]/g, "").replace(/["/\\:;<>?*|]/g, "")
    .replace(/\s+/g, " ").trim().replace(/ /g, "_").slice(0, 80)
    || "rlibook-notes";
  return { json, markdown, jsonFilename: stem + "_notes.json", mdFilename: stem + "_notes.md", count: clean.length };
}

// ---- the reader's own client script ---------------------------------
// One small inline script (ES5 on purpose — the Kindle browser is
// old; every modern API is feature-checked and the page still reads
// with JS off). It does ONLY: selection (native + freehand),
// highlights + notes in localStorage, notes export (local file),
// and Google Drive sync (GIS loads only on tap). It never fetches
// the book, never shows a download button, and never sends the
// book content anywhere — only the user's notes file.
// Placeholders __BOOK_KEY__, __UNIT__, __BOOK_TITLE__, __FORMAT__
// and __GOOGLE_CLIENT_ID__ are replaced server-side with
// JSON-encoded values. Exported so tests can syntax-check it.
export const CLIENT_SCRIPT = "(function(){\n"
  + "var chapter=document.getElementById('rlb-chapter');\n"
  + "if(!chapter)return;\n"
  + "var BOOK_KEY=__BOOK_KEY__;\n"
  + "var UNIT=__UNIT__;\n"
  + "var BOOK_TITLE=__BOOK_TITLE__;\n"
  + "var FORMAT=__FORMAT__;\n"
  + "var GOOGLE_CLIENT_ID=__GOOGLE_CLIENT_ID__;\n"
  + "var LS_KEY='rlibook-reader-notes:'+BOOK_KEY;\n"
  + "var COLORS={yellow:'#FFE066',green:'#B7E4C7',blue:'#A8D8EA',pink:'#FFC8DD'};\n"
  + "var selectedColor='yellow';\n"
  + "var pendingRange=null,pendingText='';\n"
  + "var freehand=false,anchorRange=null;\n"
  + "function $(id){return document.getElementById(id);}\n"
  + "function status(msg){var el=$('rlb-status');if(el)el.textContent=msg;}\n"
  + "function loadItems(){try{var raw=window.localStorage.getItem(LS_KEY);return raw?JSON.parse(raw):[];}catch(e){return[];}}\n"
  + "function saveItems(items){try{window.localStorage.setItem(LS_KEY,JSON.stringify(items));}catch(e){}}\n"
  + "function newId(){return 'n'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36);}\n"
  + "function colorHex(id){return COLORS[id]||COLORS.yellow;}\n"
  + "function buildExport(items){\n"
  + "var exportedAt=new Date().toISOString();\n"
  + "var clean=[];\n"
  + "for(var i=0;i<items.length;i++){if(items[i]&&items[i].text)clean.push(items[i]);}\n"
  + "var doc={app:'RliBook',version:1,kind:'notes',book:{title:BOOK_TITLE,key:BOOK_KEY,format:FORMAT},exportedAt:exportedAt,count:clean.length,items:[]};\n"
  + "for(var j=0;j<clean.length;j++){doc.items.push({text:clean[j].text,color:clean[j].color||'yellow',note:clean[j].note||'',unit:clean[j].unit||1,createdAt:clean[j].createdAt||exportedAt});}\n"
  + "var json=JSON.stringify(doc,null,2);\n"
  + "var lines=['# ملاحظاتي وتمييزاتي — '+BOOK_TITLE,'','صُدّرت من RliBook في '+exportedAt,''];\n"
  + "for(var k=0;k<doc.items.length;k++){var h=doc.items[k];lines.push('> '+h.text);if(h.note)lines.push('','ملاحظة: '+h.note);lines.push('','— الفصل/الصفحة '+h.unit+' · '+h.color,'');}\n"
  + "var stem=BOOK_TITLE.replace(/[\\x00-\\x1f\\x7f]/g,'').replace(/[\"/\\\\:;<>?*|]/g,'').replace(/\\s+/g,' ').replace(/ /g,'_').slice(0,80)||'rlibook-notes';\n"
  + "return {json:json,markdown:lines.join('\\n'),jsonFilename:stem+'_notes.json',mdFilename:stem+'_notes.md',count:clean.length};\n"
  + "}\n"
  + "function download(filename,text){\n"
  + "try{\n"
  + "var blob=new Blob([text],{type:'application/json;charset=utf-8'});\n"
  + "var a=document.createElement('a');\n"
  + "a.href=window.URL.createObjectURL(blob);a.download=filename;\n"
  + "document.body.appendChild(a);a.click();\n"
  + "setTimeout(function(){try{document.body.removeChild(a);window.URL.revokeObjectURL(a.href);}catch(e){}},500);\n"
  + "status('تم تنزيل '+filename+' — ملاحظاتك فقط، وليس الكتاب.');\n"
  + "}catch(e){status('تعذّر تنزيل الملف في هذا المتصفح — انسخ الملاحظات يدوياً.');}\n"
  + "}\n"
  + "function rangeFromPoint(x,y){\n"
  + "try{\n"
  + "if(document.caretRangeFromPoint)return document.caretRangeFromPoint(x,y);\n"
  + "if(document.caretPositionFromPoint){var p=document.caretPositionFromPoint(x,y);if(p){var r=document.createRange();r.setStart(p.offsetNode,p.offset);r.collapse(true);return r;}}\n"
  + "}catch(e){}\n"
  + "return null;\n"
  + "}\n"
  + "function captureSelection(){\n"
  + "try{\n"
  + "var sel=window.getSelection();\n"
  + "if(!sel||sel.rangeCount===0||sel.isCollapsed){pendingRange=null;pendingText='';return;}\n"
  + "var range=sel.getRangeAt(0);\n"
  + "if(!chapter.contains(range.commonAncestorContainer)){pendingRange=null;pendingText='';return;}\n"
  + "var text=String(sel.toString()).replace(/\\s+/g,' ').trim();\n"
  + "if(!text){pendingRange=null;pendingText='';return;}\n"
  + "pendingRange=range.cloneRange();pendingText=text;\n"
  + "status('تم تحديد '+text.length+' حرفاً — اضغط «تمييز» أو «ملاحظة».');\n"
  + "}catch(e){pendingRange=null;pendingText='';}\n"
  + "}\n"
  + "function wrapRange(range,color,id){\n"
  + "var mark=document.createElement('mark');\n"
  + "mark.className='rlb-hl';mark.style.background=colorHex(color);\n"
  + "mark.setAttribute('data-rlb-id',id);\n"
  + "try{range.surroundContents(mark);return mark;}\n"
  + "catch(e){try{var frag=range.extractContents();mark.appendChild(frag);range.insertNode(mark);return mark;}catch(e2){return null;}}\n"
  + "}\n"
  + "function restoreHighlights(items){\n"
  + "for(var i=0;i<items.length;i++){\n"
  + "var text=items[i].text;if(!text)continue;\n"
  + "var range=findTextRange(text);\n"
  + "if(range)wrapRange(range,items[i].color,items[i].id);\n"
  + "}\n"
  + "}\n"
  + "function findTextRange(text){\n"
  + "var walker=document.createTreeWalker(chapter,NodeFilter.SHOW_TEXT,null,false);\n"
  + "var nodes=[];var node;\n"
  + "while((node=walker.nextNode()))nodes.push(node);\n"
  + "var joined='';var starts=[];\n"
  + "for(var i=0;i<nodes.length;i++){starts.push(joined.length);joined+=nodes[i].nodeValue;}\n"
  + "var at=joined.indexOf(text);\n"
  + "if(at<0){\n"
  + "var flat=function(s){return s.replace(/\\s+/g,' ');};\n"
  + "at=flat(joined).indexOf(flat(text));\n"
  + "if(at<0)return null;\n"
  + "}\n"
  + "var end=at+text.length;\n"
  + "var startNode=null,startOff=0,endNode=null,endOff=0;\n"
  + "for(var j=0;j<nodes.length;j++){\n"
  + "var ns=starts[j],ne=ns+nodes[j].nodeValue.length;\n"
  + "if(startNode===null&&at>=ns&&at<ne){startNode=nodes[j];startOff=at-ns;}\n"
  + "if(end>ns&&end<=ne){endNode=nodes[j];endOff=end-ns;}\n"
  + "}\n"
  + "if(!startNode||!endNode)return null;\n"
  + "try{var r=document.createRange();r.setStart(startNode,startOff);r.setEnd(endNode,endOff);return r;}\n"
  + "catch(e){return null;}\n"
  + "}\n"
  + "function renderList(items){\n"
  + "var ul=$('rlb-list');if(!ul)return;\n"
  + "ul.innerHTML='';\n"
  + "if(!items.length){ul.innerHTML='<li class=\"note\">لا توجد تمييزات بعد — حدّد نصاً ثم اضغط «تمييز».</li>';return;}\n"
  + "for(var i=0;i<items.length;i++){\n"
  + "var h=items[i];\n"
  + "var li=document.createElement('li');\n"
  + "var span=document.createElement('span');\n"
  + "span.className='hl-text';span.style.background=colorHex(h.color);\n"
  + "span.textContent=h.text;\n"
  + "li.appendChild(span);\n"
  + "if(h.note){var n=document.createElement('div');n.textContent='📝 '+h.note;li.appendChild(n);}\n"
  + "var meta=document.createElement('div');meta.className='note';\n"
  + "meta.textContent='الفصل/الصفحة '+h.unit+' · '+(h.createdAt||'').slice(0,10);\n"
  + "li.appendChild(meta);\n"
  + "var del=document.createElement('button');del.textContent='حذف';\n"
  + "del.onclick=(function(id){return function(){var cur=loadItems();var next=[];for(var k=0;k<cur.length;k++){if(cur[k].id!==id)next.push(cur[k]);}saveItems(next);var mark=chapter.querySelector('[data-rlb-id=\"'+id+'\"]');if(mark){var parent=mark.parentNode;while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);parent.removeChild(mark);}renderList(next);status('تم الحذف.');};})(h.id);\n"
  + "li.appendChild(del);\n"
  + "ul.appendChild(li);\n"
  + "}\n"
  + "}\n"
  + "function addHighlight(note){\n"
  + "if(!pendingRange||!pendingText){status('حدّد نصاً أولاً — اسحب بإصبعك أو بالفأرة.');return;}\n"
  + "var items=loadItems();\n"
  + "var item={id:newId(),text:pendingText,color:selectedColor,note:note||'',unit:UNIT,createdAt:new Date().toISOString()};\n"
  + "var mark=wrapRange(pendingRange,selectedColor,item.id);\n"
  + "if(!mark){status('تعذّر تمييز هذا التحديد — جرّب تحديداً أقصر.');return;}\n"
  + "items.push(item);saveItems(items);renderList(items);\n"
  + "try{window.getSelection().removeAllRanges();}catch(e){}\n"
  + "pendingRange=null;pendingText='';\n"
  + "status('تم حفظ التمييز على هذا الجهاز.');\n"
  + "}\n"
  + "function loadGis(cb){\n"
  + "if(window.google&&window.google.accounts&&window.google.accounts.oauth2)return cb(true);\n"
  + "var s=document.createElement('script');\n"
  + "s.src='https://accounts.google.com/gsi/client';\n"
  + "s.onload=function(){cb(true);};s.onerror=function(){cb(false);};\n"
  + "document.head.appendChild(s);\n"
  + "}\n"
  + "function uploadToDrive(token,items){\n"
  + "if(!window.fetch){status('هذا المتصفح لا يدعم المزامنة — نزّل الملاحظات كملف.');return;}\n"
  + "var exp=buildExport(items);\n"
  + "var boundary='rlibook';\n"
  + "var body='--'+boundary+'\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n'\n"
  + "+JSON.stringify({name:exp.jsonFilename,mimeType:'application/json'})+'\\r\\n'\n"
  + "+'--'+boundary+'\\r\\nContent-Type: application/json\\r\\n\\r\\n'+exp.json+'\\r\\n--'+boundary+'--';\n"
  + "window.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{\n"
  + "method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'multipart/related; boundary='+boundary},body:body})\n"
  + ".then(function(res){if(!res.ok)throw new Error('http-'+res.status);return res.json();})\n"
  + ".then(function(){status('تمت المزامنة مع Google Drive ✓ — الملف '+exp.jsonFilename);})\n"
  + ".catch(function(){status('تعذّرت المزامنة مع Google Drive — الملاحظات محفوظة على هذا الجهاز.');});\n"
  + "}\n"
  + "function driveSync(){\n"
  + "var items=loadItems();\n"
  + "if(!items.length){status('لا توجد ملاحظات لمزامنتها بعد — حدّد نصاً واضغط «تمييز» أولاً.');return;}\n"
  + "if(!GOOGLE_CLIENT_ID){status('مزامنة Google غير مهيأة بعد — يمكنك تنزيل الملاحظات كملف.');return;}\n"
  + "status('جارٍ الاتصال بـ Google…');\n"
  + "loadGis(function(ok){\n"
  + "if(!ok){status('تعذّر تحميل خدمة Google — تحقق من الاتصال وحاول مجدداً.');return;}\n"
  + "try{\n"
  + "var client=window.google.accounts.oauth2.initTokenClient({client_id:GOOGLE_CLIENT_ID,scope:'https://www.googleapis.com/auth/drive.file',callback:function(resp){if(resp.error){status('رفضت Google تسجيل الدخول.');return;}uploadToDrive(resp.access_token,loadItems());}});\n"
  + "client.requestAccessToken({prompt:''});\n"
  + "}catch(e){status('تعذّر بدء تسجيل الدخول إلى Google.');}\n"
  + "});\n"
  + "}\n"
  + "var hlBtn=$('rlb-highlight');\n"
  + "if(hlBtn)hlBtn.onclick=function(){addHighlight('');};\n"
  + "var noteBtn=$('rlb-note');\n"
  + "if(noteBtn)noteBtn.onclick=function(){\n"
  + "if(!pendingText){status('حدّد نصاً أولاً — اسحب بإصبعك أو بالفأرة.');return;}\n"
  + "var note=window.prompt('ملاحظتك على هذا التحديد:','');\n"
  + "if(note===null)return;\n"
  + "addHighlight(note);\n"
  + "};\n"
  + "var fhBtn=$('rlb-freehand');\n"
  + "if(fhBtn)fhBtn.onclick=function(){\n"
  + "freehand=!freehand;\n"
  + "fhBtn.setAttribute('aria-pressed',freehand?'true':'false');\n"
  + "fhBtn.textContent=freehand?'✏️ تحديد حر: مفعّل — اسحب بإصبعك على النص':'✏️ تحديد حر';\n"
  + "try{chapter.style.touchAction=freehand?'none':'';}catch(e){}\n"
  + "status(freehand?'وضع التحديد الحر مفعّل — اسحب بإصبعك على النص لتحديده.':'وضع التحديد الحر متوقف — التحديد العادي يعمل.');\n"
  + "};\n"
  + "var swatches=document.querySelectorAll('#rlb-tools [data-color]');\n"
  + "for(var s=0;s<swatches.length;s++){\n"
  + "swatches[s].onclick=(function(btn){return function(){selectedColor=btn.getAttribute('data-color');for(var k=0;k<swatches.length;k++)swatches[k].setAttribute('aria-pressed','false');btn.setAttribute('aria-pressed','true');};})(swatches[s]);\n"
  + "}\n"
  + "var expJson=$('rlb-export-json');\n"
  + "if(expJson)expJson.onclick=function(){var exp=buildExport(loadItems());if(!exp.count){status('لا توجد ملاحظات لتنزيلها بعد.');return;}download(exp.jsonFilename,exp.json);};\n"
  + "var expMd=$('rlb-export-md');\n"
  + "if(expMd)expMd.onclick=function(){var exp=buildExport(loadItems());if(!exp.count){status('لا توجد ملاحظات لتنزيلها بعد.');return;}download(exp.mdFilename,exp.markdown);};\n"
  + "var driveBtn=$('rlb-drive');\n"
  + "if(driveBtn)driveBtn.onclick=function(){driveSync();};\n"
  + "var clearBtn=$('rlb-clear');\n"
  + "if(clearBtn)clearBtn.onclick=function(){if(!window.confirm('مسح كل التمييزات والملاحظات لهذا الكتاب من هذا الجهاز؟'))return;saveItems([]);var marks=chapter.querySelectorAll('mark.rlb-hl');for(var i=0;i<marks.length;i++){var m=marks[i];var parent=m.parentNode;while(m.firstChild)parent.insertBefore(m.firstChild,m);parent.removeChild(m);}renderList([]);status('تم المسح.');};\n"
  + "chapter.addEventListener('mouseup',function(){setTimeout(captureSelection,50);});\n"
  + "chapter.addEventListener('touchend',function(){setTimeout(captureSelection,50);});\n"
  + "chapter.addEventListener('touchstart',function(e){\n"
  + "if(!freehand)return;\n"
  + "var t=e.touches[0];var r=rangeFromPoint(t.clientX,t.clientY);\n"
  + "if(r){anchorRange=r;try{var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);}catch(err){}}\n"
  + "try{e.preventDefault();}catch(err){}\n"
  + "},false);\n"
  + "chapter.addEventListener('touchmove',function(e){\n"
  + "if(!freehand||!anchorRange)return;\n"
  + "var t=e.touches[0];var r=rangeFromPoint(t.clientX,t.clientY);\n"
  + "if(r){\n"
  + "try{\n"
  + "var sel=window.getSelection();\n"
  + "if(sel.setBaseAndExtent){sel.setBaseAndExtent(anchorRange.startContainer,anchorRange.startOffset,r.endContainer,r.endOffset);}\n"
  + "else{var nr=document.createRange();nr.setStart(anchorRange.startContainer,anchorRange.startOffset);nr.setEnd(r.endContainer,r.endOffset);sel.removeAllRanges();sel.addRange(nr);}\n"
  + "}catch(err){}\n"
  + "}\n"
  + "try{e.preventDefault();}catch(err){}\n"
  + "},false);\n"
  + "chapter.addEventListener('touchend',function(){anchorRange=null;setTimeout(captureSelection,50);});\n"
  + "renderList(loadItems());\n"
  + "restoreHighlights(loadItems());\n"
  + "/* Token renewal \u2014 no time limit for reading (2026-11-16). The\n"
  + "   reader token lives 1 hour, but reading never stops: every\n"
  + "   chapter response already carries a fresh token in its nav\n"
  + "   links (server-side renewal), and this timer renews it in the\n"
  + "   background while the reader sits idle on one page. No-ops\n"
  + "   gracefully where fetch is absent (Kindle browser) or the\n"
  + "   renewal fails (the next chapter click still renews\n"
  + "   server-side). Up to 3 retries, 5 minutes apart, then stops. */\n"
  + "var RENEW_BASE=__RENEW_BASE__;\n"
  + "var renewToken=__RTOK__;\n"
  + "var renewFails=0;\n"
  + "function rewriteRtok(tok){try{var as=document.getElementsByTagName('a');for(var i=0;i<as.length;i++){var h=as[i].href;if(h&&h.indexOf('/read?')!==-1){as[i].href=h.replace(/([?&])rtok=[^&]*/, '$1rtok='+encodeURIComponent(tok));}}}catch(e){}}\n"
  + "function renew(){if(!window.fetch||!RENEW_BASE||!renewToken)return;var u=RENEW_BASE+'&rtok='+encodeURIComponent(renewToken);window.fetch(u,{headers:{accept:'application/json'}}).then(function(r){return r.json();}).then(function(d){if(d&&d.ok&&d.token){renewToken=d.token;renewFails=0;rewriteRtok(d.token);setTimeout(renew,50*60*1000);}else{if(++renewFails<=3)setTimeout(renew,5*60*1000);}}).catch(function(){if(++renewFails<=3)setTimeout(renew,5*60*1000);});}\n"
  + "setTimeout(renew,50*60*1000);\n"
  + "})();\n";

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
  const getQuery = book.kind === "tg"
    ? "lib=tg&amp;h=" + encodeURIComponent(book.handle) + "&amp;p=" + book.postId
    : "lib=" + encodeURIComponent(book.lib) + "&amp;id=" + encodeURIComponent(book.id);
  const deliveryLink = "/kindle/get?" + getQuery + "&amp;f=" + book.fmt
    + (title ? "&amp;t=" + encodeURIComponent(title) : "");

  // The reader opens EPUB, PDF and TXT. Any other format gets an
  // honest page with the delivery-page link instead of a broken
  // reader (MOBI/AZW3/KFX/DOC/DOCX go by USB/Calibre).
  if (!READABLE_FORMATS.has(book.fmt)) {
    return page("لا يمكن القراءة هنا",
      "<p>هذا الكتاب بصيغة " + esc(book.fmt.toUpperCase()) + " — القارئ يفتح كتب EPUB وPDF وTXT فقط.</p>\n"
      + "<p>صيغ MOBI وAZW3 وKFX وDOC وDOCX لا تُقرأ في المتصفح — احصل على الكتاب على جهازك من "
      + "<a href=\"" + deliveryLink + "\">صفحة «احصل على الكتاب على جهازك»</a> (USB عبر Calibre للصيغ غير المدعومة).</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 400);
  }
  // Hindawi's acquisition URL is built as ".../id.epub" — a Hindawi
  // book in any other format cannot be fetched as that format, so
  // say so before fetching the wrong file.
  if (book.kind === "opds" && book.lib === "hindawi" && book.fmt !== "epub") {
    return page("لا يمكن القراءة هنا",
      "<p>مكتبة هنداوي توفّر هذا الكتاب بصيغة EPUB فقط عبر رابطها — اطلبه بصيغة EPUB "
      + "أو احصل عليه من <a href=\"" + deliveryLink + "\">صفحة «احصل على الكتاب على جهازك»</a>.</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 400);
  }

  // The signing key and the incoming token are read here, before
  // the flag/hide checks, so an OWN token can be recognised first.
  const signingKey = (env.PROXY_SIGNING_KEY || "").trim();
  if (!signingKey) {
    return page("خدمة القراءة غير مهيأة",
      "<p>خدمة القراءة غير مهيأة بعد على الخادم — حاول مجدداً لاحقاً.</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 503);
  }
  const rtok = (url.searchParams.get("rtok") || "").trim();
  // PERSONAL BOOKS (2026-11-16): an OWN reader token (payload
  // o:1, minted by /api/read-token only after server-side
  // private-feed verification) skips the flag gate below — the
  // book is the caller's own file. It does NOT skip the hide gate:
  // hide is the owner's explicit removal and it wins.
  const ownEntry = rtok ? await readerTokenOwn(signingKey, rtok) : false;

  // Flagged Telegram books: no reader on the website (same denylist
  // as dl-token.js). OPDS books are PD/CC and never flagged.
  if (book.kind === "tg" && !ownEntry
    && (await isFlaggedBook(env, book.handle, book.postId))) {
    return page("🚩 كتاب عليه علامة",
      "<p>🚩 هذا الكتاب عليه علامة — الموقع لا يتيح تحميله أو قراءته.</p>\n"
      + "<p>للوصول إليه، اطلبه من قناة النشر عبر بوت تليجرام "
      + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 403);
  }
  // Owner-hide (Workstream 2b, round-2 addition): a hidden book
  // gets no reader either — same posture as the flag check, and
  // read-token.js already refuses to mint for it. Applies even to
  // own tokens (see above).
  if (book.kind === "tg" && (await isHiddenBook(env, book.handle, book.postId))) {
    return page("🚫 كتاب غير متاح",
      "<p>🚫 هذا الكتاب أزاله المالك، فلم يعد متاحاً.</p>\n"
      + "<p><a href=\"/book\">← رجوع إلى البحث</a></p>\n", 403);
  }

  // ---- reader token gate --------------------------------------------
  // ?rtok= is an HMAC token (1 hour, this book only) minted by
  // /kindle/get or /api/read-token. Without it — or with an expired
  // or wrong-book token — there is no chapter, only a link back to
  // the delivery page for a fresh link. Reading is free and
  // unlimited; the token only proves the link is fresh.
  if (!(await verifyReaderToken(signingKey, rtok, book))) {
    return page("رابط القراءة منتهٍ",
      "<p>رابط القراءة هذا منتهٍ أو غير صالح — روابط القراءة تعمل لمدة ساعة واحدة ولكتاب واحد فقط.</p>\n"
      + "<p>عُد إلى <a href=\"" + deliveryLink + "\">صفحة «احصل على الكتاب على جهازك»</a> واضغط «📖 اقرأ الآن في المتصفح» مجدداً.</p>\n"
      + "<p><a href=\"" + esc(backToBook) + "\">← رجوع</a></p>\n", 403);
  }

  // ---- token renewal: no time limit for reading -------------------
  // The incoming rtok proves the link is fresh, but it dies after
  // 1 hour — and a slow reader sits on one chapter longer than
  // that. So every chapter response mints a FRESH reader token and
  // puts it in the nav links below (server-side renewal: works with
  // JS off, covers active reading). The client script ALSO renews
  // in the background (covers idle >1h on one page).
  // Renewal re-checks the flag for LIBRARY books — leniently: a KV
  // error fails OPEN (mint anyway — the entry checks above already
  // failed closed, and KV reads can be stale across colos, so this
  // second read is defence-in-depth: it never mints a fresh token
  // for a flagged/hidden book). Own books (payload o:1) skip the
  // re-check entirely. Renewal never throws: any failure keeps the
  // old token.
  let navRtok = rtok;
  try {
    const own = await readerTokenOwn(signingKey, rtok);
    let renewOk = own;
    if (!own && book.kind === "tg") {
      try {
        renewOk = !(await isFlaggedBook(env, book.handle, book.postId))
          && !(await isHiddenBook(env, book.handle, book.postId));
      } catch {
        renewOk = true; // KV error at renewal only: fail open.
      }
    } else if (!own) {
      renewOk = true; // OPDS books are never flagged/hidden.
    }
    if (renewOk) {
      const rHandle = book.kind === "tg" ? book.handle : book.lib;
      const rPostId = book.kind === "tg" ? book.postId : book.id;
      navRtok = await makeReaderToken(signingKey, rHandle, rPostId, book.fmt,
        READER_TOKEN_TTL_SECONDS, undefined, own);
    }
  } catch {
    navRtok = rtok; // Renewal must never break reading.
  }

  // ---- fetch the book file ------------------------------------------
  let srcUrl;
  if (book.kind === "tg") {
    srcUrl = await proxyDownloadUrl(env, book.handle, book.postId, book.fmt);
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
    res = await fetch(srcUrl, { headers: { "user-agent": "RliBook-reader/2.0" }, redirect: "follow" });
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
  if (!magicBytesOk(bytes, book.fmt)) {
    return page("تعذّر تنزيل الكتاب",
      "<p>الملف الذي وصل ليس كتاب " + esc(book.fmt.toUpperCase()) + " صالحاً — حاول مجدداً لاحقاً.</p>", 502);
  }
  // ---- render one unit ----------------------------------------------
  // LAZY for EPUB: inflate only the requested chapter. parseEpub
  // inflates EVERY chapter (105–200 ms CPU for a 150-chapter book,
  // past the 10 ms free-tier budget — the 1102 shape), so the
  // request path never calls it for EPUB; it uses parseEpubChapter,
  // which clamps into range (?ch=99 on a 2-chapter book renders
  // chapter 2, never a crash). PDF/TXT go through parseBook:
  // one page at a time, no whole-book inflation.
  const chRaw = Number(url.searchParams.get("ch") || "1");
  const chIndex = Number.isFinite(chRaw) ? Math.floor(chRaw) - 1 : 0;
  const isEpub = book.fmt === "epub";
  const unitWord = isEpub ? "الفصل" : "صفحة";
  const unreadable = () => page("تعذّر قراءة الكتاب",
    "<p>تعذّر قراءة هذا الملف ككتاب " + esc(book.fmt.toUpperCase())
    + " — قد يكون تالفاً أو مشفّراً أو بصيغة غير مدعومة.</p>\n"
    + "<p>احصل عليه على جهازك من صفحة الكتاب.</p>", 502);
  let ch;
  let totalUnits;
  let unit;
  let bookTitle;
  if (isEpub) {
    const epub = await parseEpubChapter(bytes, chIndex);
    if (!epub) return unreadable();
    ch = epub.chapterNumber;
    totalUnits = epub.totalChapters;
    unit = epub.chapter;
    bookTitle = epub.title || title || "كتاب";
  } else {
    const doc = await parseBook(bytes, book.fmt);
    if (!doc || !doc.units.length) return unreadable();
    ch = Number.isFinite(chRaw) ? Math.max(1, Math.min(doc.units.length, Math.floor(chRaw))) : 1;
    totalUnits = doc.units.length;
    unit = doc.units[ch - 1];
    bookTitle = doc.title || title || "كتاب";
  }
  const bookParams = (book.kind === "tg"
    ? "lib=tg&amp;h=" + encodeURIComponent(book.handle) + "&amp;p=" + book.postId
    : "lib=" + encodeURIComponent(book.lib) + "&amp;id=" + encodeURIComponent(book.id))
    + "&amp;f=" + book.fmt;
  const selfParams = bookParams + "&amp;rtok=" + encodeURIComponent(navRtok);
  const navLink = (n, label) => "<a href=\"/read?" + selfParams + "&amp;ch=" + n + "\">" + label + "</a>";
  const nav = "<p class=\"nav\">"
    + (ch > 1 ? navLink(ch - 1, "→ " + (isEpub ? "الفصل السابق" : "الصفحة السابقة")) + " · " : "")
    + unitWord + " " + ch + " من " + totalUnits
    + (ch < totalUnits ? " · " + navLink(ch + 1, (isEpub ? "الفصل التالي" : "الصفحة التالية") + " ←") : "")
    + "</p>\n";
  // Per-unit HTML cap: a very long chapter/page is cut at a
  // paragraph boundary with a note — one response never carries
  // the whole book.
  let unitHtml = unit.html;
  if (unitHtml.length > MAX_UNIT_HTML_CHARS) {
    const cut = unitHtml.lastIndexOf("</p>", MAX_UNIT_HTML_CHARS);
    unitHtml = (cut > 0 ? unitHtml.slice(0, cut + 4) : unitHtml.slice(0, MAX_UNIT_HTML_CHARS))
      + "\n<p class=\"note\">… (هذه الصفحة طويلة — عُرض منها مقتطف. انتقل للصفحة التالية لمتابعة القراءة.)</p>";
  }
  const googleClientId = (env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const bookKey = notesStorageKey(book);
  const clientScript = CLIENT_SCRIPT
    .replace("__BOOK_KEY__", JSON.stringify(bookKey))
    .replace("__UNIT__", String(ch))
    .replace("__BOOK_TITLE__", JSON.stringify(bookTitle))
    .replace("__FORMAT__", JSON.stringify(book.fmt))
    .replace("__GOOGLE_CLIENT_ID__", JSON.stringify(googleClientId));
  // Renewal base: the /api/read-token URL for this book (raw &s —
  // it is fetched from JS, not written into an href). The timer
  // appends the current rtok; the endpoint renews an own token as
  // own and a library token through the normal gates.
  const renewBase = "/api/read-token?" + (book.kind === "tg"
    ? "lib=tg&h=" + encodeURIComponent(book.handle) + "&p=" + book.postId
    : "lib=" + encodeURIComponent(book.lib) + "&id=" + encodeURIComponent(book.id))
    + "&f=" + book.fmt;
  const clientScriptWithRenew = clientScript
    .replace("__RENEW_BASE__", JSON.stringify(renewBase))
    .replace("__RTOK__", JSON.stringify(navRtok));
  const toolbar = "<div class=\"toolbar\" id=\"rlb-tools\">\n"
    + "<button id=\"rlb-freehand\" aria-pressed=\"false\">✏️ تحديد حر</button>\n"
    + "<button data-color=\"yellow\" aria-pressed=\"true\" style=\"background:#FFE066\" aria-label=\"أصفر\">🟡</button>\n"
    + "<button data-color=\"green\" aria-pressed=\"false\" style=\"background:#B7E4C7\" aria-label=\"أخضر\">🟢</button>\n"
    + "<button data-color=\"blue\" aria-pressed=\"false\" style=\"background:#A8D8EA\" aria-label=\"أزرق\">🔵</button>\n"
    + "<button data-color=\"pink\" aria-pressed=\"false\" style=\"background:#FFC8DD\" aria-label=\"وردي\">🌸</button>\n"
    + "<button id=\"rlb-highlight\">⭐ تمييز</button>\n"
    + "<button id=\"rlb-note\">📝 ملاحظة</button>\n"
    + "<button id=\"rlb-export-json\">📥 تنزيل ملاحظاتي (JSON)</button>\n"
    + "<button id=\"rlb-export-md\">📥 تنزيل ملاحظاتي (Markdown)</button>\n"
    + "<button id=\"rlb-drive\">☁️ مزامنة Google Drive</button>\n"
    + "<button id=\"rlb-clear\">🗑️ مسح الكل</button>\n"
    + "<p class=\"status\" id=\"rlb-status\">حدّد نصاً بالفأرة أو بإصبعك (أو فعّل «تحديد حر») ثم اضغط «تمييز» أو «ملاحظة». ملاحظاتك تُحفظ على هذا الجهاز فقط.</p>\n"
    + "</div>\n"
    + "<noscript><p class=\"note\">التمييز والملاحظات تحتاج JavaScript — القراءة نفسها تعمل بدونه.</p></noscript>\n";
  const notesSection = "<h2>ملاحظاتي وتمييزاتي</h2>\n"
    + "<ul class=\"notes-list\" id=\"rlb-list\"></ul>\n"
    + "<p class=\"note\">ملاحظاتك ملكك: نزّلها كملف أو زامنها مع Google Drive من الأزرار أعلاه. "
    + "الكتاب نفسه لا يُنزَّل ولا يُزامَن أبداً.</p>\n";
  const getParams = bookParams
    + (title ? "&amp;t=" + encodeURIComponent(title) : "");
  const body = "<h1>" + esc(bookTitle) + "</h1>\n"
    + "<h2>" + esc(unit.title) + "</h2>\n"
    + nav
    + toolbar
    + "<div class=\"chapter\" id=\"rlb-chapter\">\n" + unitHtml + "\n</div>\n"
    + nav
    + notesSection
    + "<p class=\"note\">القراءة هنا في المتصفح فقط — الكتاب لا يُضاف إلى مكتبة جهازك من هنا. "
    + "للحصول عليه على جهازك: <a href=\"/kindle/get?" + getParams + "\">صفحة «احصل على الكتاب على جهازك»</a>.</p>\n"
    + "<p><a href=\"" + esc(backToBook) + "\">← رجوع إلى البحث</a></p>\n"
    + "<script>\n" + clientScriptWithRenew + "\n</script>\n";
  return page(bookTitle + " — " + unit.title, body, 200);
}
