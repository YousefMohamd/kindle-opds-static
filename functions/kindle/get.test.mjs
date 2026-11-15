// Test for the "Get on Kindle" delivery page (functions/kindle/get.js).
// Standalone Node script — run from the repo root:
//   node functions/kindle/get.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock of
// the Pages Function environment (env.RLIBOOK_KV as a Map, env as
// plain vars), and calls onRequest() over HTTP semantics. It asserts:
//   1. an OPDS book renders all 4 numbered steps + the
//      amazon.com/sendtokindle link + a short link (/k/<16 chars>)
//      + the reader link + the email fallback link, with
//      cache-control: no-store and NO <script> anywhere (the Kindle
//      browser is ES5-level; the page must work with JS off);
//   2. a Telegram book renders the same shape, and the short link
//      resolves to the signed proxy URL;
//   3. a flagged Telegram book -> 403 with no token minted (no
//      short-link entry appears in KV);
//   4. proxy/signing key unconfigured -> honest 503, never a dead
//      button;
//   5. a bad book identity -> 400; a MOBI book shows the USB note
//      instead of the Send-to-Kindle-Web link;
//   6. without a KV binding the page still works and shows the
//      target URL itself (no short link).
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. The signing key below is FAKE test data.

import { onRequest, bookQuery, SENDTOKINDLE_WEB_FORMATS } from "./get.js";
import { resolveShortLink } from "../api/dl-token.js";

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

async function call(params, env, ip = "1.2.3.4") {
  const url = "https://rlibook.tech/kindle/get?" + new URLSearchParams(params).toString();
  const res = await onRequest({
    request: new Request(url, { method: "GET", headers: { "cf-connecting-ip": ip } }),
    env,
  });
  return { status: res.status, body: await res.text(), cache: res.headers.get("cache-control") };
}

function shortCodeIn(body) {
  const m = /\/k\/([A-Za-z0-9]{16})/.exec(body);
  return m ? m[1] : null;
}

// ================= 1. OPDS delivery page =============================
console.log("1. OPDS delivery page:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Test Book" }, env, "10.1.0.1");
  check("1a 200", r.status === 200, "status " + r.status);
  check("1b all 4 steps present",
    r.body.includes("الخطوة 1") && r.body.includes("الخطوة 2")
    && r.body.includes("الخطوة 3") && r.body.includes("الخطوة 4"),
    r.body.slice(0, 300));
  check("1c amazon.com/sendtokindle link present",
    r.body.includes("https://www.amazon.com/sendtokindle"));
  check("1d short link present (/k/<16 chars>)",
    shortCodeIn(r.body) !== null, r.body.slice(0, 600));
  check("1e short link resolves to the Hindawi acquisition URL",
    (await resolveShortLink(env, shortCodeIn(r.body)))?.url
      === "https://www.hindawi.org/books/13028368.epub");
  check("1f 10-minute note present",
    r.body.includes("10 دقائق") && r.body.includes("لكتاب واحد فقط"));
  check("1g honest note: the Kindle browser cannot download EPUBs",
    r.body.includes("متصفح Kindle لا ينزّل ملفات EPUB"));
  check("1h reader link present (EPUB -> /read)",
    r.body.includes("/read?lib=hindawi") && r.body.includes("اقرأ الآن في المتصفح"));
  check("1i email fallback link present (secondary, not a button)",
    r.body.includes("/api/send-to-kindle?lib=hindawi")
    && r.body.includes("أرسله بالإيميل (لمن أضاف المرسل من قبل)")
    && !r.body.includes("أرسل إلى جهازي"));
  check("1j book title shown", r.body.includes("Test Book"));
  check("1k cache-control: no-store", r.cache === "no-store", r.cache);
  check("1l NO <script> anywhere (Kindle-safe, JS off)",
    !r.body.toLowerCase().includes("<script"));
  check("1m no bare acquisition URL published on the page",
    !r.body.includes("https://www.hindawi.org/books/13028368.epub"));
}

