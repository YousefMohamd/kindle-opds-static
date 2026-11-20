// Test for the website-identity endpoint (functions/api/identify.js).
// Standalone Node script — run from the repo root:
//   node functions/api/identify.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock of
// the Pages Function environment (env.RLIBOOK_KV as a Map), and calls
// onRequest() over HTTP semantics. It asserts the response contract:
//   1. fp valid + email -> linked, masked email, rlb_fp cookie set
//   2. fp valid, no email -> linked, email_masked null
//   3. fp unknown -> linked:false, no cookie
//   4. fp too long -> linked:false (no KV read)
//   5. code valid -> linked, cookie set, code deleted (one-time)
//   6. code bad format / unknown -> E_BAD_CODE 400
//   7. code attempts rate-limited per IP (10/10min -> 429)
//   8. cookie valid -> linked (no fp param)
//   9. cookie revoked -> linked:false + clear-cookie
//  10. nothing -> linked:false
//  11. missing KV binding -> 503
//  12. POST (not GET) -> 405
//  13. maskEmail: first two chars + ***@domain
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no deploy.
// All fingerprints / emails below are FAKE test data.

import {
  onRequest,
  maskEmail,
  cookieHeader,
  clearCookieHeader,
  parseCookies,
  COOKIE_NAME,
  CODE_ATTEMPT_LIMIT,
} from "./identify.js";

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

const FP = "abcdefghijklmnopqrstuv";
const EMAIL = "mohamedyou1357@kindle.com";

function seededKv() {
  return makeKv({
    ["fp:" + FP]: JSON.stringify({ tg_id: 111, created_at: "2026-11-20T00:00:00Z" }),
    ["kindle_email:111"]: EMAIL,
    ["fp:noemailfp1234567890ab"]: JSON.stringify({ tg_id: 222, created_at: "2026-11-20T00:00:00Z" }),
    ["linkcode:123456"]: JSON.stringify({ fp: FP, tg_id: 111, created_at: "2026-11-20T00:00:00Z" }),
  });
}

function makeEnv(kv, over = {}) {
  return { RLIBOOK_KV: kv, ...over };
}

