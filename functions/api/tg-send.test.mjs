// Test for the Telegram direct-send endpoint (functions/api/tg-send.js).
// Standalone Node script — run from the repo root:
//   node functions/api/tg-send.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock of
// the Pages Function environment (env.RLIBOOK_KV as a Map), mocks
// global fetch (the bot worker's /tg-send only — this endpoint moves
// no bytes itself), and calls onRequest() over HTTP semantics.
// It asserts the response contract for:
//   1. happy path: POSTed to the bot, 200 success page; the bot call
//      carries fp + handle + postId + format + title + size
//   2. no fp -> informational page (200), no bot call
//   3. flagged book -> 400, no bot call
//   4. hidden book -> 400, no bot call
//   5. bad format (exe) -> 400, no bot call
//   6. OPDS lib -> 400, no bot call
//   7. bad handle / bad post id -> 400, no bot call
//   8. missing KV binding -> 503
//   9. bot E_NO_USER -> 200 page with the no-user text + bot link
//  10. bot E_LIMIT -> 200 page with the daily-limit text
//  11. bot E_TOO_BIG -> 200 page with the too-big text
//  12. bot E_NOT_AVAILABLE -> 200 page
//  13. bot fetch throws -> 502
//  14. bot non-JSON -> 502
//  15. botErrorText: every code maps to non-empty Arabic text
//  16. POST (not GET) -> 405
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no bot worker, no deploy.
// All fingerprints / books below are FAKE test data.

import {
  onRequest,
  botErrorText,
  WORKER_BASE,
  BOT_LINK,
} from "./tg-send.js";

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

const FP = "test-fingerprint-abcdef";

function makeEnv(kv, over = {}) {
  return {
    RLIBOOK_KV: kv,
    ...over,
  };
}

function tgSendUrl(over = {}) {
  const q = new URLSearchParams({
    lib: "tg", h: "khazendar", p: "12345", f: "epub", t: "Test Book", s: "2.7 MB", fp: FP,
    ...over,
  });
  return "https://rlibook.tech/api/tg-send?" + q.toString();
}

/** Mock global fetch: the bot worker's /tg-send only. botResult: the
 *  JSON the bot returns (null = non-JSON). botThrows: the fetch
 *  rejects. Captures every bot call (parsed JSON body) in calls.bot. */
function makeFetch({ botResult = { ok: true, via: "url" }, botThrows = false } = {}) {
  const calls = { bot: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(WORKER_BASE + "/tg-send")) {
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
    throw new Error("unexpected fetch: " + u);
  };
  return { fetchImpl, calls };
}

async function callEndpoint(env, url, fetchImpl, method = "GET") {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const res = await onRequest({
      request: new Request(url, { method }),
      env,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    globalThis.fetch = prevFetch;
  }
}

// --- tests -------------------------------------------------------------
console.log("tg-send endpoint tests:");

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("1. happy path -> 200 success page", status === 200 && text.includes("تم الإرسال إلى تيليجرام"), `status=${status}`);
  check("1b. the page names the book + the Kindle share step", text.includes("Test Book") && text.includes("Send to Kindle"));
  check("1c. the bot was called once", calls.bot.length === 1, `bot=${calls.bot.length}`);
  const body = calls.bot[0]?.body || {};
  check("1d. the bot call carries the fingerprint", body.fp === FP);
  check("1e. the bot call carries handle + postId + format", body.handle === "khazendar" && body.postId === "12345" && body.format === "epub");
  check("1f. the bot call carries title + size hint", body.title === "Test Book" && body.size === "2.7 MB");
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl({ fp: "" }), fetchImpl);
  check("2. no fp -> 200 identity page, no bot call", status === 200 && text.includes("نحتاج بصمتك أولاً") && calls.bot.length === 0, `status=${status}`);
  check("2b. the identity page links the bot", text.includes(BOT_LINK));
}

{
  const kv = makeKv({ "flag:khazendar:12345": "1" });
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("3. flagged book -> 400, no bot call", status === 400 && calls.bot.length === 0, `status=${status}`);
}

{
  const kv = makeKv({ "hidden:khazendar:12345": "owner" });
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("4. hidden book -> 400, no bot call", status === 400 && calls.bot.length === 0, `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), tgSendUrl({ f: "exe" }), fetchImpl);
  check("5. bad format -> 400, no bot call", status === 400 && calls.bot.length === 0, `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), tgSendUrl({ lib: "hindawi" }), fetchImpl);
  check("6. OPDS lib -> 400, no bot call", status === 400 && calls.bot.length === 0, `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const badHandle = await callEndpoint(makeEnv(kv), tgSendUrl({ h: "bad handle!" }), fetchImpl);
  check("7a. bad handle -> 400", badHandle.status === 400, `status=${badHandle.status}`);
  const badPost = await callEndpoint(makeEnv(kv), tgSendUrl({ p: "abc" }), fetchImpl);
  check("7b. bad post id -> 400", badPost.status === 400, `status=${badPost.status}`);
  check("7c. no bot call for either", calls.bot.length === 0, `bot=${calls.bot.length}`);
}

{
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint({ RLIBOOK_KV: undefined }, tgSendUrl(), fetchImpl);
  check("8. missing KV binding -> 503", status === 503, `status=${status}`);
  check("8b. no bot call", calls.bot.length === 0);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_NO_USER" } });
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("9. bot E_NO_USER -> 200 page with the no-user text + bot link", status === 200 && text.includes("لم نتمكن من معرفة من أنت") && text.includes(BOT_LINK), `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_LIMIT" } });
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("10. bot E_LIMIT -> 200 page with the daily-limit text", status === 200 && text.includes("حد التحميل اليومي"), `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_TOO_BIG" } });
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("11. bot E_TOO_BIG -> 200 page with the too-big text", status === 200 && text.includes("40 ميجابايت"), `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: { ok: false, code: "E_NOT_AVAILABLE" } });
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("12. bot E_NOT_AVAILABLE -> 200 page", status === 200 && text.includes("غير متاح للإرسال"), `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botThrows: true });
  const { status, text } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("13. bot fetch throws -> 502", status === 502 && text.includes("تعذّر الاتصال"), `status=${status}`);
}

{
  const kv = makeKv();
  const { fetchImpl } = makeFetch({ botResult: null });
  const { status } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl);
  check("14. bot non-JSON -> 502", status === 502, `status=${status}`);
}

{
  const codes = ["E_NO_USER", "E_LIMIT", "E_NOT_AVAILABLE", "E_TOO_BIG", "E_SEND_FAILED", "E_WHATEVER"];
  check("15. botErrorText: every code maps to non-empty Arabic text",
    codes.every((c) => typeof botErrorText(c) === "string" && botErrorText(c).length > 0));
}

{
  const kv = makeKv();
  const { fetchImpl, calls } = makeFetch();
  const { status } = await callEndpoint(makeEnv(kv), tgSendUrl(), fetchImpl, "POST");
  check("16. POST (not GET) -> 405, no bot call", status === 405 && calls.bot.length === 0, `status=${status}`);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
