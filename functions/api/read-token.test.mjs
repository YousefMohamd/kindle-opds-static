// Test for the reader-token issuer (functions/api/read-token.js).
// Standalone Node script — run from the repo root:
//   node functions/api/read-token.test.mjs
//
// It imports the real Function module and calls onRequest() over
// HTTP semantics. It asserts:
//   1. an OPDS book mints a token whose url is a /read link carrying
//      that token, with ttl 3600, and the token verifies for the
//      book (via verifyReaderToken) but not for another book;
//   2. a Telegram book mints the same shape;
//   3. a flagged Telegram book -> 403, no token;
//   4. a bad book identity -> 400; no signing key -> 503;
//      POST -> 405.
//   5. personal books + renewal (2026-11-16): fp+t proves own
//      (flag gate skipped, hide still wins); rtok renews a token
//      for the same book — an own token renews as own, a library
//      token goes through the flag/hide gates again.
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. The signing key below is FAKE test data.

import { onRequest } from "./read-token.js";
import { verifyReaderToken, readerTokenOwn, makeReaderToken, READER_TOKEN_TTL_SECONDS } from "./dl-token.js";

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

async function call(params, env, method = "GET") {
  const url = "https://rlibook.tech/api/read-token?" + new URLSearchParams(params).toString();
  const res = await onRequest({
    request: new Request(url, { method }),
    env,
  });
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; }
  return { status: res.status, body };
}

const ENV = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY };

console.log("1. OPDS mint:");
{
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub" }, ENV);
  check("1a 200, ok, ttl 3600",
    r.status === 200 && r.body && r.body.ok === true && r.body.ttl === 3600,
    "status " + r.status + " " + JSON.stringify(r.body));
  check("1b url is a /read link carrying the token",
    typeof r.body.url === "string"
    && r.body.url.startsWith("/read?lib=hindawi&id=13028368&f=epub&rtok=v1.")
    && r.body.url.includes(encodeURIComponent(r.body.token).slice(0, 12)),
    r.body.url);
  check("1c the minted token verifies for this book",
    await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" }));
  check("1d the minted token does NOT verify for another book",
    !(await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "hindawi", id: "99999999", fmt: "epub" })));
  check("1e exp is about now + 3600",
    Math.abs(r.body.exp - (Math.floor(Date.now() / 1000) + 3600)) <= 5,
    "exp " + r.body.exp);
}

console.log("2. Telegram mint:");
{
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "pdf" }, ENV);
  check("2a 200, url carries lib=tg + h + p + f=pdf + rtok",
    r.status === 200 && r.body && r.body.ok === true
    && typeof r.body.url === "string"
    && r.body.url.startsWith("/read?lib=tg&h=kotobkhana&p=7559&f=pdf&rtok=v1."),
    "status " + r.status + " " + JSON.stringify(r.body && r.body.url));
  check("2b the minted token verifies for this Telegram book",
    await verifyReaderToken(KEY, r.body.token,
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "pdf" }));
}

console.log("3. Refusals:");
{
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const flagged = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, env);
  check("3a flagged Telegram book -> 403, no token",
    flagged.status === 403 && flagged.body && flagged.body.error === "flagged",
    "status " + flagged.status);
  // Owner-hide (Workstream 2b): no reader token either; flag first
  // when both keys are present.
  const kvHidden = makeKv({ "hidden:kotobkhana:7559": "owner" });
  const envHidden = { RLIBOOK_KV: kvHidden, PROXY_SIGNING_KEY: KEY };
  const hidden = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, envHidden);
  check("3f hidden Telegram book -> 403 hidden, no token",
    hidden.status === 403 && hidden.body && hidden.body.error === "hidden",
    "status " + hidden.status);
  const kvBoth = makeKv({ "flag:kotobkhana:7559": "1", "hidden:kotobkhana:7559": "owner" });
  const envBoth = { RLIBOOK_KV: kvBoth, PROXY_SIGNING_KEY: KEY };
  const both = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, envBoth);
  check("3g flagged + hidden -> 403 flagged (flag gate first)",
    both.status === 403 && both.body && both.body.error === "flagged",
    "status " + both.status);
  const bad = await call({ lib: "nope", id: "1234567890", f: "epub" }, ENV);
  check("3b bad lib -> 400", bad.status === 400 && bad.body && bad.body.error === "bad_lib",
    "status " + bad.status);
  const noKey = await call({ lib: "hindawi", id: "13028368", f: "epub" },
    { RLIBOOK_KV: makeKv() });
  check("3c signing key unset -> 503 not_configured",
    noKey.status === 503 && noKey.body && noKey.body.error === "not_configured",
    "status " + noKey.status);
  const post = await call({ lib: "hindawi", id: "13028368", f: "epub" }, ENV, "POST");
  check("3d POST -> 405", post.status === 405, "status " + post.status);
  const noKv = await call({ lib: "hindawi", id: "13028368", f: "epub" },
    { PROXY_SIGNING_KEY: KEY });
  check("3e no KV binding -> still mints (flag check passes open)",
    noKv.status === 200 && noKv.body && noKv.body.ok === true,
    "status " + noKv.status);
}

