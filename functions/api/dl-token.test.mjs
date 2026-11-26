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
//   5. mint caps: 6th mint from one IP in a day -> 429 (5/day for
//      everyone — anonymous, per-IP and fingerprinted alike);
//      a refused mint does not consume quota;
//   6. PROXY_SIGNING_KEY unset -> 503; proxy base unset -> 503 for
//      Telegram books but OPDS books still mint (url null, short
//      present); no KV binding -> mint still succeeds (fail open),
//      short null;
//   7. short links: a minted token carries a /k/<16-char> short
//      link that resolves (via resolveShortLink) to the right target
//   8. Single-use short links (resolveAndConsumeShortLink):
//   9. Personal books (2026-11-16): makeReaderToken own flag +
//      readerTokenOwn; isPersonalBook (fp -> tg_id -> priv title
//      match); mintTokenForBook own skips the flag gate + the mint
//      caps but keeps the hidden check; /api/dl-token end-to-end
//      with fp+t proving own.
//  10. Service-key exemption (E_LIMIT Option A, 2026-11-26): a
//      request with the right `Authorization: Bearer
//      <DL_TOKEN_SERVICE_KEY>` skips the per-IP counter (a second
//      fingerprint from the same IP still mints after the first
//      spent its 5) while the per-fingerprint cap still binds
//      (6th mint for one fp -> 429 mint_cap_user); a wrong key or
//      an unset secret falls through to the normal IP-counted
//      path; flag/hidden gates still refuse service mints.
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
  resolveAndConsumeShortLink,
  storeShortLink,
  isFlaggedBook,
  isHiddenBook,
  MINT_CAP_PER_IP,
  MINT_CAP_ANONYMOUS,
  MINT_CAP_FINGERPRINTED,
  makeReaderToken,
  verifyReaderToken,
  readerTokenOwn,
  isPersonalBook,
  mintTokenForBook,
  READER_TOKEN_TTL_SECONDS,
  timingSafeEqual,
  isServiceKeyRequest,
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

async function call(params, env, ip = "1.2.3.4", extraHeaders = {}) {
  const url = "https://rlibook.tech/api/dl-token?" + new URLSearchParams(params).toString();
  const res = await onRequest({
    request: new Request(url, { method: "GET", headers: { "cf-connecting-ip": ip, ...extraHeaders } }),
    env,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, cache: res.headers.get("cache-control") };
}

const SVC_KEY = "svc-test-key-0123456789abcdef";
const svcAuth = { Authorization: "Bearer " + SVC_KEY };

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
  const docx = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "docx" }, env, "10.0.0.7");
  check("2e2 doc/docx mint: 200 ok (book cards link them; send-to-kindle accepts them)",
    docx.status === 200 && docx.body.ok === true, JSON.stringify(docx.body));
  const doc = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "doc" }, env, "10.0.0.8");
  check("2e3 doc mints: 200 ok",
    doc.status === 200 && doc.body.ok === true, JSON.stringify(doc.body));
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