// ================= 2. Telegram delivery page =========================
console.log("2. Telegram delivery page:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "TG Book" }, env, "10.1.0.2");
  check("2a 200", r.status === 200, "status " + r.status);
  check("2b short link resolves to the signed proxy URL",
    ((await resolveShortLink(env, shortCodeIn(r.body)))?.url || "").startsWith(PROXY + "/dl?h=kotobkhana&p=7559&f=epub&t=v1."));
  check("2c reader + email links use the Telegram identity",
    r.body.includes("/read?lib=tg") && r.body.includes("h=kotobkhana")
    && r.body.includes("/api/send-to-kindle?lib=tg"));
  check("2d bookQuery unit (OPDS + Telegram)",
    bookQuery({ kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" })
      === "lib=hindawi&amp;id=13028368&amp;f=epub"
    && bookQuery({ kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" })
      === "lib=tg&amp;h=kotobkhana&amp;p=7559&amp;f=epub");
}

// ================= 3. flagged / bad / unconfigured ===================
console.log("3. Flagged / bad / unconfigured:");
{
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Flagged" }, env, "10.1.0.3");
  check("3a flagged book -> 403", r.status === 403, "status " + r.status);
  check("3a flagged page points at the bot, no steps, no short link",
    r.body.includes("@RliBook_bot") && !r.body.includes("الخطوة 1")
    && shortCodeIn(r.body) === null);
  check("3a flagged mint wrote no short link",
    ![...kv.map.keys()].some((k) => k.startsWith("k:")), [...kv.map.keys()].join(","));
}
{
  const env = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const bad = await call({ lib: "nope", id: "1234567890", f: "epub" }, env, "10.1.0.4");
  check("3b bad lib -> 400", bad.status === 400, "status " + bad.status);
  const noKey = await call({ lib: "hindawi", id: "13028368", f: "epub" },
    { RLIBOOK_KV: makeKv(), PROXY_BASE_URL: PROXY }, "10.1.0.5");
  check("3c signing key unset -> honest 503, no dead button",
    noKey.status === 503 && noKey.body.includes("غير مهيأة"), "status " + noKey.status);
  const noProxy = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" },
    { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY }, "10.1.0.6");
  check("3d proxy unset -> Telegram delivery is 503 (OPDS unaffected)",
    noProxy.status === 503, "status " + noProxy.status);
}

// ================= 4. format-dependent steps =========================
console.log("4. Format-dependent steps:");
{
  const env = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "mobi", t: "Mobi Book" }, env, "10.1.0.7");
  check("4a MOBI book: 200, USB note instead of the Send-to-Kindle-Web link",
    r.status === 200 && r.body.includes("USB") && !r.body.includes("amazon.com/sendtokindle"),
    "status " + r.status);
  check("4a MOBI book: no reader link (reader opens EPUB only)",
    !r.body.includes("/read?lib=tg"));
  check("4a MOBI book: no email link (email refuses MOBI)",
    !r.body.includes("/api/send-to-kindle?lib=tg"));
  check("4b SENDTOKINDLE_WEB_FORMATS is epub/pdf/doc/docx/txt",
    ["epub", "pdf", "doc", "docx", "txt"].every((f) => SENDTOKINDLE_WEB_FORMATS.has(f))
    && !SENDTOKINDLE_WEB_FORMATS.has("mobi") && !SENDTOKINDLE_WEB_FORMATS.has("azw3"));
}

// ================= 5. no-KV fallback =================================
console.log("5. No-KV fallback:");
{
  const env = { PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "No KV Book" }, env, "10.1.0.8");
  check("5a no KV: page still renders 200 with the steps",
    r.status === 200 && r.body.includes("الخطوة 1") && r.body.includes("الخطوة 4"),
    "status " + r.status);
  check("5a no KV: no short link, the target URL itself is shown instead",
    shortCodeIn(r.body) === null
    && r.body.includes("https://www.hindawi.org/books/13028368.epub"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
