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
//  16. safeFilename: title kept as-is (Arabic/UTF-8 included); empty or unsafe-only title -> generic name
//  34. Resend 429 (daily cap) -> Brevo sends, 200 confirmation
//  35. Brevo request shape: api-key header, User-Agent, sender, attachment
//  36. Resend 429 + Brevo 429 + SMTP2GO 429 -> tomorrow page + stk:queue: entry in KV
//  37. Resend 500 (non-429) -> Brevo fallback still sends
//  38. no Resend key + Brevo key -> sends via Brevo (no 503)
//  39. neither key -> 503, no send
//  40. sendEmailWithFallback unit: all three 429 + no queue -> E_BOTH_EXHAUSTED;
//      all three non-429 -> E_SEND_FAILED, never queued
//  41. enqueueTomorrow: idempotent per (destination + book + day)
//  42. Resend 429 + Brevo 500 -> SMTP2GO sends, 200 confirmation
//  43. SMTP2GO request shape: X-Smtp2go-Api-Key header, User-Agent,
//      bare-address sender, to array, EPUB fileblob + mimetype
//  44. SMTP2GO-only key -> sends via SMTP2GO (no 503)
//  45. all three non-429 -> 502 error page, never queued
//  46. sendEmailWithFallback unit: SMTP2GO 200 with succeeded 0 is a
//      failure (falls through to the queue path); SMTP2GO success
//      returns provider "smtp2go" with the email_id
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no Resend key, no deploy.
// All emails / fingerprints below are FAKE test data — never a real address.

import {
  onRequest,
  resolveAcquisitionUrl,
  safeFilename,
  isKindleEmail,
  magicBytesOk,
  dedupeKeyFor,
  proxyDownloadUrl,
  enqueueTomorrow,
  MAX_FILE_BYTES,
  DAILY_PER_DEST,
  DAILY_PER_IP,
  DEDUPE_TTL_SECONDS,
  RESEND_API_URL,
} from "./send-to-kindle.js";
import {
  BREVO_API_URL,
  SMTP2GO_API_URL,
  buildBrevoRequest,
  buildSmtp2goRequest,
  sendEmailWithFallback,
  smtp2goMimeFor,
} from "./email-send.js";

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
 *  resendStatus: HTTP status the Resend mock returns. brevoStatus:
 *  HTTP status the Brevo mock returns (201 = success). smtp2goStatus:
 *  HTTP status the SMTP2GO mock returns (200 = success, with a
 *  { data: { succeeded: 1, email_id } } body, mirroring the real
 *  API). Captures every Resend call (url, headers, parsed body) in
 *  calls.resend, every Brevo call in calls.brevo, and every SMTP2GO
 *  call in calls.smtp2go. */
function makeFetch({ bookBytes = FAKE_EPUB, bookType, bookLength = null, resendStatus = 200, brevoStatus = 201, smtp2goStatus = 200, smtp2goSucceeded = 1 } = {}) {
  const calls = { resend: [], brevo: [], smtp2go: [], book: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith(RESEND_API_URL)) {
      calls.resend.push({ url, headers: opts.headers || {}, body: JSON.parse(opts.body || "{}") });
      return {
        ok: resendStatus >= 200 && resendStatus < 300,
        status: resendStatus,
        async json() { return resendStatus === 200 ? { id: "re_test123" } : { error: { message: "forbidden" } }; },
      };
    }
    if (String(url).startsWith(BREVO_API_URL)) {
      calls.brevo.push({ url, headers: opts.headers || {}, body: JSON.parse(opts.body || "{}") });
      return {
        ok: brevoStatus >= 200 && brevoStatus < 300,
        status: brevoStatus,
        async json() { return brevoStatus >= 200 && brevoStatus < 300 ? { messageId: "brevo_test123" } : { message: "Daily quota exceeded" }; },
      };
    }
    if (String(url).startsWith(SMTP2GO_API_URL)) {
      calls.smtp2go.push({ url, headers: opts.headers || {}, body: JSON.parse(opts.body || "{}") });
      return {
        ok: smtp2goStatus >= 200 && smtp2goStatus < 300,
        status: smtp2goStatus,
        async json() {
          return smtp2goStatus >= 200 && smtp2goStatus < 300
            ? { data: { succeeded: smtp2goSucceeded, failed: smtp2goSucceeded === 0 ? 1 : 0, failures: [], email_id: "smtp2go_test123" } }
            : { message: "Daily quota exceeded" };
        },
      };
    }
    calls.book.push({ url });
    return bookResponse(bookBytes, bookType, bookLength);
  };
  return { fetchImpl, calls };
}

