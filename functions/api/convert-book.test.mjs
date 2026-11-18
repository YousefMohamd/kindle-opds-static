// Test for the Kindle-direct Convert endpoint (functions/api/convert-book.js).
// Standalone Node script — run from the repo root:
//   node functions/api/convert-book.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock of
// the Pages Function environment (env.RLIBOOK_KV as a Map, env as plain
// vars), mocks global fetch twice over (the proxy book source + the bot
// worker's /convert-book), and calls onRequest() over HTTP semantics.
// It asserts the response contract for:
//   1. happy path: PDF fetched from the proxy, POSTed to the bot, 200
//      "جارٍ التجهيز…" page; the bot call carries fp + handle + postId
//      + the PDF bytes (base64, %PDF) and the RliBook filename
//   2. no fp -> informational page (200), no proxy fetch, no bot call
//   3. flagged book -> 400, no fetch at all
//   4. hidden book -> 400, no fetch at all
//   5. non-PDF format -> 400, no fetch at all
//   6. OPDS lib -> 400, no fetch at all
//   7. bad handle / bad post id -> 400, no fetch at all
//   8. missing KV binding -> 503
//   9. proxy not configured -> 503
//  10. proxy fetch non-2xx -> 502, no bot call
//  11. bad magic bytes (HTML) -> 502, no bot call
//  12. oversized (Content-Length > 10 MB) -> 413, no bot call
//  13. bot E_NO_EMAIL -> 200 page with the no-email text + bot link
//  14. bot E_LIMIT -> 200 page with the daily-limit text
//  15. bot E_FAIR_USE + waitMinutes -> 200 page with the minutes
//  16. bot fetch throws -> 502
//  17. botErrorText: every code maps to non-empty Arabic text;
//      E_FAIR_USE with and without waitMinutes
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no bot worker, no deploy.
// All fingerprints / books below are FAKE test data.

import {
  onRequest,
  botErrorText,
  CONVERT_MAX_INPUT_BYTES,
  WORKER_BASE,
  BOT_LINK,
} from "./convert-book.js";

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

const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]); // %PDF
const FAKE_HTML = new TextEncoder().encode("<html>proxy error</html>");
const PROXY_BASE = "https://proxy.example";
const FP = "test-fingerprint-abcdef";

function makeEnv(kv, over = {}) {
  return {
    RLIBOOK_KV: kv,
    PROXY_BASE_URL: PROXY_BASE,
    PROXY_SIGNING_KEY: "test-signing-key-0123456789abcdef",
    ...over,
  };
}

function convertUrl(over = {}) {
  const q = new URLSearchParams({
    lib: "tg", h: "khazendar", p: "12345", f: "pdf", t: "Test Book", fp: FP,
    ...over,
  });
  return "https://rlibook.tech/api/convert-book?" + q.toString();
}

/** Mock global fetch: the proxy book source + the bot worker.
 *  bookBytes: what the proxy returns. bookStatus: its HTTP status.
 *  botResult: the JSON the bot's /convert-book returns (null = the
 *  bot answers non-JSON). botThrows: the bot fetch rejects.
 *  Captures every bot call (parsed JSON body) in calls.bot and every
 *  proxy fetch in calls.proxy. */
function makeFetch({
  bookBytes = FAKE_PDF,
  bookStatus = 200,
  botResult = { ok: true },
  botThrows = false,
} = {}) {
  const calls = { bot: [], proxy: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(WORKER_BASE + "/convert-book")) {
      if (botThrows) throw new Error("network down");
      calls.bot.push({ url: u, body: JSON.parse(opts.body || "{}") });
      return {
        ok: true,
        status: 200,
        async json() {
          if (botResult === null) throw new Error("not json");
          return botResult;
        },
      };
    }
    if (u.startsWith(PROXY_BASE)) {
      calls.proxy.push({ url: u });
      return {
        ok: bookStatus >= 200 && bookStatus < 300,
        status: bookStatus,
        headers: {
          get: (n) => (n.toLowerCase() === "content-length" ? String(bookBytes.length) : null),
        },
        async arrayBuffer() {
          return bookBytes.buffer.slice(bookBytes.byteOffset, bookBytes.byteOffset + bookBytes.byteLength);
        },
      };
    }
    throw new Error("unexpected fetch: " + u);
  };
  return { fetchImpl, calls };
}

async function callEndpoint(env, url, fetchImpl) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const res = await onRequest({
      request: new Request(url),
      env,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    globalThis.fetch = prevFetch;
  }
}

