// Test for the Send-to-Kindle endpoint (functions/api/send-to-kindle.js).
// Standalone Node script — run from the repo root:
//   node functions/api/send-to-kindle.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock of
// the Pages Function environment (env.RLIBOOK_KV as a Map, env as plain
// vars), mocks fetch twice over (book source + Resend API), and calls
// onRequest() over HTTP semantics. It asserts the response contract for:
//   1. fp path: fingerprint -> tg_id -> kindle_email, EPUB sent via Resend
//   2. to path: typed @kindle.com address, PDF sent
//   3. no fp, no to -> the email form page (no send)
//   4. bad typed email -> form page again, no send
//   5. unknown fingerprint -> 400, no send
//   6. fingerprint without a stored Kindle email -> 400, no send
//   7. Drive HTML interstitial (text/html) -> 502, no send
//   8. oversized file (Content-Length > 25 MB) -> 413, no send
//   9. bad magic bytes -> 502, no send
//  10. MOBI format -> 400 (Send-to-Kindle rejects MOBI by email), no fetch
//  11. missing RESEND_API_KEY -> 503, no send
//  12. missing KV binding -> 503
//  13. destination daily cap reached -> 429, no send
//  14. Resend non-2xx -> 502 error page, no crash
//  15. resolveAcquisitionUrl for drive / hindawi / doab / bad inputs
//  16. safeFilename: Arabic title -> generic name; Latin title -> kept
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no Resend key, no deploy.
// All emails / fingerprints below are FAKE test data — never a real address.

import {
  onRequest,
  resolveAcquisitionUrl,
  safeFilename,
  isKindleEmail,
  magicBytesOk,
  MAX_FILE_BYTES,
  DAILY_PER_DEST,
  RESEND_API_URL,
} from "./send-to-kindle.js";

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

// --- mocks -------------------------------------------------------------
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

const FAKE_EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]); // PK..
const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]); // %PDF
const FAKE_HTML = new TextEncoder().encode("<html>Drive warning</html>");

function bookResponse(bytes, contentType = "application/epub+zip", contentLength = null) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n) => {
        const k = n.toLowerCase();
        if (k === "content-type") return contentType;
        if (k === "content-length") return contentLength === null ? String(bytes.length) : String(contentLength);
        return null;
      },
    },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

/** Build a mock fetch. bookBytes: what the book source returns.
 *  resendStatus: HTTP status the Resend mock returns. Captures every
 *  Resend call (url, headers, parsed body) in calls.resend. */
function makeFetch({ bookBytes = FAKE_EPUB, bookType, bookLength = null, resendStatus = 200 } = {}) {
  const calls = { resend: [], book: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith(RESEND_API_URL)) {
      calls.resend.push({ url, headers: opts.headers || {}, body: JSON.parse(opts.body || "{}") });
      return {
        ok: resendStatus >= 200 && resendStatus < 300,
        status: resendStatus,
        async json() { return resendStatus === 200 ? { id: "re_test123" } : { error: { message: "forbidden" } }; },
      };
    }
    calls.book.push({ url });
    return bookResponse(bookBytes, bookType, bookLength);
  };
  return { fetchImpl, calls };
}

function makeCtx({ kv, apiKey = "re_test_key", fetchImpl, params }) {
  const url = "https://rlibook.tech/api/send-to-kindle?" + new URLSearchParams(params).toString();
  return {
    request: new Request(url, { method: "GET", headers: { "cf-connecting-ip": "1.2.3.4" } }),
    env: { RLIBOOK_KV: kv, RESEND_API_KEY: apiKey },
    _fetchImpl: fetchImpl,
  };
}