function makeCtx({ kv, apiKey = "re_test_key", brevoKey, smtp2goKey, fetchImpl, params, proxyBase, proxyKey, headers = {} }) {
  const url = "https://rlibook.tech/api/send-to-kindle?" + new URLSearchParams(params).toString();
  const env = { RLIBOOK_KV: kv, RESEND_API_KEY: apiKey };
  if (brevoKey !== undefined) env.BREVO_API_KEY = brevoKey;
  if (smtp2goKey !== undefined) env.SMTP2GO_API_KEY = smtp2goKey;
  if (proxyBase !== undefined) env.PROXY_BASE_URL = proxyBase;
  if (proxyKey !== undefined) env.PROXY_SIGNING_KEY = proxyKey;
  return {
    request: new Request(url, { method: "GET", headers: { "cf-connecting-ip": "1.2.3.4", ...headers } }),
    env,
    _fetchImpl: fetchImpl,
  };
}

const PROXY_BASE = "https://proxy.example.test";
const PROXY_KEY = "test_signing_key_0123456789abcdef";

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
const TG_PARAMS = { lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Test Book", fp: FP };

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
check("resolveAcquisitionUrl doab id over 2048 chars -> null",
  resolveAcquisitionUrl("doab", "https://example.com/" + "x".repeat(2040) + ".epub") === null);
check("safeFilename latin title", safeFilename("Yawmiyat Naib", "hindawi", "13028368", "epub") === "Yawmiyat_Naib_RliBook_hindawi.epub");
check("safeFilename arabic title kept", safeFilename("يوميات نائب في الأرياف", "hindawi", "13028368", "epub") === "يوميات_نائب_في_الأرياف_RliBook_hindawi.epub");
check("safeFilename empty title falls back", safeFilename("", "hindawi", "13028368", "epub") === "rlibook-hindawi-13028368.epub");
check("safeFilename unsafe-only title falls back", safeFilename("///", "hindawi", "13028368", "epub") === "rlibook-hindawi-13028368.epub");
check("safeFilename slash in title removed", safeFilename("A/B Test", "hindawi", "13028368", "epub") === "AB_Test_RliBook_hindawi.epub");
check("safeFilename long title truncated to 100 chars", safeFilename("A".repeat(150), "hindawi", "13028368", "epub") === "A".repeat(100) + "_RliBook_hindawi.epub");
check("safeFilename mixed arabic+latin kept", safeFilename("يوميات Dune", "hindawi", "13028368", "epub") === "يوميات_Dune_RliBook_hindawi.epub");
check("safeFilename khazendar source stamped", safeFilename("القراءة المثمرة", "khazendar", "12345", "epub") === "القراءة_المثمرة_RliBook_khazendar.epub");
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

// --- 5b. rlb_fp cookie resolves the email (auto-recognition) ---------
{
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID, created_at: "2026-11-12T00:00:00Z" }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "لؤلؤة الحب" }, headers: { Cookie: "rlb_fp=" + FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("5b cookie fp: 200 + confirmation (no ?fp= needed)", res.status === 200 && body.includes("تم الإرسال"), `status=${res.status}`);
  check("5b cookie fp: sent to the cookie owner's Kindle email", calls.resend.length === 1 && calls.resend[0].body.to[0] === KINDLE_EMAIL);
}

{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x" }, headers: { Cookie: "rlb_fp=fp_unknown" } }),
    fetchImpl,
  );
  const body = await res.text();
  check("5c revoked cookie fp: 400 + bot hint", res.status === 400 && body.includes("RliBook_bot"), `status=${res.status}`);
  check("5c revoked cookie fp: nothing sent", calls.resend.length === 0);
}

{
  // Query ?fp= wins over the cookie (the cookie is only a fallback).
  const OTHER_FP = "fp_other_token_zzz";
  const OTHER_EMAIL = "other@kindle.com";
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
    ["fp:" + OTHER_FP]: JSON.stringify({ tg_id: 222 }),
    ["kindle_email:222"]: OTHER_EMAIL,
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP }, headers: { Cookie: "rlb_fp=" + OTHER_FP } }),
    fetchImpl,
  );
  check("5d query fp wins over cookie fp", calls.resend.length === 1 && calls.resend[0].body.to[0] === KINDLE_EMAIL, `to=${calls.resend[0] && calls.resend[0].body.to}`);
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

