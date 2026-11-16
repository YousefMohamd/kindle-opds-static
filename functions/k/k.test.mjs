// Tests for the /k/<code> short-link resolver (functions/k/[code].js).
// Single-use (2026-11-16, D5 reversal): the first successful resolve
// 302s AND deletes the entry, so a replay 404s.
// Run: node functions/k/k.test.mjs   (from the repo root)
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no deploy.

import { onRequest, extractShortCode } from "./[code].js";
import { storeShortLink } from "../api/dl-token.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
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

const TARGET = "https://proxy.example.test/dl?h=kotobkhana&p=7559&f=epub&t=v1.abc.def";
const CODE = "Ab3dEf9hJk2mNn4p";

async function call(code, env, method = "GET") {
  const req = new Request("https://example.com/k/" + code, { method });
  const res = await onRequest({ request: req, env, params: { code } });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

// ================= 1. extractShortCode ==============================
console.log("1. extractShortCode:");
{
  check("1a params.code wins",
    extractShortCode(new URL("https://example.com/k/XXXX"), { code: CODE }) === CODE);
  check("1b pathname fallback",
    extractShortCode(new URL("https://example.com/k/" + CODE), {}) === CODE);
  check("1c no code -> empty",
    extractShortCode(new URL("https://example.com/k/"), {}) === "");
}

// ================= 2. single-use resolve ============================
console.log("2. Single-use resolve:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv };
  await storeShortLink(env, CODE, TARGET, Math.floor(Date.now() / 1000) + 600);
  const first = await call(CODE, env);
  check("2a first resolve -> 302 to the target",
    first.status === 302 && first.location === TARGET,
    `status=${first.status} location=${first.location}`);
  check("2b entry consumed (deleted from KV)",
    !kv.map.has("k:" + CODE));
  const replay = await call(CODE, env);
  check("2c replay -> 404 (single-use)",
    replay.status === 404, "status=" + replay.status);
  check("2d replay page says the link works once",
    replay.body.includes("مرة واحدة"));
  const third = await call(CODE, env);
  check("2e third tap still 404", third.status === 404);
}

// ================= 3. unknown / malformed / expired =================
console.log("3. Unknown / malformed / expired:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv };
  const unknown = await call("ZZZZZZZZZZZZZZZZ", env);
  check("3a unknown code -> 404", unknown.status === 404, "status=" + unknown.status);
  const bad = await call("short", env);
  check("3b malformed code (not 16 alphanumerics) -> 404",
    bad.status === 404, "status=" + bad.status);
  // Expired entry: stored directly with a past exp.
  kv.map.set("k:ExpiredCode123456",
    JSON.stringify({ v: 1, url: TARGET, exp: Math.floor(Date.now() / 1000) - 10 }));
  const expired = await call("ExpiredCode123456", env);
  check("3c expired entry -> 404 (and not consumed twice over)",
    expired.status === 404, "status=" + expired.status);
  // No KV binding at all.
  const noKv = await call(CODE, {});
  check("3d no KV binding -> 404", noKv.status === 404, "status=" + noKv.status);
}

// ================= 4. method + cache ================================
console.log("4. Method + cache:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv };
  await storeShortLink(env, CODE, TARGET, Math.floor(Date.now() / 1000) + 600);
  const req = new Request("https://example.com/k/" + CODE, { method: "POST" });
  const res = await onRequest({ request: req, env, params: { code: CODE } });
  check("4a non-GET -> 405 (and the entry is NOT consumed)",
    res.status === 405 && kv.map.has("k:" + CODE), "status=" + res.status);
  const kv2 = makeKv();
  await storeShortLink({ RLIBOOK_KV: kv2 }, CODE, TARGET, Math.floor(Date.now() / 1000) + 600);
  const req2 = new Request("https://example.com/k/" + CODE, { method: "GET" });
  const res2 = await onRequest({ request: req2, env: { RLIBOOK_KV: kv2 }, params: { code: CODE } });
  check("4b redirect is no-store",
    res2.status === 302 && res2.headers.get("cache-control") === "no-store",
    `status=${res2.status} cache=${res2.headers.get("cache-control")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
