// Test for the plain-HTML reader (functions/read.js).
// Standalone Node script — run from the repo root:
//   node functions/read.test.mjs
//
// It imports the real Function module, mocks global fetch so the
// book source is served from a small EPUB fixture built in this
// file (a minimal ZIP: container.xml + OPF + 2 XHTML chapters —
// chapter 1 stored, chapter 2 deflated, so both ZIP methods are
// covered), and calls onRequest() over HTTP semantics. It asserts:
//   1. an EPUB renders chapter 1 as plain HTML with no <script>,
//      and ?ch=2 renders chapter 2, with prev/next navigation;
//   2. parseEpub unit: title + chapters + chapter titles;
//   3. sanitizeChapterHtml strips script/style/iframe, event
//      handlers and javascript: links;
//   4. a flagged Telegram book -> 403; a PDF book -> 400 with the
//      delivery-page link; a Drive HTML warning page -> 502; bad
//      magic bytes -> 502; an oversized file -> 413; a bad book
//      identity -> 400;
//   5. cache-control: no-store on the chapter page.
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. All book data below is FAKE test data.

import { deflateRawSync } from "node:zlib";
import { onRequest, parseEpub, sanitizeChapterHtml, MAX_FILE_BYTES } from "./read.js";

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

const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]);
const FAKE_HTML = enc.encode("<html>Drive warning page</html>");
const FAKE_GARBAGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// ---- mock fetch ------------------------------------------------------
let fetchMode = "epub"; // epub | pdf | html | garbage | fail | oversize
let lastFetchUrl = "";
function mockFetch(url, opts = {}) {
  lastFetchUrl = String(url);
  if (fetchMode === "fail") throw new Error("network down");
  const bytes = fetchMode === "epub" ? FIXTURE_EPUB
    : fetchMode === "pdf" ? FAKE_PDF
    : fetchMode === "html" ? FAKE_HTML
    : FAKE_GARBAGE;
  const type = fetchMode === "html" ? "text/html; charset=utf-8" : "application/epub+zip";
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

async function call(params, env, fetchImpl = mockFetch) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const url = "https://rlibook.tech/read?" + new URLSearchParams(params).toString();
    const res = await onRequest({
      request: new Request(url, { method: "GET" }),
      env,
    });
    return { status: res.status, body: await res.text(), cache: res.headers.get("cache-control") };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ENV = {
  RLIBOOK_KV: makeKv(),
  PROXY_SIGNING_KEY: "test_signing_key_0123456789abcdef",
  PROXY_BASE_URL: "https://proxy.example.test",
};

// ================= 1. chapter rendering ==============================
console.log("1. Chapter rendering:");
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
  check("1a NO <script> anywhere (sanitised chapter + script-free page)",
    !r.body.toLowerCase().includes("<script"));
  check("1a event handler stripped from the chapter",
    !r.body.includes("onclick") && !r.body.includes("evil()"));
  check("1a javascript: link neutralised",
    !r.body.includes("javascript:"));
  check("1a honest trade-off note (browser reading does not add to the library)",
    r.body.includes("لا يُضاف إلى مكتبة جهازك"));
  check("1a delivery-page link present",
    r.body.includes("/kindle/get?lib=hindawi"));
  check("1a cache-control: no-store", r.cache === "no-store", r.cache);
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
  const clamped = await call({ lib: "hindawi", id: "13028368", ch: "99" }, ENV);
  check("1c ?ch=99 clamps to the last chapter (never a crash)",
    clamped.status === 200 && clamped.body.includes("الفصل 2 من 2"));
  const zero = await call({ lib: "hindawi", id: "13028368", ch: "0" }, ENV);
  check("1d ?ch=0 clamps to chapter 1",
    zero.status === 200 && zero.body.includes("الفصل 1 من 2"));
}

// ================= 2. parseEpub / sanitize units =====================
console.log("2. parseEpub / sanitize units:");
{
  const epub = await parseEpub(FIXTURE_EPUB);
  check("2a parseEpub: title + 2 chapters",
    epub !== null && epub.title === "كتاب اختبار" && epub.chapters.length === 2,
    JSON.stringify(epub && { title: epub.title, n: epub.chapters.length }));
  check("2a chapter titles from <h1>",
    epub.chapters[0].title === "الفصل الأول" && epub.chapters[1].title === "الفصل الثاني");
  check("2a deflated chapter 2 inflates (ZIP method 8)",
    epub.chapters[1].html.includes("هذا نص الفصل الثاني للاختبار"));
  check("2b parseEpub: garbage bytes -> null",
    (await parseEpub(FAKE_GARBAGE)) === null);
  check("2b parseEpub: empty ZIP-less PDF bytes -> null",
    (await parseEpub(FAKE_PDF)) === null);
  const dirty = '<body><p onclick="x()">a</p><script>bad()</script>'
    + '<style>.x{}</style><iframe src="e"></iframe><a href="javascript:bad()">b</a></body>';
  const clean = sanitizeChapterHtml(dirty);
  check("2c sanitize strips script/style/iframe/handlers/javascript:",
    !clean.includes("<script") && !clean.includes("onclick")
    && !clean.includes("javascript:") && !clean.includes("<iframe")
    && clean.includes("<p>a</p>"));
  check("2c sanitize keeps the body text",
    clean.includes("a") && clean.includes("b"));
}

// ================= 3. refusals / failures ============================
console.log("3. Refusals / failures:");
{
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { ...ENV, RLIBOOK_KV: kv };
  fetchMode = "epub";
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559" }, env);
  check("3a flagged Telegram book -> 403, no fetch, no chapter",
    r.status === 403 && r.body.includes("كتاب تجاري"), "status " + r.status);
  const unflagged = await call({ lib: "tg", h: "kotobkhana", p: "7558" }, env);
  check("3a unflagged Telegram book renders (proxy URL fetched)",
    unflagged.status === 200 && lastFetchUrl.startsWith(ENV.PROXY_BASE_URL + "/dl?h=kotobkhana&p=7558"),
    lastFetchUrl);
}
{
  fetchMode = "pdf";
  const r = await call({ lib: "hindawi", id: "13028368", f: "pdf" }, ENV);
  check("3b PDF book -> 400 with the delivery-page link",
    r.status === 400 && r.body.includes("/kindle/get?lib=hindawi")
    && r.body.includes("EPUB فقط"), "status " + r.status);
  fetchMode = "html";
  const html = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("3c Drive HTML warning page -> 502, no chapter",
    html.status === 502 && !html.body.includes("الفصل الأول"), "status " + html.status);
  fetchMode = "garbage";
  const bad = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("3d bad magic bytes -> 502",
    bad.status === 502, "status " + bad.status);
  fetchMode = "oversize";
  const big = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("3e oversized file (content-length) -> 413",
    big.status === 413, "status " + big.status);
  fetchMode = "fail";
  const down = await call({ lib: "hindawi", id: "13028368" }, ENV);
  check("3f source fetch throws -> 502, never a crash",
    down.status === 502, "status " + down.status);
  fetchMode = "epub";
  const badLib = await call({ lib: "nope", id: "1234567890" }, ENV);
  check("3g bad lib -> 400", badLib.status === 400, "status " + badLib.status);
  const noProxy = await call({ lib: "tg", h: "kotobkhana", p: "7559" },
    { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: "k" });
  check("3h Telegram book, proxy unconfigured -> honest 503",
    noProxy.status === 503, "status " + noProxy.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