// --- W4. idempotency: one (destination + book), sent twice -> one email -
// --- 15. exact repeat inside the window: 2nd request, 0 new emails -------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const params = { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP };
  const res1 = await run(makeCtx({ kv, fetchImpl, params }), fetchImpl);
  const body1 = await res1.text();
  const res2 = await run(makeCtx({ kv, fetchImpl, params }), fetchImpl);
  const body2 = await res2.text();
  check("15 dedupe: 1st send 200", res1.status === 200 && body1.includes("تم الإرسال"), `status=${res1.status}`);
  check("15 dedupe: 2nd send also 200 (confirmation, not error)", res2.status === 200 && body2.includes("تم الإرسال"), `status=${res2.status}`);
  check("15 dedupe: 2nd page says already sent, no duplicate",
    body2.includes("أُرسل بالفعل") && body2.includes("لم نرسله مرة أخرى"));
  check("15 dedupe: still exactly one Resend call", calls.resend.length === 1, `calls=${calls.resend.length}`);
  const day = new Date().toISOString().slice(0, 10);
  const { createHash } = await import("node:crypto");
  const destHash = createHash("sha256").update(KINDLE_EMAIL).digest("hex");
  check("15 dedupe: repeat did not burn daily quota",
    kv.map.get(`stk:dest:${destHash}:${day}`) === "1",
    `counter=${kv.map.get(`stk:dest:${destHash}:${day}`)}`);
}

// --- 16. same destination, DIFFERENT book -> sends normally ----------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  await run(makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }), fetchImpl);
  const res = await run(makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "99999999", f: "epub", t: "y", fp: FP } }), fetchImpl);
  check("16 dedupe: different book sends (2 Resend calls)", res.status === 200 && calls.resend.length === 2, `calls=${calls.resend.length}`);
}

// --- 17. same book, DIFFERENT destination -> sends normally ----------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  await run(makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }), fetchImpl);
  const res = await run(makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", to: "second@kindle.com" } }), fetchImpl);
  check("17 dedupe: different destination sends (2 Resend calls)", res.status === 200 && calls.resend.length === 2, `calls=${calls.resend.length}`);
}

// --- 18. failed send releases the key: retry after a Resend 403 works -----
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const bad = makeFetch({ resendStatus: 403 });
  const res1 = await run(makeCtx({ kv, fetchImpl: bad.fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }), bad.fetchImpl);
  check("18 dedupe: 1st attempt fails 502", res1.status === 502, `status=${res1.status}`);
  const good = makeFetch({});
  const res2 = await run(makeCtx({ kv, fetchImpl: good.fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }), good.fetchImpl);
  check("18 dedupe: retry after failure sends", res2.status === 200 && good.calls.resend.length === 1, `status=${res2.status}`);
}

// --- 19. dedupeKeyFor unit: stable, book-sensitive, case-insensitive -------
{
  const k1 = await dedupeKeyFor("Test@kindle.com", "hindawi:13028368", "epub");
  const k2 = await dedupeKeyFor("test@kindle.com", "hindawi:13028368", "epub");
  const k3 = await dedupeKeyFor("test@kindle.com", "hindawi:99999999", "epub");
  const k4 = await dedupeKeyFor("test@kindle.com", "hindawi:13028368", "pdf");
  check("19 dedupeKey: same inputs -> same key", k1 === k2);
  check("19 dedupeKey: different book -> different key", k1 !== k3);
  check("19 dedupeKey: different format -> different key", k1 !== k4);
  check("19 dedupeKey: key is stk:dedup: + hex, no email in it",
    k1.startsWith("stk:dedup:") && !k1.includes("test@kindle.com") && !k1.includes("13028368"));
  check("19 dedupeKey: TTL is 600s", DEDUPE_TTL_SECONDS === 600);
}

// --- W6. Telegram books via the proxy --------------------------------
// --- 20. tg success: proxy fetch -> Resend, signed /dl URL --------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  const body = await res.text();
  check("20 tg proxy: 200 + confirmation", res.status === 200 && body.includes("تم الإرسال"), `status=${res.status}`);
  check("20 tg proxy: one Resend call", calls.resend.length === 1, `calls=${calls.resend.length}`);
  check("20 tg proxy: fetched from the proxy /dl URL",
    calls.book.length === 1 && calls.book[0].url.startsWith(PROXY_BASE + "/dl?h=kotobkhana&p=7559&f=epub&t=v1."),
    calls.book[0] && calls.book[0].url);
  check("20 tg proxy: .epub attachment", calls.resend[0].body.attachments[0].filename.endsWith(".epub"));
}

// --- 21. tg proxy unset -> honest 503, nothing fetched or sent -----------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: TG_PARAMS }),
    fetchImpl,
  );
  const body = await res.text();
  check("21 tg no proxy: 503 honest page", res.status === 503 && body.includes("غير مهيأة"), `status=${res.status}`);
  check("21 tg no proxy: nothing fetched or sent", calls.book.length === 0 && calls.resend.length === 0);
}

// --- 22. tg flagged book -> 403, nothing fetched or sent ------------------
{
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
    "flag:kotobkhana:7559": "1",
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  const body = await res.text();
  check("22 tg flagged: 403 + bot hint", res.status === 403 && body.includes("RliBook_bot"), `status=${res.status}`);
  check("22 tg flagged: reason first — flagged, site cannot send",
    body.includes("🚩 هذا الكتاب عليه علامة")
    && body.includes("الموقع لا يتيح تحميله أو إرساله"));
  check("22 tg flagged: reason comes BEFORE the bot direction",
    body.indexOf("🚩 هذا الكتاب عليه علامة") !== -1
    && body.indexOf("🚩 هذا الكتاب عليه علامة") < body.indexOf("قناة النشر")
    && body.includes("قناة النشر"));
  check("22 tg flagged: nothing fetched or sent", calls.book.length === 0 && calls.resend.length === 0);
}