// onRequest uses the global fetch — swap it per test.
async function run(ctx, fetchImpl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await onRequest(ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const FP = "fp_test_token_abc";
const TG_ID = 7283934644; // same shape as production, fake pairing here
const KINDLE_EMAIL = "testuser@kindle.com";

// --- 15/16. pure helpers ------------------------------------------------
check("resolveAcquisitionUrl drive", resolveAcquisitionUrl("khazendar", "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq")
  === "https://drive.google.com/uc?id=1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq&export=download");
check("resolveAcquisitionUrl hindawi", resolveAcquisitionUrl("hindawi", "13028368")
  === "https://www.hindawi.org/books/13028368.epub");
check("resolveAcquisitionUrl doab", resolveAcquisitionUrl("doab", "https://library.oapen.org/x.epub")
  === "https://library.oapen.org/x.epub");
check("resolveAcquisitionUrl bad lib", resolveAcquisitionUrl("nope", "123") === null);
check("resolveAcquisitionUrl bad drive id", resolveAcquisitionUrl("khazendar", "a b") === null);
check("resolveAcquisitionUrl bad hindawi id", resolveAcquisitionUrl("hindawi", "abc") === null);
check("safeFilename latin title", safeFilename("Yawmiyat Naib", "hindawi", "13028368", "epub") === "Yawmiyat_Naib.epub");
check("safeFilename arabic title falls back", safeFilename("يوميات نائب في الأرياف", "hindawi", "13028368", "epub") === "rlibook-hindawi-13028368.epub");
check("isKindleEmail accepts", isKindleEmail("Name@Kindle.COM") === true);
check("isKindleEmail rejects gmail", isKindleEmail("a@gmail.com") === false);
check("magicBytesOk epub PK", magicBytesOk(FAKE_EPUB, "epub") === true);
check("magicBytesOk pdf %PDF", magicBytesOk(FAKE_PDF, "pdf") === true);
check("magicBytesOk epub rejects html", magicBytesOk(FAKE_HTML, "epub") === false);

// --- 1. fp path success --------------------------------------------------
{
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID, created_at: "2026-11-12T00:00:00Z" }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "لؤلؤة الحب", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("1 fp path: 200 + confirmation", res.status === 200 && body.includes("تم الإرسال"), `status=${res.status}`);
  check("1 fp path: masked email shown", body.includes("te***@kindle.com"), body.slice(0, 200));
  check("1 fp path: one Resend call", calls.resend.length === 1, `calls=${calls.resend.length}`);
  const c = calls.resend[0];
  check("1 fp path: Resend from", c.body.from === "RliBook <send@rlibook.tech>");
  check("1 fp path: Resend to", JSON.stringify(c.body.to) === JSON.stringify([KINDLE_EMAIL]));
  check("1 fp path: User-Agent header (else 403)", c.headers["User-Agent"] === "RliBook-bot/1.0");
  check("1 fp path: attachment filename .epub", c.body.attachments[0].filename.endsWith(".epub"));
  check("1 fp path: attachment is base64 of the book",
    c.body.attachments[0].content === Buffer.from(FAKE_EPUB).toString("base64"));
  check("1 fp path: book fetched from Hindawi", calls.book.length === 1 && calls.book[0].url.includes("hindawi.org"));
}

// --- 2. to path success (Drive PDF) ---------------------------------------
{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({ bookBytes: FAKE_PDF, bookType: "application/pdf" });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "khazendar", id: "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq", f: "pdf", t: "Test Book", to: "Other@kindle.com" } }),
    fetchImpl,
  );
  const body = await res.text();
  check("2 to path: 200 + confirmation", res.status === 200 && body.includes("تم الإرسال"), `status=${res.status}`);
  check("2 to path: Resend to typed address", calls.resend.length === 1 && calls.resend[0].body.to[0] === "other@kindle.com");
  check("2 to path: .pdf attachment", calls.resend[0].body.attachments[0].filename.endsWith(".pdf"));
}

// --- 3. no fp, no to -> form ----------------------------------------------
{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "لؤلؤة الحب" } }),
    fetchImpl,
  );
  const body = await res.text();
  check("3 no identity: 200 form page", res.status === 200 && body.includes("<form") && body.includes("name@kindle.com"));
  check("3 no identity: nothing sent", calls.resend.length === 0 && calls.book.length === 0);
}

