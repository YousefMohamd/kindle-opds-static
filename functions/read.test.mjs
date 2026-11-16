// Test for the plain-HTML reader (functions/read.js, v2).
// Standalone Node script — run from the repo root:
//   node functions/read.test.mjs
//
// It imports the real Function module, mocks global fetch so the
// book source is served from fixtures built in this file, and calls
// onRequest() over HTTP semantics. Fixtures:
//   * a minimal EPUB (ZIP: container.xml + OPF + 2 XHTML chapters —
//     chapter 1 stored, chapter 2 deflated, so both ZIP methods are
//     covered);
//   * a minimal PDF (3 pages: WinAnsi literal strings + T* lines,
//     a TJ array with kern spaces, and a ToUnicode-mapped font);
//   * a plain-text book.
// It asserts:
//   1. an EPUB renders chapter 1 as plain HTML with the reader
//      toolbar + client script, and ?ch=2 renders chapter 2, with
//      prev/next navigation; the BOOK's <script> is stripped while
//      the reader's own script is present;
//   2. a PDF renders one PDF page per reader page, with ToUnicode
//      decoding and TJ spacing; a TXT book renders paginated text;
//   3. the reader-token gate: no token / wrong book / expired /
//      wrong format -> 403 (or 503 when the signing key is unset);
//   4. parseEpub / parsePdf / parseTxt / sanitize units;
//   5. buildNotesExport shape + filenames; CLIENT_SCRIPT parses;
//   6. a flagged Telegram book -> 403; a MOBI book -> 400 with the
//   7. (round 2) token renewal + own books: a nearly-expired
//      token yields nav links with a FRESH token; a book flagged
//      after minting keeps the old token (reading continues until
//      it expires); an own token opens a flagged book, but not a
//      hidden one; the client renewal timer is in the page.
//      delivery-page link; a Drive HTML warning page -> 502; bad
//      magic bytes -> 502; an oversized file -> 413; a bad book
//      identity -> 400; security headers (CSP, noindex, no-store)
//      on chapter pages; a very long chapter is cut at the unit cap.
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. All book data below is FAKE test data.

import { deflateRawSync, deflateSync } from "node:zlib";
import {
  onRequest, parseEpub, parseEpubChapter, parseEpubIndex, parsePdf, parseTxt,
  sanitizeChapterHtml, buildNotesExport, notesStorageKey, CLIENT_SCRIPT,
  reorderBidiLine, bidiVisualStats,
  MAX_FILE_BYTES, MAX_UNIT_HTML_CHARS,
} from "./read.js";
import { makeReaderToken, verifyReaderToken, readerTokenOwn } from "./api/dl-token.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      if (type === "json") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
  };
}

// ---- minimal ZIP writer (stored + deflate) --------------------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  // files: [{ name, data: Uint8Array, method: 0 | 8 }]
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const raw = f.data;
    const comp = f.method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(8, f.method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, comp);
    central.push({ nameBytes, method: f.method, crc, csize: comp.length, usize: raw.length, offset });
    offset += 30 + nameBytes.length + comp.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true); // version made by
    head.setUint16(6, 20, true); // version needed
    head.setUint16(10, c.method, true);
    head.setUint32(16, c.crc, true);
    head.setUint32(20, c.csize, true);
    head.setUint32(24, c.usize, true);
    head.setUint16(28, c.nameBytes.length, true);
    head.setUint32(42, c.offset, true);
    chunks.push(new Uint8Array(head.buffer), c.nameBytes);
    offset += 46 + c.nameBytes.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ---- minimal PDF builder (with a correct xref, for realism) --------