// --- 23. tg bad handle / bad post -> 400 -----------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const r1 = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "tg", h: "BAD HANDLE!", p: "7559", f: "epub", t: "x", fp: FP }, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  check("23 tg bad handle: 400", r1.status === 400, `status=${r1.status}`);
  const r2 = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "tg", h: "kotobkhana", p: "abc", f: "epub", t: "x", fp: FP }, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  check("23 tg bad post: 400", r2.status === 400, `status=${r2.status}`);
  check("23 tg bad params: nothing sent", calls.resend.length === 0);
}

// --- 24. tg MOBI refused before any fetch -----------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { ...TG_PARAMS, f: "mobi" }, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  check("24 tg mobi: 400", res.status === 400, `status=${res.status}`);
  check("24 tg mobi: no proxy fetch, no send", calls.book.length === 0 && calls.resend.length === 0);
}

// --- 25. tg dedupe: same Telegram book twice -> one email -------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const ctx1 = makeCtx({ kv, fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY });
  const ctx2 = makeCtx({ kv, fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY });
  const res1 = await run(ctx1, fetchImpl);
  const res2 = await run(ctx2, fetchImpl);
  check("25 tg dedupe: both 200", res1.status === 200 && res2.status === 200);
  check("25 tg dedupe: still one Resend call", calls.resend.length === 1, `calls=${calls.resend.length}`);
}

// --- 26. tg proxy returns HTML -> 502, no send -------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ bookBytes: FAKE_HTML, bookType: "text/html; charset=utf-8" });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  check("26 tg proxy html: 502", res.status === 502, `status=${res.status}`);
  check("26 tg proxy html: nothing sent", calls.resend.length === 0);
}

// --- 27. tg proxy oversized -> 413, no send ----------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ bookBytes: FAKE_EPUB, bookLength: MAX_FILE_BYTES + 1 });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  check("27 tg proxy oversized: 413", res.status === 413, `status=${res.status}`);
  check("27 tg proxy oversized: nothing sent", calls.resend.length === 0);
}

// --- 28. proxyDownloadUrl unit ------------------------------------------------
{
  const u = await proxyDownloadUrl({ PROXY_BASE_URL: PROXY_BASE + "/", PROXY_SIGNING_KEY: PROXY_KEY }, "kotobkhana", 7559, "epub");
  check("28 proxyDownloadUrl: signed /dl URL, trailing slash trimmed",
    typeof u === "string" && u.startsWith(PROXY_BASE + "/dl?h=kotobkhana&p=7559&f=epub&t=v1."), u);
  check("28 proxyDownloadUrl: no base -> null",
    (await proxyDownloadUrl({ PROXY_SIGNING_KEY: PROXY_KEY }, "k", 1, "epub")) === null);
  check("28 proxyDownloadUrl: no signing key -> null",
    (await proxyDownloadUrl({ PROXY_BASE_URL: PROXY_BASE }, "k", 1, "epub")) === null);
}

// --- 29. tg typed-email form keeps h + p through the form ----------------------
{
  const kv = makeKv({});
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Test Book" }, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  const body = await res.text();
  check("29 tg form: 200 form page", res.status === 200 && body.includes("<form"), `status=${res.status}`);
  check("29 tg form: hidden h + p inputs present",
    body.includes('name="h" value="kotobkhana"') && body.includes('name="p" value="7559"'));
  check("29 tg form: nothing sent", calls.resend.length === 0 && calls.book.length === 0);
}

// --- 30. Review fixes (Area 2): failed sends refund the quota --------
// --- 30. failed send (Resend 403) gives both daily counts back --------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 403 });
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("30 refund: failed send is 502", res.status === 502, `status=${res.status}`);
  check("30 refund: nothing sent", calls.resend.length === 1 && calls.book.length === 1);
  const day = new Date().toISOString().slice(0, 10);
  const { createHash } = await import("node:crypto");
  const destHash = createHash("sha256").update(KINDLE_EMAIL).digest("hex");
  const destCount = kv.map.get(`stk:dest:${destHash}:${day}`);
  const ipCount = kv.map.get(`stk:ip:1.2.3.4:${day}`);
  check("30 refund: destination count given back (0 or absent)",
    destCount === undefined || destCount === "0", `dest=${destCount}`);
  check("30 refund: IP count given back (0 or absent)",
    ipCount === undefined || ipCount === "0", `ip=${ipCount}`);
}