// ================= 5. Personal books + renewal ======================
console.log("5. Personal books + renewal:");
{
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const own = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "My Book" }, env);
  check("5a own via fp+t on a flagged book -> 200",
    own.status === 200 && own.body && own.body.ok === true, "status " + own.status);
  check("5a2 the minted token is own (readerTokenOwn -> true)",
    own.body && own.body.token && (await readerTokenOwn(KEY, own.body.token)) === true);
  const wrong = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "Not Mine" }, env);
  check("5c fp + wrong title on a flagged book -> 403 flagged",
    wrong.status === 403 && wrong.body && wrong.body.error === "flagged",
    "status " + wrong.status);
}
{
  const kv = makeKv({
    "hidden:kotobkhana:7559": "owner",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const hidden = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "My Book" }, env);
  check("5b own via fp+t on a HIDDEN book -> 403 hidden (hide wins)",
    hidden.status === 403 && hidden.body && hidden.body.error === "hidden",
    "status " + hidden.status);
}
{
  // Renewal: mint a library token that is nearly expired (3500 s
  // old, 100 s left), then renew it with rtok — the renewed token
  // must be a FRESH one (different string, full hour ahead).
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const now = Math.floor(Date.now() / 1000);
  const oldTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub",
    READER_TOKEN_TTL_SECONDS, now - 3500);
  check("5d setup: nearly-expired library token still verifies",
    (await verifyReaderToken(KEY, oldTok,
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" })) === true);
  const renewed = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: oldTok }, env);
  check("5d rtok renewal (library, unflagged) -> 200 with a fresh token",
    renewed.status === 200 && renewed.body && renewed.body.ok === true
    && renewed.body.token && renewed.body.token !== oldTok,
    "status " + renewed.status);
  check("5d2 renewed token verifies for the book",
    renewed.body && (await verifyReaderToken(KEY, renewed.body.token,
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" })) === true);
  check("5d3 renewed library token is NOT own",
    renewed.body && (await readerTokenOwn(KEY, renewed.body.token)) === false);
  // Now flag the book: the same library rtok must not renew.
  kv.map.set("flag:kotobkhana:7559", "1");
  const afterFlag = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: oldTok }, env);
  check("5f library rtok renewal after flagging -> 403 flagged",
    afterFlag.status === 403 && afterFlag.body && afterFlag.body.error === "flagged",
    "status " + afterFlag.status);
}
{
  // Own renewal: mint an own token on a flagged book, then renew
  // it with rtok — the flag re-check is skipped for own tokens.
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const first = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "My Book" }, env);
  check("5e setup: own token mints on a flagged book",
    first.status === 200 && first.body && first.body.token, "status " + first.status);
  const renewed = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: first.body.token }, env);
  check("5e own rtok renewal on a flagged book -> 200 (no flag re-check)",
    renewed.status === 200 && renewed.body && renewed.body.ok === true,
    "status " + renewed.status);
  check("5e2 renewed token is still own",
    renewed.body && (await readerTokenOwn(KEY, renewed.body.token)) === true);
  // An rtok minted for ANOTHER book does not renew this one — the
  // gates apply to the requested book as normal.
  const other = await call({ lib: "tg", h: "otherlib", p: "1", f: "epub" }, env);
  const cross = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: other.body.token }, env);
  check("5g rtok from another book does not bypass the flag gate -> 403",
    cross.status === 403 && cross.body && cross.body.error === "flagged",
    "status " + cross.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