async function callEndpoint(env, url, headers = {}, method = "GET") {
  const res = await onRequest({
    request: new Request(url, { method, headers }),
    env,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, body, setCookie: res.headers.get("set-cookie") };
}

function idUrl(params = {}) {
  const q = new URLSearchParams(params);
  const s = q.toString();
  return "https://rlibook.tech/api/identify" + (s ? "?" + s : "");
}

// --- tests -------------------------------------------------------------
console.log("identify endpoint tests:");

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ fp: FP }));
  check("1. fp valid + email -> linked", r.status === 200 && r.body && r.body.ok === true && r.body.linked === true, `status=${r.status} body=${r.text}`);
  check("1b. email is masked (first two chars + ***)", r.body && r.body.email_masked === "mo***@kindle.com", `masked=${r.body && r.body.email_masked}`);
  check("1c. rlb_fp cookie is set (HttpOnly, Path=/)", !!r.setCookie && r.setCookie.includes(COOKIE_NAME + "=" + FP) && r.setCookie.includes("HttpOnly") && r.setCookie.includes("Path=/"), `cookie=${r.setCookie}`);
  check("1d. the full email never appears in the reply", !r.text.includes(EMAIL));
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ fp: "noemailfp1234567890ab" }));
  check("2. fp valid, no email -> linked, email_masked null", r.status === 200 && r.body && r.body.linked === true && r.body.email_masked === null, `body=${r.text}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ fp: "unknownfp000000000000" }));
  check("3. fp unknown -> linked:false", r.status === 200 && r.body && r.body.linked === false, `body=${r.text}`);
  check("3b. no cookie on unknown fp", !r.setCookie);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ fp: "x".repeat(200) }));
  check("4. fp too long -> linked:false", r.status === 200 && r.body && r.body.linked === false, `body=${r.text}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ code: "123456" }), { "CF-Connecting-IP": "1.2.3.4" });
  check("5. code valid -> linked", r.status === 200 && r.body && r.body.linked === true && r.body.email_masked === "mo***@kindle.com", `body=${r.text}`);
  check("5b. cookie set from the code's fingerprint", !!r.setCookie && r.setCookie.includes(COOKIE_NAME + "=" + FP), `cookie=${r.setCookie}`);
  check("5c. the code is deleted (one-time use)", kv.map.get("linkcode:123456") === undefined);
  const r2 = await callEndpoint(makeEnv(kv), idUrl({ code: "123456" }), { "CF-Connecting-IP": "1.2.3.4" });
  check("5d. second use of the same code -> E_BAD_CODE", r2.status === 400 && r2.body && r2.body.error === "E_BAD_CODE", `body=${r2.text}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ code: "12" }), { "CF-Connecting-IP": "1.2.3.4" });
  check("6. code bad format -> E_BAD_CODE 400", r.status === 400 && r.body && r.body.error === "E_BAD_CODE", `body=${r.text}`);
  const r2 = await callEndpoint(makeEnv(kv), idUrl({ code: "999999" }), { "CF-Connecting-IP": "1.2.3.4" });
  check("6b. code unknown -> E_BAD_CODE 400", r2.status === 400 && r2.body && r2.body.error === "E_BAD_CODE", `body=${r2.text}`);
}

{
  const kv = seededKv();
  let last = null;
  for (let i = 0; i < CODE_ATTEMPT_LIMIT; i++) {
    last = await callEndpoint(makeEnv(kv), idUrl({ code: "999999" }), { "CF-Connecting-IP": "9.9.9.9" });
  }
  check("7. 10 bad code attempts are answered (not rate-limited yet)", last && last.status === 400, `status=${last && last.status}`);
  const blocked = await callEndpoint(makeEnv(kv), idUrl({ code: "999999" }), { "CF-Connecting-IP": "9.9.9.9" });
  check("7b. 11th attempt -> 429 E_TOO_MANY_ATTEMPTS", blocked.status === 429 && blocked.body && blocked.body.error === "E_TOO_MANY_ATTEMPTS", `status=${blocked.status} body=${blocked.text}`);
  const otherIp = await callEndpoint(makeEnv(kv), idUrl({ code: "999999" }), { "CF-Connecting-IP": "8.8.8.8" });
  check("7c. a different IP is not blocked", otherIp.status === 400, `status=${otherIp.status}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl(), { Cookie: COOKIE_NAME + "=" + FP });
  check("8. cookie valid -> linked (no fp param)", r.status === 200 && r.body && r.body.linked === true && r.body.email_masked === "mo***@kindle.com", `body=${r.text}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl(), { Cookie: COOKIE_NAME + "=revokedfp000000000000" });
  check("9. cookie revoked -> linked:false", r.status === 200 && r.body && r.body.linked === false, `body=${r.text}`);
  check("9b. a stale cookie is cleared", !!r.setCookie && r.setCookie.includes("Max-Age=0"), `cookie=${r.setCookie}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl());
  check("10. nothing -> linked:false", r.status === 200 && r.body && r.body.linked === false, `body=${r.text}`);
}

{
  const r = await callEndpoint({}, idUrl({ fp: FP }));
  check("11. missing KV binding -> 503", r.status === 503 && r.body && r.body.ok === false, `status=${r.status}`);
}

{
  const kv = seededKv();
  const r = await callEndpoint(makeEnv(kv), idUrl({ fp: FP }), {}, "POST");
  check("12. POST (not GET) -> 405", r.status === 405, `status=${r.status}`);
}

{
  check("13a. maskEmail keeps first two chars", maskEmail("ab@kindle.com") === "ab***@kindle.com", maskEmail("ab@kindle.com"));
  check("13b. maskEmail hides a 1-char local part", maskEmail("x@kindle.com") === "***@kindle.com", maskEmail("x@kindle.com"));
  check("13c. maskEmail returns null for a bad address", maskEmail("not-an-email") === null);
  check("13d. cookieHeader sets a 1-year HttpOnly cookie", cookieHeader(FP).includes("Max-Age=31536000") && cookieHeader(FP).includes("HttpOnly"));
  check("13e. clearCookieHeader expires the cookie", clearCookieHeader().includes("Max-Age=0"));
  check("13f. parseCookies reads the fp cookie", parseCookies("a=1; " + COOKIE_NAME + "=" + FP + "; b=2")[COOKIE_NAME] === FP);
}

// --- summary -----------------------------------------------------------
console.log(`\nidentify: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