// --- 31. corrupt counter value is treated as 0, not fail-open -----------
{
  const day = new Date().toISOString().slice(0, 10);
  const { createHash } = await import("node:crypto");
  const destHash = createHash("sha256").update(KINDLE_EMAIL).digest("hex");
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
    [`stk:dest:${destHash}:${day}`]: "garbage",
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("31 corrupt counter: send proceeds (200)", res.status === 200, `status=${res.status}`);
  check("31 corrupt counter: count is now 1 (not unlimited, not stuck)",
    kv.map.get(`stk:dest:${destHash}:${day}`) === "1",
    `counter=${kv.map.get(`stk:dest:${destHash}:${day}`)}`);
}

// --- 32. IP daily cap -> 429 with a next step, dest count refunded -------
{
  const day = new Date().toISOString().slice(0, 10);
  const kv = makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }),
    ["kindle_email:" + TG_ID]: KINDLE_EMAIL,
    [`stk:ip:1.2.3.4:${day}`]: String(DAILY_PER_IP),
  });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("32 IP cap: 429", res.status === 429, `status=${res.status}`);
  check("32 IP cap: next step — back link to the book page",
    body.includes("رجوع إلى صفحة الكتاب"));
  check("32 IP cap: nothing sent", calls.resend.length === 0 && calls.book.length === 0);
  const { createHash } = await import("node:crypto");
  const destHash = createHash("sha256").update(KINDLE_EMAIL).digest("hex");
  const destCount = kv.map.get(`stk:dest:${destHash}:${day}`);
  check("32 IP cap: destination count refunded (the dest check passed first)",
    destCount === undefined || destCount === "0", `dest=${destCount}`);
}

// --- 33. over-long fingerprint -> 400, no send, no KV lookup ------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: "x".repeat(200) } }),
    fetchImpl,
  );
  const body = await res.text();
  check("33 long fp: 400 not-found page", res.status === 400 && body.includes("لم نجد بريد جهاز"), `status=${res.status}`);
  check("33 long fp: nothing sent", calls.resend.length === 0 && calls.book.length === 0);
}

// --- 34. Resend 429 (daily cap) -> Brevo sends, 200 confirmation -----
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 429, brevoStatus: 201 });
  const res = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("34 resend 429: 200 + confirmation", res.status === 200 && body.includes("تم الإرسال"), `status=${res.status}`);
  check("34 resend 429: Resend tried once", calls.resend.length === 1, `calls=${calls.resend.length}`);
  check("34 resend 429: Brevo delivered it", calls.brevo.length === 1, `calls=${calls.brevo.length}`);
}

// --- 35. Brevo request shape ----------------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 429, brevoStatus: 201 });
  await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const b = calls.brevo[0];
  check("35 brevo: api-key header (never Bearer)", b.headers["api-key"] === "xkeysib_test_key");
  check("35 brevo: User-Agent header (same as Resend)", b.headers["User-Agent"] === "RliBook-bot/1.0");
  check("35 brevo: sender identity", JSON.stringify(b.body.sender) === JSON.stringify({ name: "RliBook", email: "send@rlibook.tech" }));
  check("35 brevo: to is [{email}]", JSON.stringify(b.body.to) === JSON.stringify([{ email: KINDLE_EMAIL }]));
  check("35 brevo: attachment name + base64", b.body.attachment[0].name.endsWith(".epub")
    && b.body.attachment[0].content === Buffer.from(FAKE_EPUB).toString("base64"));
  check("35 brevo: endpoint is api.brevo.com/v3/smtp/email", b.url === BREVO_API_URL);
}

// --- 36. all three 429 -> tomorrow page + queue entry --------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 429, brevoStatus: 429, smtp2goStatus: 429 });
  const res = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "لؤلؤة الحب", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("36 all 429: tomorrow page (not an error)", res.status === 200 && body.includes("سيصل غداً"), `status=${res.status}`);
  check("36 all 429: masked email shown", body.includes("te***@kindle.com"));
  check("36 all 429: all three providers tried once", calls.resend.length === 1 && calls.brevo.length === 1 && calls.smtp2go.length === 1);
  const queueKeys = [...kv.map.keys()].filter((k) => k.startsWith("stk:queue:"));
  check("36 all 429: one queue entry in KV", queueKeys.length === 1, `keys=${queueKeys.length}`);
  const job = JSON.parse(kv.map.get(queueKeys[0]));
  check("36 all 429: queue job has the book + destination, no bytes",
    job.to === KINDLE_EMAIL && job.lib === "hindawi" && job.id === "13028368" && job.fmt === "epub"
    && !("bytes" in job) && !("content" in job));
  // A retry re-queues the SAME entry (idempotent) — no second entry.
  const res2 = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "لؤلؤة الحب", fp: FP } }),
    fetchImpl,
  );
  check("36 all 429: retry still says tomorrow", res2.status === 200 && (await res2.text()).includes("سيصل غداً"));
  check("36 all 429: retry did not add a second queue entry",
    [...kv.map.keys()].filter((k) => k.startsWith("stk:queue:")).length === 1);
  check("36 all 429: OPDS book — no Telegram button (no Telegram identity)",
    !body.includes("/api/tg-send?"));
}