// ================= 4b. owner-hide denylist (Workstream 2b) =============
// An owner /hide sets `hidden:` — never a user report (an approved
// report sets `flag:` instead). The gate sits after the flag gate
// and before any counter, like the flag gate.
console.log("4b. Owner-hide denylist:");
{
  const kv = makeKv({ "hidden:kotobkhana:7559": "owner" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, env, "10.0.2.5");
  check("4d hidden Telegram book -> 403 hidden",
    r.status === 403 && r.body.error === "hidden", "status " + r.status + " " + JSON.stringify(r.body));
  check("4d hidden mint wrote no short link",
    ![...kv.map.keys()].some((k) => k.startsWith("k:")), [...kv.map.keys()].join(","));
  // The refusal burned no quota: 5 anonymous mints still succeed.
  let okCount = 0;
  for (let i = 0; i < 5; i++) {
    const rr = await call({ lib: "tg", h: "kotobkhana", p: String(9000 + i), f: "epub" }, env, "10.0.2.5");
    if (rr.status === 200) okCount++;
  }
  check("4e refused hidden mint burned no quota (5 anonymous mints still succeed)",
    okCount === 5, "ok=" + okCount);
  // Flag gate runs first: a book with both keys gets "flagged".
  const kvBoth = makeKv({ "flag:kotobkhana:7559": "1", "hidden:kotobkhana:7559": "owner" });
  const envBoth = { RLIBOOK_KV: kvBoth, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const rb = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, envBoth, "10.0.2.6");
  check("4f flagged + hidden -> 403 flagged (flag gate first)",
    rb.status === 403 && rb.body.error === "flagged", "status " + rb.status);
  // isHiddenBook unit checks (exported): present -> true, absent ->
  // false, no KV -> false, KV outage -> true (fail closed).
  check("4g isHiddenBook: key present -> true",
    (await isHiddenBook(env, "kotobkhana", 7559)) === true);
  check("4g isHiddenBook: key absent -> false",
    (await isHiddenBook(env, "kotobkhana", 7558)) === false);
  check("4g isHiddenBook: no KV binding -> false",
    (await isHiddenBook({}, "kotobkhana", 7559)) === false);
  check("4g isHiddenBook: KV outage -> true (fail closed)",
    (await isHiddenBook({ RLIBOOK_KV: { get: async () => { throw new Error("down"); } } }, "kotobkhana", 7559)) === true);
  check("4g isFlaggedBook: KV outage -> true (fail closed)",
    (await isFlaggedBook({ RLIBOOK_KV: { get: async () => { throw new Error("down"); } } }, "kotobkhana", 7559)) === true);
  // OPDS books are never hidden (no post identity).
  const opds = await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.2.7");
  check("4h OPDS books are never hidden",
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
  check("5a caps are 5 anonymous / 5 per IP / 5 fingerprinted",
    MINT_CAP_ANONYMOUS === 5 && MINT_CAP_PER_IP === 5 && MINT_CAP_FINGERPRINTED === 5);
}
{
  // Fingerprinted: 5/day per fp (and 5/day per IP — both bind at
  // 6). The 6th mint -> 429.
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub", fp: "fp_test_user_1" }, env, "10.0.3.2");
    statuses.push(r.status);
  }
  check("5b fingerprinted: 5 mints ok, 6th -> 429",
    statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429,
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

// ================= 7. reader tokens ================================
console.log("7. Reader tokens (makeReaderToken / verifyReaderToken):");
{
  const NOW = Math.floor(Date.now() / 1000);
  const book = { kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" };
  const tok = await makeReaderToken(KEY, "hindawi", "13028368", "epub", 3600, NOW);
  check("7a shape v1.<payload>.<sig>, ttl constant is 3600",
    tok.startsWith("v1.") && tok.split(".").length === 3 && READER_TOKEN_TTL_SECONDS === 3600, tok.slice(0, 20));
  check("7a fresh token verifies for its book",
    (await verifyReaderToken(KEY, tok, book, NOW)) === true);
  check("7a token does not verify for another book",
    (await verifyReaderToken(KEY, tok, { kind: "opds", lib: "hindawi", id: "99999999", fmt: "epub" }, NOW)) === false);
  check("7a token does not verify for another format",
    (await verifyReaderToken(KEY, tok, { kind: "opds", lib: "hindawi", id: "13028368", fmt: "pdf" }, NOW)) === false);
  check("7a token does not verify after expiry",
    (await verifyReaderToken(KEY, tok, book, NOW + 3601)) === false);
  check("7a token does not verify with another key",
    (await verifyReaderToken("other-key-0123456789abcdef01234567", tok, book, NOW)) === false);
  check("7a token does not verify with no key",
    (await verifyReaderToken("", tok, book, NOW)) === false);
  check("7a garbage / null / wrong-shape tokens are false, never a throw",
    (await verifyReaderToken(KEY, "garbage", book, NOW)) === false
    && (await verifyReaderToken(KEY, null, book, NOW)) === false
    && (await verifyReaderToken(KEY, "v1.aaa", book, NOW)) === false);
  const tgTok = await makeReaderToken(KEY, "kotobkhana", 7559, "pdf", 3600, NOW);
  check("7b Telegram token verifies for its book (numeric post id)",
    (await verifyReaderToken(KEY, tgTok, { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "pdf" }, NOW)) === true);
  const dlTok = await makeToken(KEY, "hindawi", "13028368", "epub", 600, NOW);
  check("7c a download token is NOT a reader token (no k:read)",
    (await verifyReaderToken(KEY, dlTok, book, NOW)) === false);
  check("7c a reader token is not a download token shape (payload has k:read)",
    JSON.parse(Buffer.from(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")).k === "read");
}

// ================= 8. single-use short links ========================
console.log("8. Single-use short links (resolveAndConsumeShortLink):");
{
  const NOW = Math.floor(Date.now() / 1000);
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv };
  const code = "Ab3dEf9hJk2mNn4p";
  const target = PROXY + "/dl?h=kotobkhana&p=7559&f=epub&t=v1.abc.def";
  await storeShortLink(env, code, target, NOW + 600);
  const first = await resolveAndConsumeShortLink(env, code);
  check("8a first resolve returns the target",
    first !== null && first.url === target, JSON.stringify(first));
  check("8b entry deleted from KV after first resolve",
    !kv.map.has("k:" + code));
  const replay = await resolveAndConsumeShortLink(env, code);
  check("8c replay -> null (single-use)", replay === null);
  check("8d read-only resolveShortLink still sees nothing after consume",
    (await resolveShortLink(env, code)) === null);
  const unknown = await resolveAndConsumeShortLink(env, "ZZZZZZZZZZZZZZZZ");
  check("8e unknown code -> null", unknown === null);
  // Expired entry is null AND is not deleted by the consume path
  // (nothing to consume — resolveShortLink already rejects it).
  kv.map.set("k:ExpiredCode123456",
    JSON.stringify({ v: 1, url: target, exp: NOW - 10 }));
  const expired = await resolveAndConsumeShortLink(env, "ExpiredCode123456");
  check("8f expired entry -> null", expired === null);
  // Malformed entry (no url) -> null.
  kv.map.set("k:BadEntry12345678", JSON.stringify({ v: 1, exp: NOW + 600 }));
  const bad = await resolveAndConsumeShortLink(env, "BadEntry12345678");
  check("8g malformed entry -> null", bad === null);
  // No KV binding -> null.
  const noKv = await resolveAndConsumeShortLink({}, code);
  check("8h no KV binding -> null", noKv === null);
}

// ================= 9. Personal books (own) ==========================
console.log("9. Personal books (own flag + isPersonalBook):");
{
  const now = Math.floor(Date.now() / 1000);
  const ownTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub",
    READER_TOKEN_TTL_SECONDS, now, true);
  const ownPayload = verifyHmac(ownTok, KEY);
  check("9a own reader token carries payload o:1",
    ownPayload !== null && ownPayload.o === 1, JSON.stringify(ownPayload));
  const libTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub",
    READER_TOKEN_TTL_SECONDS, now);
  const libPayload = verifyHmac(libTok, KEY);
  check("9b library reader token carries no o field",
    libPayload !== null && !("o" in libPayload), JSON.stringify(libPayload));
  check("9c readerTokenOwn(own token) -> true",
    (await readerTokenOwn(KEY, ownTok)) === true);
  check("9d readerTokenOwn(library token) -> false",
    (await readerTokenOwn(KEY, libTok)) === false);
  const tampered = ownTok.slice(0, -2) + "xx";
  check("9e readerTokenOwn(tampered token) -> false",
    (await readerTokenOwn(KEY, tampered)) === false);
  const expired = await makeReaderToken(KEY, "kotobkhana", 7559, "epub",
    READER_TOKEN_TTL_SECONDS, now - 4000, true);
  check("9e2 readerTokenOwn(expired token) -> false",
    (await readerTokenOwn(KEY, expired)) === false);
}
{
  // fp:abc123 -> { tg_id: 777 }; priv:777 lists the user's books.
  const kv = makeKv({
    "fp:abc123": JSON.stringify({ tg_id: 777, created_at: "2026-11-01T00:00:00Z" }),
    "priv:777": JSON.stringify([
      { title: "My Book", author: "Me", source: "upload", added_at: "2026-11-01T00:00:00Z" },
      { title: "Another Title", author: "X", source: "upload", added_at: "2026-11-02T00:00:00Z" },
    ]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  check("9f isPersonalBook: fp + exact title -> true",
    (await isPersonalBook(env, "abc123", "My Book")) === true);
  check("9g isPersonalBook: fp + other title -> false",
    (await isPersonalBook(env, "abc123", "Not Mine")) === false);
  check("9h isPersonalBook: unknown fp -> false",
    (await isPersonalBook(env, "nope", "My Book")) === false);
  check("9i isPersonalBook: title match is case-insensitive + trimmed",
    (await isPersonalBook(env, "abc123", "  my book ")) === true);
  check("9j isPersonalBook: no KV binding -> false",
    (await isPersonalBook({ PROXY_SIGNING_KEY: KEY }, "abc123", "My Book")) === false);
  check("9j2 isPersonalBook: empty fp/title -> false",
    (await isPersonalBook(env, "", "My Book")) === false
    && (await isPersonalBook(env, "abc123", "")) === false);
}
{
  const book = { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" };
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const ownMint = await mintTokenForBook(env, book, { ip: "10.9.0.1", fp: "abc123", own: true });
  check("9k mintTokenForBook own + flagged book -> ok (flag gate skipped)",
    ownMint.ok === true && !!ownMint.token, JSON.stringify(ownMint));
  const counted = [...kv.map.keys()].some((k) => k.startsWith("dlt:"));
  check("9l own mint burns no quota (no dlt:* counter)",
    counted === false, [...kv.map.keys()].join(","));
  const libMint = await mintTokenForBook(env, book, { ip: "10.9.0.2", fp: "abc123" });
  check("9m library mint of the same flagged book -> 403 flagged",
    libMint.ok === false && libMint.error === "flagged", JSON.stringify(libMint));
}
{
  const book = { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" };
  const kv = makeKv({
    "hidden:kotobkhana:7559": "owner",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const ownHidden = await mintTokenForBook(env, book, { ip: "10.9.0.3", fp: "abc123", own: true });
  check("9m2 mintTokenForBook own + HIDDEN book -> 403 hidden (hide wins)",
    ownHidden.ok === false && ownHidden.error === "hidden", JSON.stringify(ownHidden));
}
{
  // End-to-end through onRequest: fp+t proves the book is the
  // caller's own upload, so a flagged book mints; a title that
  // does not match the private feed does not.
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const own = await call({ h: "kotobkhana", p: "7559", f: "epub", fp: "abc123", t: "My Book" },
    env, "10.9.1.1");
  check("9n GET with fp+t (own, flagged book) -> 200",
    own.status === 200 && own.body && own.body.ok === true, "status " + own.status);
  const wrong = await call({ h: "kotobkhana", p: "7559", f: "epub", fp: "abc123", t: "Not Mine" },
    env, "10.9.1.2");
  check("9o GET with fp + wrong title -> 403 flagged (claim alone is not proof)",
    wrong.status === 403 && wrong.body && wrong.body.error === "flagged",
    "status " + wrong.status);
}

// ================= 10. Service-key exemption (E_LIMIT Option A) ======
// A request with the right Bearer key skips the per-IP counter;
// the per-fingerprint cap still binds; wrong key / unset secret
// fall through to the normal path; flag + hidden gates still refuse.
console.log("10. Service-key exemption (E_LIMIT Option A):");
{
  // timingSafeEqual units.
  check("10a timingSafeEqual: equal strings -> true",
    timingSafeEqual("abc123", "abc123") === true);
  check("10a timingSafeEqual: different strings -> false",
    timingSafeEqual("abc123", "abc124") === false);
  check("10a timingSafeEqual: different lengths -> false",
    timingSafeEqual("abc", "abcd") === false);
  check("10a timingSafeEqual: non-strings -> false",
    timingSafeEqual(null, "abc") === false && timingSafeEqual("abc", undefined) === false);
  // isServiceKeyRequest units (a Request with headers only).
  const req = (auth) => new Request("https://rlibook.tech/api/dl-token",
    { headers: auth ? { Authorization: auth } : {} });
  check("10b isServiceKeyRequest: right key -> true",
    isServiceKeyRequest(req("Bearer " + SVC_KEY), { DL_TOKEN_SERVICE_KEY: SVC_KEY }) === true);
  check("10b isServiceKeyRequest: wrong key -> false",
    isServiceKeyRequest(req("Bearer wrong-key"), { DL_TOKEN_SERVICE_KEY: SVC_KEY }) === false);
  check("10b isServiceKeyRequest: no header -> false",
    isServiceKeyRequest(req(null), { DL_TOKEN_SERVICE_KEY: SVC_KEY }) === false);
  check("10b isServiceKeyRequest: secret unset -> false (fail closed)",
    isServiceKeyRequest(req("Bearer " + SVC_KEY), {}) === false);
  check("10b isServiceKeyRequest: non-Bearer scheme -> false",
    isServiceKeyRequest(req("Basic " + SVC_KEY), { DL_TOKEN_SERVICE_KEY: SVC_KEY }) === false);
}
{
  // One fp, one IP, service key: 5 mints ok, 6th -> 429
  // mint_cap_user (the fp cap still binds).
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY, DL_TOKEN_SERVICE_KEY: SVC_KEY };
  let statuses = [];
  let errors = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub", fp: "fp_svc_user_1" }, env, "10.0.5.1", svcAuth);
    statuses.push(r.status);
    errors.push(r.body && r.body.error);
  }
  check("10c service key: 5 fingerprinted mints ok, 6th -> 429 mint_cap_user (fp cap still enforced)",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 200, 200, 429]) && errors[5] === "mint_cap_user",
    JSON.stringify({ statuses, errors }));
  check("10c service mints wrote NO per-IP counter for that IP",
    ![...kv.map.keys()].some((k) => k.startsWith("dlt:ip:10.0.5.1")),
    [...kv.map.keys()].join(","));
  check("10c service mints WERE counted in the svc observability counter (6 attempts incl. the fp-refused one)",
    Number(kv.map.get("dlt:svc:" + new Date().toISOString().slice(0, 10)) || "0") === 6,
    [...kv.map.keys()].join(","));
  // A DIFFERENT fp from the SAME IP still mints (the IP counter
  // never bound) — this is the whole point of Option A.
  const other = await call({ lib: "hindawi", id: "13028368", f: "epub", fp: "fp_svc_user_2" }, env, "10.0.5.1", svcAuth);
  check("10d service key: a second fp from the same IP still mints after the first spent its 5",
    other.status === 200 && other.body.ok === true, "status " + other.status);
}
{
  // Anonymous service mint (no fp): still capped at 5/day via the
  // anon counter — the exemption never means unbounded.
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY, DL_TOKEN_SERVICE_KEY: SVC_KEY };
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub" }, env, "10.0.5.2", svcAuth);
    statuses.push(r.status);
  }
  check("10e anonymous service mint: 5 ok, 6th -> 429 (anon cap still binds)",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 200, 200, 429]),
    JSON.stringify(statuses));
  check("10e anonymous service mints wrote NO per-IP counter",
    ![...kv.map.keys()].some((k) => k.startsWith("dlt:ip:")),
    [...kv.map.keys()].join(","));
}
{
  // WRONG key: the normal IP-counted path runs (fail closed).
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY, DL_TOKEN_SERVICE_KEY: SVC_KEY };
  let statuses = [];
  let errors = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub", fp: "fp_wrong_key_1" }, env, "10.0.5.3", { Authorization: "Bearer wrong-key" });
    statuses.push(r.status);
    errors.push(r.body && r.body.error);
  }
  check("10f wrong key: 5 mints ok, 6th -> 429 mint_cap_ip (normal path, IP counter binds first)",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 200, 200, 429]) && errors[5] === "mint_cap_ip",
    JSON.stringify({ statuses, errors }));
  check("10f wrong-key mints wrote NO svc counter (no exemption happened)",
    ![...kv.map.keys()].some((k) => k.startsWith("dlt:svc:")),
    [...kv.map.keys()].join(","));
}
{
  // Secret UNSET on the website: a Bearer header is ignored, the
  // normal path runs (the website code alone is safe to ship).
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub", fp: "fp_no_secret_1" }, env, "10.0.5.4", svcAuth);
    statuses.push(r.status);
  }
  check("10g secret unset: Bearer header ignored, 5 ok then 429 (normal path)",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 200, 200, 429]),
    JSON.stringify(statuses));
}
{
  // Flag + hidden gates still refuse service-key mints, and the
  // refusal burns no quota (no svc count, no fp count).
  const kv = makeKv({ "flag:kotobkhana:7559": "1", "hidden:kotobkhana:7558": "owner" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY, DL_TOKEN_SERVICE_KEY: SVC_KEY };
  const flagged = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", fp: "fp_svc_flag_1" }, env, "10.0.5.5", svcAuth);
  check("10h flagged book + service key -> 403 flagged (gate untouched)",
    flagged.status === 403 && flagged.body.error === "flagged", "status " + flagged.status);
  const hidden = await call({ lib: "tg", h: "kotobkhana", p: "7558", f: "epub", fp: "fp_svc_flag_1" }, env, "10.0.5.5", svcAuth);
  check("10h hidden book + service key -> 403 hidden (gate untouched)",
    hidden.status === 403 && hidden.body.error === "hidden", "status " + hidden.status);
  check("10h refused service mints burned no quota (no dlt:* counter at all)",
    ![...kv.map.keys()].some((k) => k.startsWith("dlt:")),
    [...kv.map.keys()].join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
