// Test for the download-token issuer (functions/api/dl-token.js).
// Standalone Node script — run from the repo root:
//   node functions/api/dl-token.test.mjs
//
// This closes the gap the design found: dl-token.js previously had
// NO dedicated test file (makeToken was covered only indirectly via
// send-to-kindle.test.mjs). It imports the real Function module,
// wraps it in a minimal mock of the Pages Function environment
// (env.RLIBOOK_KV as a Map, env as plain vars), and calls onRequest()
// over HTTP semantics. It asserts:
//   1. makeToken round-trip: the token verifies against a
//      re-computed HMAC (node:crypto), and the payload decodes to
//      the expected fields (sorted-keys JSON, 600 s TTL default);
//   2. OPDS books (lib+id) are accepted; bad lib / bad id / bad
//      format -> 400 with the right error;
//   3. the legacy Telegram form (h+p, no lib) is unchanged;
//   4. flag-denylist refusal: a KV `flag:` key present -> 403, and
//      the refusal burns no mint quota;
//   5. mint caps: 21st mint from one IP in a day -> 429; 6th
//      anonymous mint from one IP -> 429 (5/day anonymous); 20
//      fingerprinted mints ok, 21st -> 429; a refused mint does
//      not consume quota;
//   6. PROXY_SIGNING_KEY unset -> 503; proxy base unset -> 503 for
//      Telegram books but OPDS books still mint (url null, short
//      present); no KV binding -> mint still succeeds (fail open),
//      short null;
//   7. short links: a minted token carries a /k/<16-char> short
//      link that resolves (via resolveShortLink) to the right target
//      — the signed proxy URL for Telegram books, the public
//      acquisition URL for OPDS books.
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. The signing key below is FAKE test data.

import { createHmac } from "node:crypto";
import {
  onRequest,
  makeToken,
  parseBookParams,
  resolveOpdsAcquisitionUrl,
  makeShortCode,
  resolveShortLink,
  MINT_CAP_PER_IP,
  MINT_CAP_ANONYMOUS,
  MINT_CAP_FINGERPRINTED,
} from "./dl-token.js";

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

const KEY = "test_signing_key_0123456789abcdef";
const PROXY = "https://proxy.example.test";

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function verifyHmac(token, key) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expect = createHmac("sha256", key).update(parts[1]).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (expect !== parts[2]) return null;
  return JSON.parse(b64urlDecode(parts[1]));
}