// --- 37. Telegram book, all three 429 -> tomorrow page + Telegram overflow button ---
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 429, brevoStatus: 429, smtp2goStatus: 429 });
  const res = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: TG_PARAMS, proxyBase: PROXY_BASE, proxyKey: PROXY_KEY }),
    fetchImpl,
  );
  const body = await res.text();
  check("37 TG all 429: tomorrow page (not an error)", res.status === 200 && body.includes("سيصل غداً"), `status=${res.status}`);
  check("37 TG all 429: Telegram overflow button present (lib=tg, handle+post+format+fp)",
    body.includes("/api/tg-send?lib=tg")
    && body.includes("h=kotobkhana") && body.includes("p=7559")
    && body.includes("f=epub") && body.includes("fp=" + FP)
    && body.includes("أرسله لي في تيليجرام"));
  check("37 TG all 429: the button offers the book NOW (no waiting)",
    body.includes("الآن"));
  check("37 TG all 429: the email is still queued for tomorrow too",
    [...kv.map.keys()].filter((k) => k.startsWith("stk:queue:")).length === 1);
  check("37 TG all 429: all three providers tried once", calls.resend.length === 1 && calls.brevo.length === 1 && calls.smtp2go.length === 1);
}

// --- 37. Resend 500 (non-429) -> Brevo fallback still sends ---------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 500, brevoStatus: 201 });
  const res = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("37 resend 500: 200 via Brevo", res.status === 200 && calls.brevo.length === 1, `status=${res.status}`);
}