// --- tests -------------------------------------------------------------
console.log("convert-book endpoint tests:");

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status, text } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("1. happy path -> 200 'جارٍ التجهيز…'", status === 200 && text.includes("جارٍ التجهيز"), `status=${status}`);
  check("1b. the page names the Kindle email delivery", text.includes("ميل قارئك"));
  check("1c. the proxy was fetched once", calls.proxy.length === 1, `proxy=${calls.proxy.length}`);
  check("1d. the bot was called once", calls.bot.length === 1, `bot=${calls.bot.length}`);
  const body = calls.bot[0]?.body || {};
  check("1e. the bot call carries the fingerprint", body.fp === FP);
  check("1f. the bot call carries handle + postId", body.handle === "khazendar" && body.postId === "12345");
  check("1g. the bot call carries the PDF bytes (base64, %PDF)",
    typeof body.pdfBase64 === "string"
    && Buffer.from(body.pdfBase64, "base64").subarray(0, 4).toString() === "%PDF");
  check("1h. the filename is the RliBook safe name",
    typeof body.filename === "string" && body.filename.includes("RliBook") && body.filename.endsWith(".pdf"),
    `filename=${body.filename}`);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status, text } = await callEndpoint(makeEnv(kv), convertUrl({ fp: "" }), fetchImpl);
  check("2. no fp -> 200 informational page", status === 200 && text.includes("نحتاج بصمتك"));
  check("2b. no proxy fetch and no bot call without fp",
    calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const kv = makeKv({ "flag:khazendar:12345": "1" });
  const { fetchImpl, calls } = makeFetch();
  const { status, text } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("3. flagged book -> 400 'غير متاح'", status === 400 && text.includes("غير متاح"));
  check("3b. no fetch at all for a flagged book", calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const kv = makeKv({ "hidden:khazendar:12345": "owner" });
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("4. hidden book -> 400", status === 400);
  check("4b. no fetch at all for a hidden book", calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), convertUrl({ f: "epub" }), fetchImpl);
  check("5. non-PDF format -> 400", status === 400);
  check("5b. no fetch at all for a non-PDF", calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), convertUrl({ lib: "hindawi", h: "", p: "" }), fetchImpl);
  check("6. OPDS lib -> 400", status === 400);
  check("6b. no fetch at all for an OPDS book", calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const badHandle = await callEndpoint(makeEnv(kv), convertUrl({ h: "bad handle!" }), fetchImpl);
  const badPost = await callEndpoint(makeEnv(kv), convertUrl({ p: "abc" }), fetchImpl);
  check("7. bad handle / bad post id -> 400", badHandle.status === 400 && badPost.status === 400);
  check("7b. no fetch at all for bad params", calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const { fetchImpl, calls } = makeFetch();
  const env = makeEnv(null);
  delete env.RLIBOOK_KV;
  const { status } = await callEndpoint(env, convertUrl(), fetchImpl);
  check("8. missing KV binding -> 503", status === 503);
  check("8b. no fetch at all without KV", calls.proxy.length === 0 && calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const env = makeEnv(kv, { PROXY_BASE_URL: "", PROXY_SIGNING_KEY: "" });
  const { status } = await callEndpoint(env, convertUrl(), fetchImpl);
  check("9. proxy not configured -> 503", status === 503);
  check("9b. no bot call without a proxy", calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch({ bookStatus: 404 });
  const { status } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("10. proxy fetch non-2xx -> 502", status === 502);
  check("10b. no bot call when the fetch fails", calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch({ bookBytes: FAKE_HTML });
  const { status } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("11. bad magic bytes (HTML) -> 502", status === 502);
  check("11b. no bot call for bad magic", calls.bot.length === 0);
}

{
  const kv = makeKv();
  const big = new Uint8Array(CONVERT_MAX_INPUT_BYTES + 1);
  big.set([0x25, 0x50, 0x44, 0x46]);
  const { fetchImpl, calls } = makeFetch({ bookBytes: big });
  const { status } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("12. oversized PDF -> 413", status === 413, `status=${status}`);
  check("12b. no bot call for an oversized PDF", calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_NO_EMAIL" } });
  const { status, text } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("13. bot E_NO_EMAIL -> 200 page with the no-email text",
    status === 200 && text.includes("ميل قارئك"));
  check("13b. the no-email page links to the bot", text.includes(BOT_LINK));
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_LIMIT" } });
  const { status, text } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("14. bot E_LIMIT -> 200 page with the daily-limit text",
    status === 200 && text.includes("الحد اليومي"));
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_FAIR_USE", waitMinutes: 10 } });
  const { status, text } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("15. bot E_FAIR_USE -> 200 page with the minutes",
    status === 200 && text.includes("10 دقيقة"), `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botThrows: true });
  const { status } = await callEndpoint(makeEnv(kv), convertUrl(), fetchImpl);
  check("16. bot fetch throws -> 502", status === 502);
}

{
  const codes = ["E_NO_EMAIL", "E_LIMIT", "E_FAIR_USE", "E_NOT_AVAILABLE", "E_TOO_BIG", "E_NO_CONVERTER", "E_SUBMIT_FAILED", "E_BAD_REQUEST"];
  check("17. botErrorText: every code maps to non-empty Arabic",
    codes.every((c) => typeof botErrorText(c) === "string" && botErrorText(c).length > 10));
  check("17b. E_FAIR_USE with minutes names them",
    botErrorText("E_FAIR_USE", 25).includes("25 دقيقة"));
  check("17c. E_FAIR_USE without minutes still reads honestly",
    botErrorText("E_FAIR_USE").includes("انتظر قليلاً"));
  check("17d. unknown code falls back to a generic message",
    botErrorText("E_WHATEVER").includes("جرّب لاحقاً"));
}

// --- summary -----------------------------------------------------------
console.log(`\nconvert-book: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