// --- 4. bad typed email -> form again --------------------------------------
{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", to: "a@gmail.com" } }),
    fetchImpl,
  );
  const body = await res.text();
  check("4 bad email: form shown again", res.status === 200 && body.includes("<form"));
  check("4 bad email: nothing sent", calls.resend.length === 0);
}

// --- 5. unknown fingerprint -> 400 -----------------------------------------
{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: "fp_unknown" } }),
    fetchImpl,
  );
  const body = await res.text();
  check("5 unknown fp: 400 + bot hint", res.status === 400 && body.includes("RliBook_bot"));
  check("5 unknown fp: form offered", body.includes("<form"));
  check("5 unknown fp: nothing sent", calls.resend.length === 0);
}

// --- 6. fp without stored kindle email -> 400 ------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }) });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("6 fp, no email: 400", res.status === 400);
  check("6 fp, no email: nothing sent", calls.resend.length === 0);
}

// --- 7. Drive HTML interstitial -> 502 --------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ bookBytes: FAKE_HTML, bookType: "text/html; charset=utf-8" });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "khazendar", id: "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("7 html interstitial: 502", res.status === 502, `status=${res.status}`);
  check("7 html interstitial: nothing sent", calls.resend.length === 0);
  check("7 html interstitial: explains Drive", body.includes("Drive"));
}

// --- 8. oversized -> 413 ----------------------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ bookBytes: FAKE_EPUB, bookLength: MAX_FILE_BYTES + 1 });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("8 oversized: 413", res.status === 413, `status=${res.status}`);
  check("8 oversized: nothing sent", calls.resend.length === 0);
}

// --- 9. bad magic bytes -> 502 ------------------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ bookBytes: new TextEncoder().encode("not a book at all"), bookType: "application/epub+zip" });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("9 bad magic: 502", res.status === 502, `status=${res.status}`);
  check("9 bad magic: nothing sent", calls.resend.length === 0);
}

// --- 10. MOBI refused before any fetch -----------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "khazendar", id: "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq", f: "mobi", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("10 mobi: 400", res.status === 400, `status=${res.status}`);
  check("10 mobi: no book fetch, no send", calls.book.length === 0 && calls.resend.length === 0);
}

// --- 11. missing API key -> 503 ---------------------------------------------------
{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, apiKey: "", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", to: KINDLE_EMAIL } }),
    fetchImpl,
  );
  check("11 no api key: 503", res.status === 503, `status=${res.status}`);
  check("11 no api key: nothing sent", calls.resend.length === 0 && calls.book.length === 0);
}

// --- 12. missing KV -> 503 ---------------------------------------------------------
{
  const { fetchImpl, calls } = makeFetch({});
  const ctx = makeCtx({ kv: null, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", to: KINDLE_EMAIL } });
  ctx.env.RLIBOOK_KV = undefined;
  const res = await run(ctx, fetchImpl);
  check("12 no KV: 503", res.status === 503, `status=${res.status}`);
  check("12 no KV: nothing sent", calls.resend.length === 0);
}

// --- 13. destination daily cap -> 429 ----------------------------------------------
{
  const day = new Date().toISOString().slice(0, 10);
  const { createHash } = await import("node:crypto");
  const destHash = createHash("sha256").update(KINDLE_EMAIL).digest("hex");
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
    [`stk:dest:${destHash}:${day}`]: String(DAILY_PER_DEST),
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("13 dest cap: 429", res.status === 429, `status=${res.status}`);
  check("13 dest cap: nothing sent", calls.resend.length === 0 && calls.book.length === 0);
}

// --- 14. Resend 403 -> 502 -----------------------------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 403 });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("14 resend 403: 502 error page", res.status === 502, `status=${res.status}`);
  check("14 resend 403: attempted once", calls.resend.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