// --- 38. no Resend key + Brevo key -> sends via Brevo ----------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 200, brevoStatus: 201 });
  const res = await run(
    makeCtx({ kv, apiKey: "", brevoKey: "xkeysib_test_key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("38 brevo-only: 200, no 503", res.status === 200, `status=${res.status}`);
  check("38 brevo-only: Brevo sent, Resend untouched", calls.brevo.length === 1 && calls.resend.length === 0);
}

// --- 39. neither key -> 503 -------------------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({});
  const res = await run(
    makeCtx({ kv, apiKey: "", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("39 no keys: 503", res.status === 503, `status=${res.status}`);
  check("39 no keys: nothing sent", calls.resend.length === 0 && calls.brevo.length === 0 && calls.smtp2go.length === 0 && calls.book.length === 0);
}

// --- 40. sendEmailWithFallback unit ----------------------------------------
{
  const msg = { from: "RliBook <send@rlibook.tech>", to: ["a@kindle.com"], subject: "s", html: "<p>x</p>", attachments: [] };
  const route = (resendStatus, brevoStatus, smtp2goStatus = 200, smtp2goSucceeded = 1) => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      let status;
      let body;
      if (String(url).startsWith(RESEND_API_URL)) {
        status = resendStatus;
        body = { error: { message: "cap" } };
      } else if (String(url).startsWith(BREVO_API_URL)) {
        status = brevoStatus;
        body = status === 201 ? { messageId: "b1" } : { message: "cap" };
      } else {
        status = smtp2goStatus;
        body = status >= 200 && status < 300
          ? { data: { succeeded: smtp2goSucceeded, failed: smtp2goSucceeded === 0 ? 1 : 0, failures: [], email_id: "s2g1" } }
          : { message: "cap" };
      }
      return { ok: status >= 200 && status < 300, status, async json() { return body; } };
    };
    return { fetchImpl, seen };
  };
  const threeKeys = { resendApiKey: "re_x", brevoApiKey: "xb_x", smtp2goApiKey: "api_x" };
  // All three 429, no queue -> E_BOTH_EXHAUSTED (never a silent drop).
  {
    const { fetchImpl } = route(429, 429, 429);
    const r = await sendEmailWithFallback({ ...threeKeys, fetchImpl, message: msg });
    check("40 unit: all three 429, no queue -> E_BOTH_EXHAUSTED", r.ok === false && r.code === "E_BOTH_EXHAUSTED" && (r.message || "").includes("tomorrow"));
  }
  // All three 429, queue given -> E_QUEUED with the payload.
  {
    const { fetchImpl } = route(429, 429, 429);
    const queued = [];
    const r = await sendEmailWithFallback({
      ...threeKeys, fetchImpl, message: msg,
      queue: { enqueue: async (p) => { queued.push(p); return true; } },
      queuePayload: { kind: "stk", to: "a@kindle.com" },
    });
    check("40 unit: all three 429 + queue -> E_QUEUED", r.ok === false && r.code === "E_QUEUED" && r.queued === true);
    check("40 unit: queue got the payload", queued.length === 1 && queued[0].to === "a@kindle.com");
  }
  // All three fail non-429 -> E_SEND_FAILED, never queued.
  {
    const { fetchImpl } = route(422, 400, 400);
    const queued = [];
    const r = await sendEmailWithFallback({
      ...threeKeys, fetchImpl, message: msg,
      queue: { enqueue: async (p) => { queued.push(p); return true; } },
    });
    check("40 unit: all three non-429 -> E_SEND_FAILED", r.ok === false && r.code === "E_SEND_FAILED");
    check("40 unit: non-capacity failure is not queued", queued.length === 0);
  }
  // No keys at all -> E_NO_API_KEY, no fetch.
  {
    const { fetchImpl, seen } = route(200, 201);
    const r = await sendEmailWithFallback({ fetchImpl, message: msg });
    check("40 unit: no keys -> E_NO_API_KEY", r.ok === false && r.code === "E_NO_API_KEY" && seen.length === 0);
  }
  // Brevo request builder: same sender/message as Resend.
  {
    const b = buildBrevoRequest({ ...msg, text: "plain" }, "send@rlibook.tech");
    check("40 unit: buildBrevoRequest sender/to/subject",
      JSON.stringify(b.sender) === JSON.stringify({ name: "RliBook", email: "send@rlibook.tech" })
      && JSON.stringify(b.to) === JSON.stringify([{ email: "a@kindle.com" }])
      && b.subject === "s" && b.htmlContent === "<p>x</p>" && b.textContent === "plain");
  }
  // SMTP2GO request builder: bare-address sender, to array, EPUB mimetype.
  {
    const s = buildSmtp2goRequest({ ...msg, text: "plain", attachments: [{ filename: "book.epub", content: "QUJD" }] }, "send@rlibook.tech");
    check("40 unit: buildSmtp2goRequest sender/to/subject",
      s.sender === "send@rlibook.tech"
      && JSON.stringify(s.to) === JSON.stringify(["a@kindle.com"])
      && s.subject === "s" && s.html_body === "<p>x</p>" && s.text_body === "plain");
    check("40 unit: buildSmtp2goRequest attachment fileblob + EPUB mimetype",
      s.attachments.length === 1 && s.attachments[0].filename === "book.epub"
      && s.attachments[0].fileblob === "QUJD" && s.attachments[0].mimetype === "application/epub+zip");
    check("40 unit: smtp2goMimeFor epub/pdf/txt/unknown",
      smtp2goMimeFor("b.epub") === "application/epub+zip"
      && smtp2goMimeFor("b.pdf") === "application/pdf"
      && smtp2goMimeFor("b.txt") === "text/plain"
      && smtp2goMimeFor("b.xyz") === "application/octet-stream");
  }
}

// --- 41. enqueueTomorrow: idempotent per (destination + book + day) --------
{
  const kv = makeKv({});
  const job = { kind: "stk", to: "testuser@kindle.com", lib: "hindawi", id: "13028368", fmt: "epub", title: "x" };
  check("41 queue: first enqueue ok", (await enqueueTomorrow(kv, job)) === true);
  check("41 queue: second enqueue ok, same key", (await enqueueTomorrow(kv, job)) === true);
  const keys = [...kv.map.keys()].filter((k) => k.startsWith("stk:queue:"));
  check("41 queue: still exactly one entry", keys.length === 1, `keys=${keys.length}`);
  check("41 queue: key has no email in it", !keys[0].includes("testuser@kindle.com"));
  const other = { ...job, id: "99999999" };
  await enqueueTomorrow(kv, other);
  check("41 queue: different book -> different entry",
    [...kv.map.keys()].filter((k) => k.startsWith("stk:queue:")).length === 2);
}

// --- 42. Resend 429 + Brevo 500 -> SMTP2GO sends, 200 confirmation -------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 429, brevoStatus: 500, smtp2goStatus: 200 });
  const res = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("42 brevo fail -> smtp2go: 200 + confirmation", res.status === 200 && body.includes("تم الإرسال"), `status=${res.status}`);
  check("42 brevo fail -> smtp2go: Resend tried once", calls.resend.length === 1, `calls=${calls.resend.length}`);
  check("42 brevo fail -> smtp2go: Brevo tried once", calls.brevo.length === 1, `calls=${calls.brevo.length}`);
  check("42 brevo fail -> smtp2go: SMTP2GO delivered it", calls.smtp2go.length === 1, `calls=${calls.smtp2go.length}`);
}

// --- 43. SMTP2GO request shape ----------------------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 429, brevoStatus: 429, smtp2goStatus: 200 });
  await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const s = calls.smtp2go[0];
  check("43 smtp2go: X-Smtp2go-Api-Key header (never Bearer, never api-key)", s.headers["X-Smtp2go-Api-Key"] === "api-test-smtp2go-key");
  check("43 smtp2go: User-Agent header (same as Resend)", s.headers["User-Agent"] === "RliBook-bot/1.0");
  check("43 smtp2go: sender is the bare address", s.body.sender === "send@rlibook.tech");
  check("43 smtp2go: to is a plain string array", JSON.stringify(s.body.to) === JSON.stringify([KINDLE_EMAIL]));
  check("43 smtp2go: attachment filename + base64 + EPUB mimetype", s.body.attachments[0].filename.endsWith(".epub")
    && s.body.attachments[0].fileblob === Buffer.from(FAKE_EPUB).toString("base64")
    && s.body.attachments[0].mimetype === "application/epub+zip");
  check("43 smtp2go: endpoint is api.smtp2go.com/v3/email/send", s.url === SMTP2GO_API_URL);
}