// objects: [{ num, dict: "<< ... >>", stream?: Uint8Array }]
// The reader scans objects and never uses the xref, but the fixture
// keeps one so the file is a valid PDF, not just parser input.
function buildPdf(objects) {
  const enc = new TextEncoder();
  const chunks = [];
  let pos = 0;
  const pushStr = (s) => { const b = enc.encode(s); chunks.push(b); pos += b.length; };
  const pushBytes = (b) => { chunks.push(b); pos += b.length; };
  pushStr("%PDF-1.4\n");
  const offsets = {};
  for (const o of objects) {
    offsets[o.num] = pos;
    let dict = o.dict;
    // Only add a direct /Length when the dict does not already
    // carry one (object 9 below uses an indirect /Length 13 0 R
    // on purpose — a multi-digit indirect length is the regression
    // case for the stream-bounds regex).
    if (o.stream && !/\/Length/.test(dict)) dict = dict.replace(/>>\s*$/, " /Length " + o.stream.length + " >>");
    pushStr(o.num + " 0 obj\n" + dict + "\n");
    if (o.stream) {
      pushStr("stream\n");
      pushBytes(o.stream);
      pushStr("\nendstream\n");
    }
    pushStr("endobj\n");
  }
  const xrefPos = pos;
  const maxNum = Math.max(...objects.map((o) => o.num));
  pushStr("xref\n0 " + (maxNum + 1) + "\n");
  pushStr("0000000000 65535 f \n");
  for (let n = 1; n <= maxNum; n++) {
    pushStr(String(offsets[n] === undefined ? 0 : offsets[n]).padStart(10, "0") + " 00000 n \n");
  }
  pushStr("trailer\n<< /Size " + (maxNum + 1) + " /Root 1 0 R /Info 8 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n");
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

const enc = new TextEncoder();
const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>كتاب اختبار</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;
const CH1 = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>الفصل الأول</title></head><body><h1>الفصل الأول</h1><p>هذا نص الفصل الأول للاختبار.</p><script>alert(1)</script><p onclick="evil()">فقرة ثانية.</p><a href="javascript:evil()">رابط</a></body></html>`;
const CH2 = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>الفصل الثاني</title></head><body><h1>الفصل الثاني</h1><p>هذا نص الفصل الثاني للاختبار.</p></body></html>`;

const FIXTURE_EPUB = buildZip([
  { name: "mimetype", data: enc.encode("application/epub+zip"), method: 0 },
  { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
  { name: "OEBPS/content.opf", data: enc.encode(OPF), method: 0 },
  { name: "OEBPS/ch1.xhtml", data: enc.encode(CH1), method: 0 },
  { name: "OEBPS/ch2.xhtml", data: enc.encode(CH2), method: 8 },
]);

// A long-chapter EPUB for the per-unit HTML cap test.
const LONG_TEXT = "فقرة طويلة للاختبار. ".repeat(20000);
const CH_LONG = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>فصل طويل</title></head><body><h1>فصل طويل</h1><p>${LONG_TEXT}</p></body></html>`;
const FIXTURE_EPUB_LONG = buildZip([
  { name: "mimetype", data: enc.encode("application/epub+zip"), method: 0 },
  { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
  { name: "OEBPS/content.opf", data: enc.encode(OPF), method: 0 },
  { name: "OEBPS/ch1.xhtml", data: enc.encode(CH_LONG), method: 0 },
  { name: "OEBPS/ch2.xhtml", data: enc.encode(CH2), method: 8 },
]);

const PDF_PAGE1 = "BT /F1 18 Tf 22 TL 72 720 Td (Hello PDF page one) Tj T* (Second line here) Tj ET";
const PDF_PAGE2 = "BT /F1 12 Tf 72 720 Td [(Page) -250 (two) -250 (text)] TJ ET";
const PDF_PAGE3 = "BT /F2 12 Tf 72 720 Td (ABC) Tj ET";
const PDF_CMAP = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
  + "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
  + "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
  + "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
  + "1 beginbfchar\n<41> <0058>\nendbfchar\n"
  + "1 beginbfrange\n<42> <43> <0059>\nendbfrange\n"
  + "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
const FIXTURE_PDF = buildPdf([
  { num: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
  { num: 2, dict: "<< /Type /Pages /Kids [3 0 R 4 0 R 6 0 R] /Count 3 >>" },
  { num: 3, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>" },
  { num: 4, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>" },
  { num: 5, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
  { num: 6, dict: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F2 10 0 R >> >> /Contents 11 0 R >>" },
  { num: 7, dict: "<< /Filter /FlateDecode >>", stream: deflateSync(enc.encode(PDF_PAGE1)) },
  { num: 8, dict: "<< /Title (Test PDF Book) >>" },
  // Page 2's stream uses an INDIRECT multi-digit /Length (13 0 R)
  // — the regression case for the stream-bounds regex, which once
  // matched the "2" of "24" and truncated the stream.
  { num: 9, dict: "<< /Filter /FlateDecode /Length 13 0 R >>", stream: deflateSync(enc.encode(PDF_PAGE2)) },
  { num: 10, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 12 0 R >>" },
  { num: 11, dict: "<< >>", stream: enc.encode(PDF_PAGE3) },
  { num: 12, dict: "<< >>", stream: enc.encode(PDF_CMAP) },
  { num: 13, dict: String(deflateSync(enc.encode(PDF_PAGE2)).length) },
]);

const TXT_TEXT = "عنوان الكتاب النصي\n\n"
  + ("هذه فقرة من الكتاب النصي للاختبار. ".repeat(40) + "\n\n")
  + ("فقرة ثانية أطول قليلاً من الأولى. ".repeat(40) + "\n\n")
  + ("خاتمة الكتاب النصي. ".repeat(10));
const FIXTURE_TXT = enc.encode(TXT_TEXT);
const FAKE_HTML = enc.encode("<html>Drive warning page</html>");
const FAKE_GARBAGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// ---- mock fetch ------------------------------------------------------
let fetchMode = "epub"; // epub | epub-long | pdf | txt | html | garbage | fail | oversize
let lastFetchUrl = "";
function mockFetch(url, opts = {}) {
  lastFetchUrl = String(url);
  if (fetchMode === "fail") throw new Error("network down");
  const bytes = fetchMode === "epub" ? FIXTURE_EPUB
    : fetchMode === "epub-long" ? FIXTURE_EPUB_LONG
    : fetchMode === "pdf" ? FIXTURE_PDF
    : fetchMode === "txt" ? FIXTURE_TXT
    : fetchMode === "html" ? FAKE_HTML
    : FAKE_GARBAGE;
  const type = fetchMode === "html" ? "text/html; charset=utf-8"
    : fetchMode === "pdf" ? "application/pdf"
    : fetchMode === "txt" ? "text/plain; charset=utf-8"
    : "application/epub+zip";
  const length = fetchMode === "oversize" ? MAX_FILE_BYTES + 1 : bytes.length;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n) => {
        const k = n.toLowerCase();
        if (k === "content-type") return type;
        if (k === "content-length") return String(length);
        return null;
      },
    },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}


function rtoksIn(body) {
  const out = new Set();
  const re = /rtok=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(body || "")) !== null) out.add(m[1]);
  return [...out];
}

const KEY = "test_signing_key_0123456789abcdef";

async function call(params, env, fetchImpl = mockFetch, opts = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const p = { ...params };
    if (!opts.noToken && !p.rtok) {
      const handle = p.lib === "tg" ? (p.h || "") : (p.lib || "");
      const postId = p.lib === "tg" ? Number(p.p) : (p.id || "");
      p.rtok = await makeReaderToken(
        (env.PROXY_SIGNING_KEY || KEY), handle, postId, p.f || "epub",
        3600, Math.floor(Date.now() / 1000));
    }
    const url = "https://rlibook.tech/read?" + new URLSearchParams(p).toString();
    const res = await onRequest({
      request: new Request(url, { method: "GET" }),
      env,
    });
    return {
      status: res.status,
      body: await res.text(),
      cache: res.headers.get("cache-control"),
      csp: res.headers.get("content-security-policy"),
      robots: res.headers.get("x-robots-tag"),
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ENV = {
  RLIBOOK_KV: makeKv(),
  PROXY_SIGNING_KEY: KEY,
  PROXY_BASE_URL: "https://proxy.example.test",
};

// ================= 1. chapter rendering (EPUB) =======================
console.log("1. Chapter rendering (EPUB):");
{
  fetchMode = "epub";
  const r = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("1a EPUB chapter 1: 200", r.status === 200, "status " + r.status);
  check("1a chapter 1 text rendered",
    r.body.includes("هذا نص الفصل الأول للاختبار") && r.body.includes("الفصل الأول"));
  check("1a chapter 2 text NOT on page 1",
    !r.body.includes("هذا نص الفصل الثاني للاختبار"));
  check("1a book title shown", r.body.includes("كتاب اختبار"));
  check("1a next-chapter link present (?ch=2)",
    r.body.includes("ch=2") && r.body.includes("الفصل التالي"));
  check("1a no previous-chapter link on chapter 1",
    !r.body.includes("الفصل السابق"));
  check("1a the BOOK's <script> is stripped (alert(1) gone)",
    !r.body.includes("alert(1)"));
  check("1a the READER's own script IS present (toolbar + freehand + notes store)",
    r.body.includes("rlb-chapter") && r.body.includes("caretRangeFromPoint")
    && r.body.includes("rlibook-reader-notes") && r.body.includes("rlb-freehand"));
  check("1a notes toolbar present (highlight / note / export / Drive)",
    r.body.includes("rlb-highlight") && r.body.includes("rlb-note")
    && r.body.includes("rlb-export-json") && r.body.includes("rlb-drive"));
  check("1a event handler stripped from the chapter",
    !r.body.includes('onclick="evil()"') && !r.body.includes("evil()"));
  check("1a javascript: link neutralised",
    !r.body.includes("javascript:"));
  check("1a honest trade-off note (browser reading does not add to the library)",
    r.body.includes("لا يُضاف إلى مكتبة جهازك"));
  check("1a delivery-page link present",
    r.body.includes("/kindle/get?lib=hindawi"));
  check("1a cache-control: no-store", r.cache === "no-store", r.cache);
  check("1a CSP header present (inline reader script + Google only)",
    (r.csp || "").includes("script-src 'unsafe-inline' https://accounts.google.com"), r.csp);
  check("1a X-Robots-Tag: noindex", (r.robots || "").includes("noindex"), r.robots);
  check("1a fetched the Hindawi acquisition URL",
    lastFetchUrl === "https://www.hindawi.org/books/13028368.epub", lastFetchUrl);
}
{
  fetchMode = "epub";
  const r = await call({ lib: "hindawi", id: "13028368", ch: "2" }, ENV);
  check("1b ?ch=2 renders chapter 2", r.status === 200
    && r.body.includes("هذا نص الفصل الثاني للاختبار")
    && !r.body.includes("هذا نص الفصل الأول للاختبار"), "status " + r.status);
  check("1b chapter 2 has a previous-chapter link, no next link",
    r.body.includes("الفصل السابق") && !r.body.includes("الفصل التالي"));
  check("1b chapter counter says 2 of 2", r.body.includes("الفصل 2 من 2"));
  check("1b nav links carry the reader token forward",
    r.body.includes("rtok=v1."), r.body.slice(0, 400));
  const clamped = await call({ lib: "hindawi", id: "13028368", ch: "99" }, ENV);
  check("1c ?ch=99 clamps to the last chapter (never a crash)",
    clamped.status === 200 && clamped.body.includes("الفصل 2 من 2"));
  const zero = await call({ lib: "hindawi", id: "13028368", ch: "0" }, ENV);
  check("1d ?ch=0 clamps to chapter 1",
    zero.status === 200 && zero.body.includes("الفصل 1 من 2"));
}
{
  fetchMode = "epub-long";
  const r = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("1e very long chapter is cut at the unit cap, with a note",
    r.status === 200 && r.body.length < MAX_UNIT_HTML_CHARS + 20000
    && r.body.includes("مقتطف"), "body length " + r.body.length);
}

// ================= 2. PDF + TXT rendering ============================
console.log("2. PDF + TXT rendering:");
{
  fetchMode = "pdf";
  const r = await call({ lib: "doab", id: "https://example.org/book.pdf", f: "pdf" }, ENV);
  check("2a PDF page 1: 200, first line rendered",
    r.status === 200 && r.body.includes("Hello PDF page one"), "status " + r.status);
  check("2a PDF page 1: second line (T*) rendered",
    r.body.includes("Second line here"));
  check("2a PDF page counter says 1 of 3 (صفحة)",
    r.body.includes("صفحة 1 من 3"));
  check("2a PDF page 2 text NOT on page 1",
    !r.body.includes("Page two text"));
  const p2 = await call({ lib: "doab", id: "https://example.org/book.pdf", f: "pdf", ch: "2" }, ENV);
  check("2b PDF page 2: TJ array with kern spaces -> 'Page two text'",
    p2.status === 200 && p2.body.includes("Page two text"), "status " + p2.status);
  const p3 = await call({ lib: "doab", id: "https://example.org/book.pdf", f: "pdf", ch: "3" }, ENV);
  check("2c PDF page 3: ToUnicode maps ABC -> XYZ",
    p3.status === 200 && p3.body.includes("XYZ") && !p3.body.includes(">ABC<"), "status " + p3.status);
  check("2c PDF title from /Title", p3.body.includes("Test PDF Book"));
  check("2c PDF reader has no download button and no bare file URL",
    !p3.body.includes("example.org/book.pdf") && !p3.body.includes(" download=")
    && !p3.body.includes("تنزيل الكتاب"));
}
{
  fetchMode = "txt";
  const r = await call({ lib: "doab", id: "https://example.org/book.txt", f: "txt" }, ENV);
  check("2d TXT book: 200, first paragraph rendered",
    r.status === 200 && r.body.includes("هذه فقرة من الكتاب النصي للاختبار"), "status " + r.status);
  check("2d TXT title from the first line",
    r.body.includes("عنوان الكتاب النصي"));
  check("2d TXT page counter present (صفحة)",
    r.body.includes("صفحة 1 من"));
}

// ================= 3. reader-token gate ==============================
console.log("3. Reader-token gate:");
{
  fetchMode = "epub";
  const noTok = await call({ lib: "hindawi", id: "13028368" }, ENV, mockFetch, { noToken: true });
  check("3a no rtok -> 403 with a link back to the delivery page",
    noTok.status === 403 && noTok.body.includes("/kindle/get?lib=hindawi"), "status " + noTok.status);
  const wrongBook = await call({
    lib: "hindawi", id: "13028368",
    rtok: await makeReaderToken(KEY, "hindawi", "99999999", "epub", 3600, Math.floor(Date.now() / 1000)),
  }, ENV);
  check("3b token for another book -> 403", wrongBook.status === 403, "status " + wrongBook.status);
  const wrongFmt = await call({
    lib: "doab", id: "https://example.org/book.pdf", f: "pdf",
    rtok: await makeReaderToken(KEY, "doab", "https://example.org/book.pdf", "epub", 3600, Math.floor(Date.now() / 1000)),
  }, ENV);
  check("3c token for another format -> 403", wrongFmt.status === 403, "status " + wrongFmt.status);
  const expired = await call({
    lib: "hindawi", id: "13028368",
    rtok: await makeReaderToken(KEY, "hindawi", "13028368", "epub", 60, Math.floor(Date.now() / 1000) - 3600),
  }, ENV);
  check("3d expired token -> 403", expired.status === 403, "status " + expired.status);
  const badKey = await call({
    lib: "hindawi", id: "13028368",
    rtok: await makeReaderToken("a-different-key-0123456789abcdef", "hindawi", "13028368", "epub", 3600, Math.floor(Date.now() / 1000)),
  }, ENV);
  check("3e token signed with another key -> 403", badKey.status === 403, "status " + badKey.status);
  const noKey = await call({ lib: "hindawi", id: "13028368" },
    { RLIBOOK_KV: makeKv(), PROXY_BASE_URL: "https://proxy.example.test" }, mockFetch, { noToken: true });
  check("3f signing key unset -> honest 503, no chapter",
    noKey.status === 503 && noKey.body.includes("غير مهيأة"), "status " + noKey.status);
  const ok = await verifyReaderToken(KEY,
    await makeReaderToken(KEY, "hindawi", "13028368", "epub", 3600, Math.floor(Date.now() / 1000)),
    { kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" });
  check("3g verifyReaderToken unit: a fresh token verifies", ok === true);
  const tampered = await makeReaderToken(KEY, "hindawi", "13028368", "epub", 3600, Math.floor(Date.now() / 1000));
  const parts = tampered.split(".");
  const tamperedPayload = parts[0] + "." + parts[1].replace(/^./, parts[1][0] === "A" ? "B" : "A") + "." + parts[2];
  check("3g verifyReaderToken unit: a tampered payload fails",
    (await verifyReaderToken(KEY, tamperedPayload,
      { kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" })) === false);
  const dlToken = "v1.eyJleHAiOjE5OTk5OTk5OTksImYiOiJlcHViIiwiaCI6ImhpbmRhd2kiLCJwIjoiMTMwMjgzNjgifQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  check("3g verifyReaderToken unit: a download token (no k:read) fails",
    (await verifyReaderToken(KEY, dlToken,
      { kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" })) === false);
}

// ================= 4. parsePdf / parseTxt / sanitize units ===========
console.log("4. parsePdf / parseTxt / sanitize units:");
{
  const pdf = await parsePdf(FIXTURE_PDF);
  check("4a parsePdf: title + 3 pages",
    pdf !== null && pdf.title === "Test PDF Book" && pdf.pages.length === 3,
    JSON.stringify(pdf && { title: pdf.title, n: pdf.pages.length }));
  check("4a parsePdf page 1 text (WinAnsi + T*)",
    pdf.pages[0].html.includes("Hello PDF page one") && pdf.pages[0].html.includes("Second line here"));
  check("4a parsePdf page 2 text (TJ kern -> spaces)",
    pdf.pages[1].html.includes("Page two text"));
  check("4a parsePdf page 3 text (ToUnicode ABC -> XYZ)",
    pdf.pages[2].html.includes("XYZ"));
  check("4a parsePdf: garbage bytes -> null",
    (await parsePdf(FAKE_GARBAGE)) === null);
  check("4a parsePdf: EPUB bytes -> null",
    (await parsePdf(FIXTURE_EPUB)) === null);
  const txt = parseTxt(FIXTURE_TXT);
  check("4b parseTxt: title + pages, first paragraph present",
    txt !== null && txt.title === "عنوان الكتاب النصي" && txt.pages.length >= 1
    && txt.pages[0].html.includes("هذه فقرة من الكتاب النصي"), JSON.stringify(txt && { n: txt.pages.length }));
  check("4b parseTxt: empty bytes -> null", parseTxt(new Uint8Array(0)) === null);
  const epub = await parseEpub(FIXTURE_EPUB);
  check("4c parseEpub: title + 2 chapters",
    epub !== null && epub.title === "كتاب اختبار" && epub.chapters.length === 2,
    JSON.stringify(epub && { title: epub.title, n: epub.chapters.length }));
  check("4c chapter titles from <h1>",
    epub.chapters[0].title === "الفصل الأول" && epub.chapters[1].title === "الفصل الثاني");
  check("4c deflated chapter 2 inflates (ZIP method 8)",
    epub.chapters[1].html.includes("هذا نص الفصل الثاني للاختبار"));
  check("4c parseEpub: garbage bytes -> null",
    (await parseEpub(FAKE_GARBAGE)) === null);
  check("4c parseEpub: empty ZIP-less PDF bytes -> null",
    (await parseEpub(FIXTURE_PDF)) === null);
  const dirty = '<body><p onclick="x()">a</p><script>bad()</script>'
    + '<style>.x{}</style><iframe src="e"></iframe><a href="javascript:bad()">b</a></body>';
  const clean = sanitizeChapterHtml(dirty);
  check("4d sanitize strips script/style/iframe/handlers/javascript:",
    !clean.includes("<script") && !clean.includes("onclick")
    && !clean.includes("javascript:") && !clean.includes("<iframe")
    && clean.includes("<p>a</p>"));
  check("4d sanitize keeps the body text",
    clean.includes("a") && clean.includes("b"));
}

// ================= 4b. RTL (bidi) reorder ============================
console.log("4b. RTL (bidi) reorder:");
{
  // Visual-order line (LibreOffice-style): words letter-reversed.
  // "هذه فقرة عربية رقم 8" stored visually, with a digit.
  const visual = "مقر ةيبرع ةرقف هذه 8";
  check("4b visual-order Arabic line reorders to logical",
    reorderBidiLine(visual) === "8 هذه فقرة عربية رقم", JSON.stringify(reorderBidiLine(visual)));
  check("4b logical-order Arabic line is left untouched",
    reorderBidiLine("هذه فقرة عربية رقم 8 من الكتاب") === "هذه فقرة عربية رقم 8 من الكتاب");
  check("4b Latin line is left untouched",
    reorderBidiLine("Hello world, this is a test.") === "Hello world, this is a test.");
  check("4b visual line with a lam-alef ligature (presentation form) reorders (forced, as a visual document does)",
    reorderBidiLine("رابتخﻻل", true) === "لﻻختبار", JSON.stringify(reorderBidiLine("رابتخﻻل", true)));
  const visStats = bidiVisualStats("مقر ةيبرع ةرقف هذه 8 مقر ةيبرع ةرقف هذه 9");
  check("4b bidiVisualStats: visual text has starts > ends",
    visStats.startsFinal > 0 && visStats.startsFinal > visStats.endsFinal, JSON.stringify(visStats));
  const logStats = bidiVisualStats("هذه فقرة عربية رقم 8 من الكتاب التجريبي");
  check("4b bidiVisualStats: logical text has ends > starts",
    logStats.endsFinal > 0 && logStats.endsFinal > logStats.startsFinal, JSON.stringify(logStats));
  check("4b bidiVisualStats: Latin text has no signal",
    bidiVisualStats("Hello world").startsFinal === 0
    && bidiVisualStats("Hello world").endsFinal === 0);
}

// ================= 5. notes export + client script ===================
console.log("5. Notes export + client script:");
{
  const items = [
    { text: "اقتباس أول", color: "yellow", note: "ملاحظة مهمة", unit: 1, createdAt: "2026-11-16T10:00:00.000Z" },
    { text: "اقتباس ثانٍ", color: "green", note: "", unit: 2, createdAt: "2026-11-16T11:00:00.000Z" },
    { text: "   ", color: "blue", note: "فارغ", unit: 2 },
  ];
  const exp = buildNotesExport(
    { title: "كتاب اختبار", bookKey: "hindawi:13028368:epub", format: "epub" }, items);
  check("5a export: JSON is valid, app/kind/count, blank quote dropped",
    (() => { try { const d = JSON.parse(exp.json); return d.app === "RliBook" && d.kind === "notes" && d.count === 2 && d.items.length === 2 && d.items[0].note === "ملاحظة مهمة" && d.book.key === "hindawi:13028368:epub"; } catch { return false; } })());
  check("5a export: Markdown has both quotes + the note, no book text",
    exp.markdown.includes("> اقتباس أول") && exp.markdown.includes("ملاحظة مهمة")
    && exp.markdown.includes("> اقتباس ثانٍ") && !exp.markdown.includes("هذا نص الفصل"));
  check("5a export: filenames are safe and branded",
    exp.jsonFilename === "كتاب_اختبار_notes.json" && exp.mdFilename === "كتاب_اختبار_notes.md",
    exp.jsonFilename + " / " + exp.mdFilename);
  check("5a export: empty items -> count 0, still valid JSON",
    buildNotesExport({ title: "x", bookKey: "k", format: "epub" }, []).count === 0);
  check("5b notesStorageKey is stable per book+format and hides the file URL",
    notesStorageKey({ kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" })
    === notesStorageKey({ kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" })
    && notesStorageKey({ kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" })
    !== notesStorageKey({ kind: "opds", lib: "hindawi", id: "13028368", fmt: "pdf" })
    && notesStorageKey({ kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "pdf" })
    !== notesStorageKey({ kind: "opds", lib: "hindawi", id: "13028368", fmt: "pdf" })
    && !notesStorageKey({ kind: "opds", lib: "doab", id: "https://example.org/book.pdf", fmt: "pdf" })
      .includes("example.org"));
  let scriptOk = false;
  try { new Function(CLIENT_SCRIPT); scriptOk = true; } catch { scriptOk = false; }
  check("5c CLIENT_SCRIPT parses (ES5, no syntax error)", scriptOk);
  check("5c CLIENT_SCRIPT has freehand touch selection + Drive sync + export",
    CLIENT_SCRIPT.includes("caretRangeFromPoint")
    && CLIENT_SCRIPT.includes("setBaseAndExtent")
    && CLIENT_SCRIPT.includes("accounts.google.com/gsi/client")
    && CLIENT_SCRIPT.includes("drive.file")
    && CLIENT_SCRIPT.includes("createObjectURL")
    && CLIENT_SCRIPT.includes("localStorage"));
  check("5c CLIENT_SCRIPT never fetches a book and has no download button for it",
    !CLIENT_SCRIPT.includes("/kindle/get") && !CLIENT_SCRIPT.includes("proxyDownloadUrl"));
}

// ================= 6. refusals / failures ============================
console.log("6. Refusals / failures:");
{
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { ...ENV, RLIBOOK_KV: kv };
  fetchMode = "epub";
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559" }, env);
  check("6a flagged Telegram book -> 403, no fetch, no chapter",
    r.status === 403 && r.body.includes("كتاب تجاري"), "status " + r.status);
  const unflagged = await call({ lib: "tg", h: "kotobkhana", p: "7558" }, env);
  check("6a unflagged Telegram book renders (proxy URL fetched)",
    unflagged.status === 200 && lastFetchUrl.startsWith(ENV.PROXY_BASE_URL + "/dl?h=kotobkhana&p=7558"),
    lastFetchUrl);
}
{
  fetchMode = "pdf";
  const r = await call({ lib: "hindawi", id: "13028368", f: "pdf" }, ENV);
  check("6b Hindawi PDF -> honest 400 (Hindawi serves EPUB only)",
    r.status === 400 && r.body.includes("EPUB فقط"), "status " + r.status);
  const mobi = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "mobi" }, ENV);
  check("6b MOBI book -> 400 with the delivery-page link",
    mobi.status === 400 && mobi.body.includes("/kindle/get?lib=tg")
    && mobi.body.includes("EPUB وPDF وTXT"), "status " + mobi.status);
  fetchMode = "html";
  const html = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("6c Drive HTML warning page -> 502, no chapter",
    html.status === 502 && !html.body.includes("الفصل الأول"), "status " + html.status);
  fetchMode = "garbage";
  const bad = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("6d bad magic bytes -> 502",
    bad.status === 502, "status " + bad.status);
  fetchMode = "oversize";
  const big = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("6e oversized file (content-length) -> 413",
    big.status === 413, "status " + big.status);
  fetchMode = "fail";
  const down = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("6f source fetch throws -> 502, never a crash",
    down.status === 502, "status " + down.status);
  fetchMode = "epub";
  const badLib = await call({ lib: "nope", id: "1234567890" }, ENV);
  check("6g bad lib -> 400", badLib.status === 400, "status " + badLib.status);
  const noProxy = await call({ lib: "tg", h: "kotobkhana", p: "7559" },
    { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY });
  check("6h Telegram book, proxy unconfigured -> honest 503",
    noProxy.status === 503, "status " + noProxy.status);
}

// ================= 4. REGRESSION (1102): lazy single-chapter parse ===
// The old onRequest called parseEpub(), which inflated, decoded and
// sanitised EVERY chapter on EVERY request — 105–200 ms CPU for a
// 150-chapter book against Cloudflare's 10 ms free-tier budget.
// The new path (parseEpubChapter) inflates only the chapter being
// shown. These tests FAIL on the old code (no parseEpubChapter;
// onRequest CPU ~100+ ms) and PASS with the fix.
console.log("4. Lazy chapter (1102 regression):");
{
  // Big-book fixture: 150 deflated chapters, ~11 KB XHTML each
  // (~1.6 MB of chapter HTML — a realistic novel).
  const N = 150;
  const PARA = "<p>هذا نص عربي طويل للفصل من أجل قياس الأداء. </p>".repeat(200);
  let bigManifest = "", bigSpine = "";
  const bigFiles = [
    { name: "mimetype", data: enc.encode("application/epub+zip"), method: 0 },
    { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
  ];
  for (let i = 1; i <= N; i++) {
    const xhtml = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>الفصل ${i}</title></head><body><h1>الفصل ${i}</h1>${PARA}</body></html>`;
    bigFiles.push({ name: `OEBPS/ch${i}.xhtml`, data: enc.encode(xhtml), method: 8 });
    bigManifest += `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>\n`;
    bigSpine += `<itemref idref="ch${i}"/>`;
  }
  const BIG_OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>رواية كبيرة</dc:title></metadata><manifest>${bigManifest}</manifest><spine>${bigSpine}</spine></package>`;
  bigFiles.splice(2, 0, { name: "OEBPS/content.opf", data: enc.encode(BIG_OPF), method: 0 });
  const BIG_EPUB = buildZip(bigFiles);

  const cpuMs = (start) => {
    const d = process.cpuUsage(start);
    return (d.user + d.system) / 1000;
  };
  // Warmup (JIT + DecompressionStream pool) so the measurement is
  // the steady-state cost, not the first-call cost.
  await parseEpub(BIG_EPUB);
  await parseEpubChapter(BIG_EPUB, 0);

  const one = await parseEpubChapter(BIG_EPUB, 0);
  check("4a parseEpubChapter: chapter 1 only, totalChapters = 150",
    one !== null && one.chapterNumber === 1 && one.totalChapters === N
    && one.chapter.title === "الفصل 1" && one.title === "رواية كبيرة",
    JSON.stringify(one && { n: one.chapterNumber, total: one.totalChapters }));
  check("4a parseEpubChapter: chapter 1 HTML is only chapter 1",
    one.chapter.html.includes("الفصل 1") && !one.chapter.html.includes("الفصل 2"));
  const last = await parseEpubChapter(BIG_EPUB, N - 1);
  check("4a parseEpubChapter: last chapter (150) renders",
    last !== null && last.chapterNumber === N && last.chapter.title === "الفصل 150");
  const clampedHigh = await parseEpubChapter(BIG_EPUB, 999);
  check("4a parseEpubChapter: index 999 clamps to the last chapter",
    clampedHigh !== null && clampedHigh.chapterNumber === N);
  const clampedLow = await parseEpubChapter(BIG_EPUB, -5);
  check("4a parseEpubChapter: negative index clamps to chapter 1",
    clampedLow !== null && clampedLow.chapterNumber === 1);
  const index = await parseEpubIndex(BIG_EPUB);
  check("4a parseEpubIndex: title + 150 spine paths, no chapter inflated",
    index !== null && index.title === "رواية كبيرة" && index.spine.length === N,
    JSON.stringify(index && { title: index.title, spine: index.spine.length }));
  const full = await parseEpub(BIG_EPUB);
  check("4b parseEpub (compat): still returns all 150 chapters",
    full !== null && full.chapters.length === N);

  // CPU: one chapter must cost a small fraction of the whole book.
  // (Ratio, not an absolute ms bound, so the test is not tied to
  // one machine's speed.)
  let t = process.cpuUsage();
  await parseEpub(BIG_EPUB);
  const fullMs = cpuMs(t);
  t = process.cpuUsage();
  await parseEpubChapter(BIG_EPUB, 0);
  const oneMs = cpuMs(t);
  console.log(`    (big book: full parse ${fullMs.toFixed(1)} ms CPU, one chapter ${oneMs.toFixed(1)} ms CPU)`);
  check("4c REGRESSION: one chapter costs < 25% of a full-book parse",
    oneMs < fullMs * 0.25, `one=${oneMs.toFixed(1)}ms full=${fullMs.toFixed(1)}ms`);
  check("4c REGRESSION: full-book parse is itself over the 10 ms budget (why the old code 1102'd)",
    fullMs > 10, `full=${fullMs.toFixed(1)}ms`);

  // End to end: onRequest renders ch=1 AND ch=150 from the big book,
  // with a small CPU budget, and a corrupt LATER chapter never
  // blocks chapter 1 (it is never inflated for ?ch=1).
  const bigFetch = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/epub+zip" : n.toLowerCase() === "content-length" ? String(BIG_EPUB.length) : null) },
    async arrayBuffer() { return BIG_EPUB.buffer.slice(BIG_EPUB.byteOffset, BIG_EPUB.byteOffset + BIG_EPUB.byteLength); },
  });
  t = process.cpuUsage();
  const r1 = await call({ lib: "hindawi", id: "13028368" }, ENV, bigFetch);
  const reqMs = cpuMs(t);
  check("4d onRequest big book ch=1: 200, chapter 1 text, counter 1 of 150",
    r1.status === 200 && r1.body.includes("الفصل 1") && r1.body.includes("الفصل 1 من 150"),
    `status=${r1.status}`);
  check("4d onRequest big book ch=1: chapter 150 text NOT on page 1",
    !r1.body.includes("الفصل 150</h2>"));
  check("4d REGRESSION: onRequest on the big book stays well under the old full-parse cost",
    reqMs < fullMs * 0.5, `request=${reqMs.toFixed(1)}ms full-parse=${fullMs.toFixed(1)}ms`);
  const r150 = await call({ lib: "hindawi", id: "13028368", ch: "150" }, ENV, bigFetch);
  check("4d onRequest big book ch=150: 200, chapter 150 text",
    r150.status === 200 && r150.body.includes("الفصل 150") && r150.body.includes("الفصل 150 من 150"),
    `status=${r150.status}`);
  // Corrupt chapter 150 (unsupported ZIP method 99): chapter 1 must
  // still render — the lazy path never touches chapter 150 for ?ch=1.
  const corruptFiles = bigFiles.map((f) => f.name === "OEBPS/ch150.xhtml" ? { ...f, method: 99 } : f);
  const CORRUPT_EPUB = buildZip(corruptFiles);
  const corruptFetch = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/epub+zip" : n.toLowerCase() === "content-length" ? String(CORRUPT_EPUB.length) : null) },
    async arrayBuffer() { return CORRUPT_EPUB.buffer.slice(CORRUPT_EPUB.byteOffset, CORRUPT_EPUB.byteOffset + CORRUPT_EPUB.byteLength); },
  });
  const rc = await call({ lib: "hindawi", id: "13028368" }, ENV, corruptFetch);
  check("4e corrupt LAST chapter: ch=1 still renders 200",
    rc.status === 200 && rc.body.includes("الفصل 1"), `status=${rc.status}`);
  const rc150 = await call({ lib: "hindawi", id: "13028368", ch: "150" }, ENV, corruptFetch);
  check("4e corrupt LAST chapter: ch=150 is an honest 502, not a crash",
    rc150.status === 502, `status=${rc150.status}`);
}

// ================= 7. Token renewal + own books (round 2) ===========
console.log("7. Token renewal + own books:");
{
  fetchMode = "epub";
  const now = Math.floor(Date.now() / 1000);
  const oldTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub", 3600, now - 3500);
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", rtok: oldTok }, ENV);
  check("7a nearly-expired token still renders the chapter",
    r.status === 200 && r.body.includes("هذا نص الفصل الأول للاختبار"), "status " + r.status);
  const navToks = rtoksIn(r.body);
  check("7a2 nav links carry a FRESH token (not the incoming one)",
    navToks.length === 1 && navToks[0] !== oldTok,
    "nav tokens: " + navToks.length);
  check("7b the fresh nav token verifies for the book",
    navToks.length === 1 && (await verifyReaderToken(KEY, navToks[0],
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" })) === true);
  check("7g client renewal timer present in the page",
    r.body.includes("setTimeout(renew,50*60*1000)")
    && r.body.includes("/api/read-token?lib=tg")
    && r.body.includes("window.fetch"),
    r.body.slice(r.body.indexOf("renew"), r.body.indexOf("renew") + 120));
  check("7h the renewal base names this book",
    r.body.includes("/api/read-token?lib=tg&amp;h=kotobkhana&amp;p=7559")
    || r.body.includes("/api/read-token?lib=tg&h=kotobkhana&p=7559"),
    r.body.slice(0, 400));
}
{
  // Flagged AFTER the token was minted: the ENTRY flag check stops
  // reading at once (the next chapter request 403s) — it does not
  // wait for the token to expire. The renewal re-check is
  // defence-in-depth behind that entry check (KV reads can be
  // stale across colos, so the second read may catch what the
  // first missed); it never mints a fresh token for a flagged book.
  fetchMode = "epub";
  const now = Math.floor(Date.now() / 1000);
  const oldTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub", 3600, now - 3500);
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { ...ENV, RLIBOOK_KV: kv };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", rtok: oldTok }, env);
  check("7c flagged-mid-read: entry flag check stops reading at once -> 403",
    r.status === 403 && r.body.includes("كتاب تجاري"), "status " + r.status);
  const navToks = rtoksIn(r.body);
  check("7c2 no chapter, no fresh token on the 403 page",
    navToks.length === 0 && !r.body.includes("هذا نص الفصل الأول للاختبار"),
    "nav tokens: " + navToks.length);
}
{
  // Own token (payload o:1) on a flagged book: the entry flag gate
  // is skipped. On a hidden book it is not: hide wins.
  fetchMode = "epub";
  const now = Math.floor(Date.now() / 1000);
  const ownTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub", 3600, now, true);
  check("7d setup: the token is own",
    (await readerTokenOwn(KEY, ownTok)) === true);
  const kvFlag = makeKv({ "flag:kotobkhana:7559": "1" });
  const rFlag = await call({ lib: "tg", h: "kotobkhana", p: "7559", rtok: ownTok },
    { ...ENV, RLIBOOK_KV: kvFlag });
  check("7d own token on a flagged book -> 200 (entry flag gate skipped)",
    rFlag.status === 200 && rFlag.body.includes("هذا نص الفصل الأول للاختبار"),
    "status " + rFlag.status);
  const kvHide = makeKv({ "hidden:kotobkhana:7559": "owner" });
  const rHide = await call({ lib: "tg", h: "kotobkhana", p: "7559", rtok: ownTok },
    { ...ENV, RLIBOOK_KV: kvHide });
  check("7e own token on a HIDDEN book -> 403 (hide wins at entry)",
    rHide.status === 403 && rHide.body.includes("أزاله المالك"), "status " + rHide.status);
  const libTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub", 3600, now);
  const rLibHide = await call({ lib: "tg", h: "kotobkhana", p: "7559", rtok: libTok },
    { ...ENV, RLIBOOK_KV: kvHide });
  check("7f library token on a hidden book -> 403 (entry hidden check)",
    rLibHide.status === 403 && rLibHide.body.includes("أزاله المالك"),
    "status " + rLibHide.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