async function call(params, env, ip = "1.2.3.4") {
  const url = "https://rlibook.tech/api/dl-token?" + new URLSearchParams(params).toString();
  const res = await onRequest({
    request: new Request(url, { method: "GET", headers: { "cf-connecting-ip": ip } }),
    env,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, cache: res.headers.get("cache-control") };
}

// ================= 1. makeToken round-trip ===========================
console.log("1. makeToken round-trip:");
{
  const now = 1790000000;
  const token = await makeToken(KEY, "khazendar", 12345, "epub", 600, now);
  const payload = verifyHmac(token, KEY);
  check("1a token verifies against a re-computed HMAC", payload !== null);
  check("1b payload fields (exp/f/h/p, sorted-keys JSON)",
    payload && payload.exp === now + 600 && payload.f === "epub"
    && payload.h === "khazendar" && payload.p === 12345,
    JSON.stringify(payload));
  check("1c wrong key does not verify", verifyHmac(token, "another_key") === null);
  check("1d tampered payload does not verify",
    verifyHmac(token.slice(0, -2) + "xx", KEY) === null);
  const opdsToken = await makeToken(KEY, "hindawi", "13028368", "epub", 600, now);
  const opdsPayload = verifyHmac(opdsToken, KEY);
  check("1e OPDS token: p is the book-id STRING, still verifies",
    opdsPayload !== null && opdsPayload.h === "hindawi" && opdsPayload.p === "13028368",
    JSON.stringify(opdsPayload));
}

// ================= 2. OPDS acceptance + validation ===================
console.log("2. OPDS acceptance + validation:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.0.1");
  check("2a OPDS book mints: 200 ok", r.status === 200 && r.body.ok === true, "status " + r.status);
  check("2a OPDS token verifies", r.body.token && verifyHmac(r.body.token, KEY) !== null);
  check("2a OPDS url is null (proxy cannot serve OPDS yet)",
    r.body.url === null, "url=" + r.body.url);
  check("2a OPDS short link present (/k/<16 chars>)",
    typeof r.body.short === "string" && /^\/k\/[A-Za-z0-9]{16}$/.test(r.body.short),
    r.body.short);
  check("2a OPDS short resolves to the Hindawi acquisition URL",
    (await resolveShortLink(env, r.body.short.slice(3)))?.url
      === "https://www.hindawi.org/books/13028368.epub");
  check("2a ttl 600, exp = now + 600",
    r.body.ttl === 600 && Math.abs(r.body.exp - Math.floor(Date.now() / 1000) - 600) <= 5,
    JSON.stringify({ ttl: r.body.ttl, exp: r.body.exp }));
  check("2a cache-control: no-store", r.cache === "no-store", r.cache);
}
{
  const env = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const badLib = await call({ lib: "nope", id: "1234567890", f: "epub" }, env, "10.0.0.2");
  check("2b bad lib -> 400 bad_lib",
    badLib.status === 400 && badLib.body.error === "bad_lib", JSON.stringify(badLib.body));
  const badId = await call({ lib: "khazendar", id: "a b", f: "epub" }, env, "10.0.0.3");
  check("2c bad drive id -> 400 bad_id",
    badId.status === 400 && badId.body.error === "bad_id", JSON.stringify(badId.body));
  const badHindawi = await call({ lib: "hindawi", id: "abc", f: "epub" }, env, "10.0.0.4");
  check("2d bad hindawi id -> 400 bad_id",
    badHindawi.status === 400 && badHindawi.body.error === "bad_id", JSON.stringify(badHindawi.body));
  const badFmt = await call({ lib: "hindawi", id: "13028368", f: "exe" }, env, "10.0.0.5");
  check("2e bad format -> 400 bad_format",
    badFmt.status === 400 && badFmt.body.error === "bad_format", JSON.stringify(badFmt.body));
  const noFmt = await call({ lib: "hindawi", id: "13028368" }, env, "10.0.0.6");
  check("2f missing format -> 400 bad_format (the API requires f=)",
    noFmt.status === 400 && noFmt.body.error === "bad_format", JSON.stringify(noFmt.body));
  check("2g resolveOpdsAcquisitionUrl drive",
    resolveOpdsAcquisitionUrl("khazendar", "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq")
    === "https://drive.google.com/uc?id=1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq&export=download");
  check("2g resolveOpdsAcquisitionUrl doab",
    resolveOpdsAcquisitionUrl("doab", "https://library.oapen.org/x.epub")
    === "https://library.oapen.org/x.epub");
  check("2g resolveOpdsAcquisitionUrl bad lib -> null",
    resolveOpdsAcquisitionUrl("nope", "123") === null);
}
{
  // parseBookParams unit: the delivery page + reader validate
  // identically to the API.
  const p = new URLSearchParams("lib=tg&h=KotobKhana&p=7559&f=EPUB");
  const b = parseBookParams(p);
  check("2h parseBookParams tg: handle lowercased, format lowercased",
    b.ok && b.kind === "tg" && b.handle === "kotobkhana" && b.postId === 7559 && b.fmt === "epub",
    JSON.stringify(b));
  check("2h parseBookParams default format fills a missing f=",
    parseBookParams(new URLSearchParams("lib=hindawi&id=13028368"), { defaultFormat: "epub" }).fmt === "epub");
  check("2h parseBookParams legacy h+p (no lib) is Telegram",
    parseBookParams(new URLSearchParams("h=kotobkhana&p=1&f=epub")).kind === "tg");
  check("2h parseBookParams no lib and no h -> bad_lib",
    parseBookParams(new URLSearchParams("f=epub")).error === "bad_lib");
}

// ================= 3. legacy Telegram form ===========================
console.log("3. Legacy Telegram form (h+p, no lib):");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ h: "khazendar", p: "12345", f: "epub" }, env, "10.0.1.1");
  check("3a legacy form mints: 200 ok", r.status === 200 && r.body.ok === true, "status " + r.status);
  check("3a url is the signed proxy URL",
    r.body.url === PROXY + "/dl?h=khazendar&p=12345&f=epub&t=" + encodeURIComponent(r.body.token),
    r.body.url);
  check("3a short resolves to the proxy URL",
    (await resolveShortLink(env, r.body.short.slice(3)))?.url === r.body.url);
  const r2 = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, env, "10.0.1.2");
  check("3b lib=tg form mints identically", r2.status === 200 && r2.body.ok === true);
  const badHandle = await call({ h: "x", p: "1", f: "epub" }, env, "10.0.1.3");
  check("3c bad handle -> 400 bad_handle",
    badHandle.status === 400 && badHandle.body.error === "bad_handle", JSON.stringify(badHandle.body));
  const badPost = await call({ h: "kotobkhana", p: "0", f: "epub" }, env, "10.0.1.4");
  check("3d bad post id -> 400 bad_post_id",
    badPost.status === 400 && badPost.body.error === "bad_post_id", JSON.stringify(badPost.body));
}