// --- 44. SMTP2GO-only key -> sends via SMTP2GO ------------------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 200, brevoStatus: 201, smtp2goStatus: 200 });
  const res = await run(
    makeCtx({ kv, apiKey: "", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  check("44 smtp2go-only: 200, no 503", res.status === 200, `status=${res.status}`);
  check("44 smtp2go-only: SMTP2GO sent, Resend + Brevo untouched", calls.smtp2go.length === 1 && calls.resend.length === 0 && calls.brevo.length === 0);
}

// --- 45. all three non-429 -> 502 error page, never queued -------------------
{
  const kv = makeKv({ ["fp:" + FP]: JSON.stringify({ tg_id: TG_ID }), ["kindle_email:" + TG_ID]: KINDLE_EMAIL });
  const { fetchImpl, calls } = makeFetch({ resendStatus: 500, brevoStatus: 400, smtp2goStatus: 400 });
  const res = await run(
    makeCtx({ kv, brevoKey: "xkeysib_test_key", smtp2goKey: "api-test-smtp2go-key", fetchImpl, params: { lib: "hindawi", id: "13028368", f: "epub", t: "x", fp: FP } }),
    fetchImpl,
  );
  const body = await res.text();
  check("45 all non-429: 502 error page (not tomorrow)", res.status === 502 && !body.includes("سيصل غداً"), `status=${res.status}`);
  check("45 all non-429: all three providers tried once", calls.resend.length === 1 && calls.brevo.length === 1 && calls.smtp2go.length === 1);
  check("45 all non-429: nothing queued", [...kv.map.keys()].filter((k) => k.startsWith("stk:queue:")).length === 0);
}

// --- 46. SMTP2GO 200 with succeeded 0 is a failure --------------------------
{
  const msg = { from: "RliBook <send@rlibook.tech>", to: ["a@kindle.com"], subject: "s", html: "<p>x</p>", attachments: [] };
  const route = (resendStatus, brevoStatus, smtp2goStatus, smtp2goSucceeded) => {
    const fetchImpl = async (url) => {
      let status;
      let body;
      if (String(url).startsWith(RESEND_API_URL)) { status = resendStatus; body = { error: { message: "cap" } }; }
      else if (String(url).startsWith(BREVO_API_URL)) { status = brevoStatus; body = { message: "cap" }; }
      else {
        status = smtp2goStatus;
        body = { data: { succeeded: smtp2goSucceeded, failed: smtp2goSucceeded === 0 ? 1 : 0, failures: smtp2goSucceeded === 0 ? [{ error: "rejected" }] : [], email_id: smtp2goSucceeded === 0 ? "" : "s2g1" } };
      }
      return { ok: status >= 200 && status < 300, status, async json() { return body; } };
    };
    return { fetchImpl };
  };
  // SMTP2GO answers 200 but succeeded 0 while the other two are 429:
  // the 200 is NOT a success — the send falls through to the queue path.
  {
    const { fetchImpl } = route(429, 429, 200, 0);
    const queued = [];
    const r = await sendEmailWithFallback({
      resendApiKey: "re_x", brevoApiKey: "xb_x", smtp2goApiKey: "api_x", fetchImpl, message: msg,
      queue: { enqueue: async (p) => { queued.push(p); return true; } },
    });
    check("46 unit: smtp2go 200 succeeded 0 + both 429 -> E_QUEUED", r.ok === false && r.code === "E_QUEUED" && queued.length === 1);
  }
  // SMTP2GO answers 200 with succeeded 1: provider is "smtp2go",
  // messageId is the email_id.
  {
    const { fetchImpl } = route(429, 429, 200, 1);
    const r = await sendEmailWithFallback({
      resendApiKey: "re_x", brevoApiKey: "xb_x", smtp2goApiKey: "api_x", fetchImpl, message: msg,
    });
    check("46 unit: smtp2go success -> provider smtp2go + email_id", r.ok === true && r.provider === "smtp2go" && r.messageId === "s2g1");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
