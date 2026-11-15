// Test for the short-link resolver (functions/k/[code].js).
// Standalone Node script — run from the repo root:
//   node functions/k.test.mjs
//
// It imports the real Function module, seeds a mock KV with short
// links (the `k:<code>` entries issueShortLink writes), and calls
// onRequest() over HTTP semantics. It asserts:
//   1. a valid code -> 302 to the stored target, cache-control:
//      no-store, and the Location is exactly the stored URL;
//   2. an unknown code, a malformed code, and an expired code all
//      -> 404 with an honest "expired link" page (never a download,
//      never a crash);
//   3. no KV binding -> 404;
//   4. a code is single-book: a code minted for book A resolves to
//      A's target only, and a different code resolves to B's —
//      resolving A never yields B's URL;
//   5. a Telegram code's Location contains the signed token (t=v1.);
//   6. a non-GET method is 405.
// Exit 0 = all pass; non-zero = failure. No network, no deploy.
// All codes / URLs below are FAKE test data.

import { onRequest, extractShortCode } from "./k/[code].js";

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

const NOW = Math.floor(Date.now() / 1000);
const CODE_A = "Ab3dEf9hJk2mNn4p";
const CODE_B = "Zz9y8x7w6v5u4t3s";
const URL_A = "https://www.hindawi.org/books/13028368.epub";
const URL_B = "https://proxy.example.test/dl?h=kotobkhana&p=7559&f=epub&t=v1.testtoken";
const URL_EXPIRED = "https://www.hindawi.org/books/99999999.epub";

function kvWithLinks() {
  return makeKv({
    ["k:" + CODE_A]: JSON.stringify({ v: 1, url: URL_A, exp: NOW + 600 }),
    ["k:" + CODE_B]: JSON.stringify({ v: 1, url: URL_B, exp: NOW + 600 }),
    "k:ExpiredCode123456": JSON.stringify({ v: 1, url: URL_EXPIRED, exp: NOW - 60 }),
  });
}

async function call(code, env, method = "GET") {
  const res = await onRequest({
    request: new Request("https://rlibook.tech/k/" + code, { method }),
    env,
    params: {},
  });
  return res;
}

{
  const res = await call(CODE_A, { RLIBOOK_KV: kvWithLinks() });
  check("1a valid code -> 302", res.status === 302, "status " + res.status);
  check("1b Location is exactly the stored target",
    res.headers.get("location") === URL_A, res.headers.get("location"));
  check("1c cache-control: no-store",
    res.headers.get("cache-control") === "no-store", res.headers.get("cache-control"));
}

{
  const env = { RLIBOOK_KV: kvWithLinks() };
  const unknown = await call("QQQQQQQQQQQQQQQQ", env);
  check("2a unknown code -> 404", unknown.status === 404, "status " + unknown.status);
  check("2a unknown code -> honest expired-link page, not a bare line",
    (await unknown.text()).includes("انتهت صلاحيته"));
  const malformed = await call("short", env);
  check("2b malformed code (too short) -> 404", malformed.status === 404);
  const weird = await call("Ab3dEf9hJk2mNn4!", env);
  check("2c malformed code (bad char) -> 404", weird.status === 404);
  const expired = await call("ExpiredCode123456", env);
  check("2d expired code -> 404 (the token life already passed)",
    expired.status === 404, "status " + expired.status);
  check("2d expired code -> no redirect to the book",
    expired.headers.get("location") === null);
}

{
  const res = await call(CODE_A, {});
  check("3a no KV binding -> 404 (nothing to resolve against)",
    res.status === 404, "status " + res.status);
}

{
  const env = { RLIBOOK_KV: kvWithLinks() };
  const a = await call(CODE_A, env);
  const b = await call(CODE_B, env);
  check("4a code A resolves to A's target only",
    a.headers.get("location") === URL_A);
  check("4b code B resolves to B's target only",
    b.headers.get("location") === URL_B);
  check("4c resolving A never yields B's URL",
    a.headers.get("location") !== URL_B);
  check("5a Telegram code's Location carries the signed token (t=v1.)",
    (b.headers.get("location") || "").includes("t=v1."));
}

{
  const res = await call(CODE_A, { RLIBOOK_KV: kvWithLinks() }, "POST");
  check("6a POST -> 405", res.status === 405, "status " + res.status);
  check("6b extractShortCode reads params.code first",
    extractShortCode(new URL("https://rlibook.tech/k/AAAAAAAAAAAAAAAA"), { code: "BBBBBBBBBBBBBBBB" }) === "BBBBBBBBBBBBBBBB");
  check("6c extractShortCode falls back to the pathname",
    extractShortCode(new URL("https://rlibook.tech/k/CCCCCCCCCCCCCCCC"), {}) === "CCCCCCCCCCCCCCCC");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