// ================= 4. flag denylist ==================================
console.log("4. Flag denylist:");
{
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, env, "10.0.2.1");
  check("4a flagged Telegram book -> 403 flagged",
    r.status === 403 && r.body.error === "flagged", "status " + r.status);
  check("4a flagged mint wrote no short link",
    ![...kv.map.keys()].some((k) => k.startsWith("k:")), [...kv.map.keys()].join(","));
  // The refusal burned no quota: the same IP mints a different,
  // unflagged book straight after, and the anonymous budget is
  // still whole (5 mints, not 4).
  let okCount = 0;
  for (let i = 0; i < 5; i++) {
    const rr = await call({ lib: "tg", h: "kotobkhana", p: String(9000 + i), f: "epub" }, env, "10.0.2.1");
    if (rr.status === 200) okCount++;
  }
  check("4b refused mint burned no quota (5 anonymous mints still succeed)",
    okCount === 5, "ok=" + okCount);
  const opds = await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.2.2");
  check("4c OPDS books are never flagged (PD/CC libraries)",
    opds.status === 200 && opds.body.ok === true, "status " + opds.status);
}

// ================= 5. mint caps ======================================
console.log("5. Mint caps:");
{
  // Anonymous (no fp): 5/day per IP. The 6th mint -> 429.
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.3.1");
    statuses.push(r.status);
  }
  check("5a anonymous: 5 mints ok, 6th -> 429 mint_cap_user",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 200, 200, 429]),
    JSON.stringify(statuses));
  check("5a caps are 5 anonymous / 20 per IP / 20 fingerprinted",
    MINT_CAP_ANONYMOUS === 5 && MINT_CAP_PER_IP === 20 && MINT_CAP_FINGERPRINTED === 20);
}
{
  // Fingerprinted: 20/day per fp (and 20/day per IP — both bind at
  // 21). The 21st mint -> 429.
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  let statuses = [];
  for (let i = 0; i < 21; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub", fp: "fp_test_user_1" }, env, "10.0.3.2");
    statuses.push(r.status);
  }
  check("5b fingerprinted: 20 mints ok, 21st -> 429",
    statuses.slice(0, 20).every((s) => s === 200) && statuses[20] === 429,
    JSON.stringify(statuses));
}
{
  // A different IP has its own budget (caps are per-IP, not global).
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  for (let i = 0; i < 5; i++) {
    await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.3.3");
  }
  const other = await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.3.4");
  check("5c a different IP still mints after the first IP is capped",
    other.status === 200, "status " + other.status);
}
{
  // makeShortCode: 16 chars, URL-safe alphabet, random.
  const codes = new Set([makeShortCode(), makeShortCode(), makeShortCode()]);
  check("5d short codes are 16 URL-safe chars and differ",
    [...codes].every((c) => /^[A-Za-z0-9]{16}$/.test(c)) && codes.size === 3);
  check("5d unknown short code resolves to null",
    (await resolveShortLink({ RLIBOOK_KV: makeKv() }, "ZZZZZZZZZZZZZZZZ")) === null);
}

// ================= 6. config / no-KV =================================
console.log("6. Config / no-KV behaviour:");
{
  const noKey = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" },
    { RLIBOOK_KV: makeKv(), PROXY_BASE_URL: PROXY }, "10.0.4.1");
  check("6a signing key unset -> 503 not_configured",
    noKey.status === 503 && noKey.body.error === "not_configured", JSON.stringify(noKey.body));
  const noProxy = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" },
    { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY }, "10.0.4.2");
  check("6b proxy base unset -> 503 proxy_not_configured (Telegram)",
    noProxy.status === 503 && noProxy.body.error === "proxy_not_configured", JSON.stringify(noProxy.body));
  const opdsNoProxy = await call({ lib: "hindawi", id: "13028368", f: "epub" },
    { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY }, "10.0.4.3");
  check("6c proxy base unset -> OPDS still mints (url null, short present)",
    opdsNoProxy.status === 200 && opdsNoProxy.body.url === null
    && /^\/k\/[A-Za-z0-9]{16}$/.test(opdsNoProxy.body.short || ""),
    JSON.stringify(opdsNoProxy.body));
  const noKv = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" },
    { PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY }, "10.0.4.4");
  check("6d no KV binding -> mint still succeeds (fail open), short null",
    noKv.status === 200 && noKv.body.ok === true && noKv.body.short === null,
    JSON.stringify(noKv.body));
  const post = await onRequest({
    request: new Request("https://rlibook.tech/api/dl-token?h=a&p=1&f=epub", { method: "POST" }),
    env: { PROXY_SIGNING_KEY: KEY },
  });
  check("6e POST -> 405", post.status === 405, "status " + post.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
