// Test for the "Get on Kindle" delivery page (functions/kindle/get.js).
// Standalone Node script — run from the repo root:
//   node functions/kindle/get.test.mjs
//
// It imports the real Function module, wraps it in a minimal mock of
// the Pages Function environment (env.RLIBOOK_KV as a Map, env as
// plain vars), and calls onRequest() over HTTP semantics. It asserts:
//   1. an OPDS book renders all 4 numbered steps + the
//      amazon.com/sendtokindle link + a short link (/k/<16 chars>)
//      + the reader link + the email link (unlimited, no daily
//      cap), with cache-control: no-store and NO <script> except the
//      two Mini App loader scripts (Workstream 3b — both defer,
//      inert outside Telegram; the Kindle browser ignores them and
//      the page still works with JS off);
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
//   7. the download cap: the 6th visit from one IP in a day -> 429,
//      naming the 5/day cap and pointing at the unlimited email path.
//   8. NEW (Workstream E, e-reader families): a Kobo/PocketBook UA
//      gets direct-download steps — tap the short link ON the
//      device — with NO amazon.com/sendtokindle link and NO email
//      link (both Kindle-only), a format note from the family
//      table (MOBI native on both; AZW3 native on PocketBook
//      only, conversion note on Kobo); a generic UA gets a
//      labelled try-direct page; a Kindle UA gets the existing
//      page unchanged (same assertions as §1).
//   9. download cap hit: the reader is still offered (reading is
//      free and burns no download quota).
//  10. NEW (Workstream 3b): a hidden Telegram book -> 403 removed
//      page (no title, no steps, no short link, no bot direction);
//      hidden + flagged -> the flagged page (flag first, same
//      precedence as dl-token.js test 7c).
//  12. NEW (round 2, personal books): readerLinkFor with fp+t
//      matching the private feed mints an OWN reader token
//      (payload o:1); the /kindle/get page for a flagged book
//      with fp+t renders 200 (own download mint skips the flag
//      gate), without it 403.
//  11. NEW (Workstream 3b, Mini App hub): the short link carries
//      data-tg-download, the tg-only note + CSS rules are present,
//      and the two Mini App loader scripts are the only scripts.
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. The signing key below is FAKE test data.

import { onRequest, bookQuery, SENDTOKINDLE_WEB_FORMATS, readerLinkFor, READER_FORMATS } from "./get.js";
import { resolveShortLink, readerTokenOwn } from "../api/dl-token.js";

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

async function call(params, env, ip = "1.2.3.4", ua = null) {
  const url = "https://rlibook.tech/kindle/get?" + new URLSearchParams(params).toString();
  const headers = { "cf-connecting-ip": ip };
  if (ua) headers["user-agent"] = ua;
  const res = await onRequest({
    request: new Request(url, { method: "GET", headers }),
    env,
  });
  return { status: res.status, body: await res.text(), cache: res.headers.get("cache-control") };
}


function rtokIn(body) {
  const m = /rtok=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(body || "");
  return m ? m[1] : null;
}

function shortCodeIn(body) {
  const m = /\/k\/([A-Za-z0-9]{16})/.exec(body);
  return m ? m[1] : null;
}

// The ONLY scripts the page may carry: the two Mini App loaders
// (Workstream 3b), both defer, both inert outside Telegram. The
// old "NO <script> anywhere" rule is now "no script except these
// two" — the Kindle browser ignores deferred external scripts and
// the page still works with JS off.
function onlyMiniAppScripts(body) {
  const lower = body.toLowerCase();
  const count = (lower.match(/<script/g) || []).length;
  return count === 2
    && body.includes("https://telegram.org/js/telegram-web-app.js")
    && body.includes("/site/assets/telegram-webapp.js");
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
  check("1f 10-minute single-use note present",
    r.body.includes("10 دقائق") && r.body.includes("مرة واحدة فقط") && r.body.includes("لكتاب واحد"));
  check("1g honest note: the Kindle browser cannot download EPUBs",
    r.body.includes("متصفح Kindle لا ينزّل ملفات EPUB"));
  check("1g2 non-Kindle note: after step 2 the file is yours (WS-I 2026-11-16)",
    r.body.includes("ليس لديك Kindle؟") && r.body.includes("ولا حاجة للخطوتين 3 و 4"));
  check("1h reader link present (EPUB -> /read, token-gated)",
    r.body.includes("/read?lib=hindawi") && r.body.includes("اقرأ الآن في المتصفح")
    && r.body.includes("rtok=v1."));
  check("1i email link present, stating email is unlimited (no daily cap)",
    r.body.includes("/api/send-to-kindle?lib=hindawi")
    && r.body.includes("أرسله بالإيميل — بلا حد يومي (لمن أضاف المرسل من قبل)")
    && !r.body.includes("أرسل إلى جهازي"));
  check("1j book title shown", r.body.includes("Test Book"));
  check("1k cache-control: no-store", r.cache === "no-store", r.cache);
  check("1l only the two Mini App loader scripts (defer, inert outside Telegram)",
    onlyMiniAppScripts(r.body), r.body.slice(0, 400));
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
    && r.body.includes("rtok=v1.")
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
  // Owner-hide (Workstream 2b): no download, no steps, no short link,
  // and no bot direction — a hidden book is not in the bot either.
  const kv = makeKv({ "hidden:kotobkhana:7559": "owner" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Hidden" }, env, "10.1.0.33");
  check("3a2 hidden book -> 403", r.status === 403, "status " + r.status);
  check("3a2 hidden page: removed wording, no steps, no short link, no bot link",
    r.body.includes("أزاله المالك") && !r.body.includes("الخطوة 1")
    && !r.body.includes("RliBook_bot") && shortCodeIn(r.body) === null);
  check("3a2 hidden mint wrote no short link",
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
  check("4a MOBI book: no reader link (reader opens EPUB/PDF/TXT only)",
    !r.body.includes("/read?lib=tg"));
  check("4a MOBI book: no email link (email refuses MOBI)",
    !r.body.includes("/api/send-to-kindle?lib=tg"));
  check("4b SENDTOKINDLE_WEB_FORMATS is epub/pdf/doc/docx/txt",
    ["epub", "pdf", "doc", "docx", "txt"].every((f) => SENDTOKINDLE_WEB_FORMATS.has(f))
    && !SENDTOKINDLE_WEB_FORMATS.has("mobi") && !SENDTOKINDLE_WEB_FORMATS.has("azw3"));
  const pdf = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "pdf", t: "PDF Book" }, env, "10.1.0.9");
  check("4c PDF book: reader link present (token-gated)",
    pdf.status === 200 && pdf.body.includes("/read?lib=tg") && pdf.body.includes("rtok=v1."),
    "status " + pdf.status);
  check("4c readerLinkFor unit: epub/pdf/txt -> link, mobi -> empty, no key -> empty",
    (await readerLinkFor(env, { kind: "opds", lib: "hindawi", id: "1", fmt: "pdf" })).includes("/read?lib=hindawi")
    && (await readerLinkFor(env, { kind: "opds", lib: "hindawi", id: "1", fmt: "txt" })).includes("rtok=v1.")
    && (await readerLinkFor(env, { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "mobi" })) === ""
    && (await readerLinkFor({ RLIBOOK_KV: makeKv() }, { kind: "opds", lib: "hindawi", id: "1", fmt: "epub" })) === "");
  check("4c READER_FORMATS is epub/pdf/txt",
    ["epub", "pdf", "txt"].every((f) => READER_FORMATS.has(f)) && !READER_FORMATS.has("mobi"));
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

// ================= 6. download cap (5/day) ===========================
console.log("6. Download cap (5/day):");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Cap Book" }, env, "10.1.0.9");
    statuses.push(r.status);
  }
  check("6a 5 visits mint, 6th -> 429",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 200, 200, 429]),
    JSON.stringify(statuses));
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Cap Book" }, env, "10.1.0.9");
  check("6b 429 page names the 5/day cap and points at the unlimited email path",
    r.status === 429 && r.body.includes("5 كتب في اليوم") && r.body.includes("بلا حد يومي"),
    r.body.slice(0, 200));
}

// ================= 7. per-family delivery (Workstream E) ==============
console.log("7. Per-family delivery:");
{
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const POCKETBOOK_UA = "Mozilla/5.0 (Linux like Android; en_US) AppleWebKit/534.34 PocketBook/515 (screen 600x800; FW W515.4.4.540) Mobile";
  const GENERIC_UA = "eReader/2.0 (compatible)";
  const EBRD_UA = "Mozilla/5.0 EBRD/1.0";
  const KINDLE_UA = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+";
  const env = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };

  const kobo = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Kobo Book" }, env, "10.2.0.1", KOBO_UA);
  check("7a Kobo EPUB: 200, 3 direct steps (no step 4)",
    kobo.status === 200 && kobo.body.includes("الخطوة 1") && kobo.body.includes("الخطوة 2")
    && kobo.body.includes("الخطوة 3") && !kobo.body.includes("الخطوة 4"),
    "status " + kobo.status);
  check("7a Kobo EPUB: direct-download note (tap the link ON the device)",
    kobo.body.includes("متصفح جهاز Kobo ينزّل الكتاب مباشرة"));
  check("7a Kobo EPUB: NO amazon.com/sendtokindle link (Kindle-only)",
    !kobo.body.includes("amazon.com/sendtokindle"));
  check("7a Kobo EPUB: NO email link (Kobo has no email service)",
    !kobo.body.includes("/api/send-to-kindle"));
  check("7a Kobo EPUB: short link present + 10-minute note + reader link + no-store + only Mini App scripts",
    shortCodeIn(kobo.body) !== null && kobo.body.includes("10 دقائق")
    && kobo.body.includes("/read?lib=hindawi") && kobo.cache === "no-store"
    && onlyMiniAppScripts(kobo.body));
  check("7a Kobo EPUB: format note says EPUB opens directly on Kobo",
    kobo.body.includes("يفتحها جهاز Kobo مباشرة"));

  const pb = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "PB Book" }, env, "10.2.0.2", POCKETBOOK_UA);
  check("7b PocketBook EPUB: 200, direct steps, no sendtokindle, no email",
    pb.status === 200 && pb.body.includes("متصفح جهاز PocketBook ينزّل الكتاب مباشرة")
    && !pb.body.includes("amazon.com/sendtokindle") && !pb.body.includes("/api/send-to-kindle"),
    "status " + pb.status);
  check("7b PocketBook EPUB: short link present, format note direct",
    shortCodeIn(pb.body) !== null && pb.body.includes("يفتحها جهاز PocketBook مباشرة"));

  const gen = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Generic Book" }, env, "10.2.0.3", GENERIC_UA);
  check("7c generic (eReader) EPUB: 200, labelled unverified, no sendtokindle, no email",
    gen.status === 200 && gen.body.includes("لم نتحقق من جهازك تحديدًا")
    && !gen.body.includes("amazon.com/sendtokindle") && !gen.body.includes("/api/send-to-kindle"),
    "status " + gen.status);
  const ebrd = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Generic Book Two" }, env, "10.2.0.4", EBRD_UA);
  check("7c EBRD UA: generic flow, page never prints 'EBRD'",
    ebrd.status === 200 && ebrd.body.includes("لم نتحقق من جهازك تحديدًا")
    && !ebrd.body.includes("EBRD"), "status " + ebrd.status);

  const kindle = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Kindle Book" }, env, "10.2.0.5", KINDLE_UA);
  check("7d Kindle UA: existing page unchanged (4 steps + sendtokindle + email)",
    kindle.status === 200 && kindle.body.includes("الخطوة 4")
    && kindle.body.includes("https://www.amazon.com/sendtokindle")
    && kindle.body.includes("/api/send-to-kindle?lib=hindawi"),
    "status " + kindle.status);

  const mobiKobo = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "mobi", t: "Mobi Kobo" }, env, "10.2.0.6", KOBO_UA);
  check("7e MOBI + Kobo: 200, direct (MOBI is native on Kobo), no sendtokindle link",
    mobiKobo.status === 200 && mobiKobo.body.includes("يفتحها جهاز Kobo مباشرة")
    && !mobiKobo.body.includes("amazon.com/sendtokindle"), "status " + mobiKobo.status);
  const azw3Kobo = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "azw3", t: "Azw3 Kobo" }, env, "10.2.0.7", KOBO_UA);
  check("7f AZW3 + Kobo: qualified note (may NOT open directly) + Calibre/USB, never an unqualified direct-open claim",
    azw3Kobo.status === 200 && azw3Kobo.body.includes("قد لا يفتحها جهاز Kobo مباشرة")
    && azw3Kobo.body.includes("Calibre")
    && !azw3Kobo.body.includes(") يفتحها جهاز Kobo مباشرة"), "status " + azw3Kobo.status);
  const azw3Pb = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "azw3", t: "Azw3 PB" }, env, "10.2.0.8", POCKETBOOK_UA);
  check("7f AZW3 + PocketBook: direct (AZW3 is native on PocketBook)",
    azw3Pb.status === 200 && azw3Pb.body.includes("يفتحها جهاز PocketBook مباشرة"),
    "status " + azw3Pb.status);
}

// ================= 8. download cap hit: reading still offered ========
console.log("8. Download cap hit:");
{
  const today = new Date().toISOString().slice(0, 10);
  const kv = makeKv({ ["dlt:ip:10.9.9.9:" + today]: "5" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Capped Book" }, env, "10.9.9.9");
  check("8a IP at the 5/day mint cap -> 429",
    r.status === 429 && r.body.includes("جرّب مجدداً غداً"), "status " + r.status);
  check("8b 429 page still offers the reader (reading is free, no quota)",
    r.body.includes("/read?lib=hindawi") && r.body.includes("rtok=v1.")
    && r.body.includes("لا تُحسب من حد التنزيل"));
}

// ================= 9. hidden book -> 403 removed page ================
console.log("9. Hidden book:");
{
  const kv = makeKv({ "hidden:kotobkhana:7559": "manual:999:1" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Hidden" }, env, "10.3.0.1");
  check("9a hidden book -> 403 removed page",
    r.status === 403 && r.body.includes("أزاله المالك"), "status " + r.status);
  check("9b hidden page: no title, no steps, no short link, no bot direction",
    !r.body.includes("Hidden") && !r.body.includes("الخطوة 1")
    && shortCodeIn(r.body) === null && !r.body.includes("RliBook_bot"),
    r.body.slice(0, 300));
  check("9c hidden mint wrote no short link",
    ![...kv.map.keys()].some((k) => k.startsWith("k:")), [...kv.map.keys()].join(","));
  // Both keys: the flagged page wins (flag first — same precedence
  // as dl-token.js test 7c; the sibling flag/hide revision owns it).
  const kvBoth = makeKv({ "hidden:kotobkhana:7559": "manual:999:1", "flag:kotobkhana:7559": "1" });
  const envBoth = { RLIBOOK_KV: kvBoth, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const rBoth = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Both" }, envBoth, "10.3.0.2");
  check("9d hidden + flagged -> flagged page (flag first)",
    rBoth.status === 403 && rBoth.body.includes("هذا الكتاب تجاري (عليه علامة)"), "status " + rBoth.status);
}

// ================= 10. Mini App hub hooks ============================
console.log("10. Mini App hub:");
{
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Test Book" }, env, "10.4.0.1");
  check("10a short link carries data-tg-download (Mini App intercepts it)",
    r.body.includes("data-tg-download"), r.body.slice(0, 600));
  check("10b tg-only note present (hidden outside Telegram, shown in the Mini App)",
    r.body.includes("note tg-only") && r.body.includes("في تيليجرام: اضغط الرابط وسيُفتح في متصفح جهازك"),
    r.body.slice(0, 900));
  check("10c tg-only CSS rules present (hidden by default, shown under html.tg-webapp)",
    r.body.includes(".tg-only{display:none}") && r.body.includes("html.tg-webapp .tg-only{display:block}"));
  check("10d both Mini App loader scripts present, defer, telegram-web-app.js first",
    r.body.indexOf("https://telegram.org/js/telegram-web-app.js") !== -1
    && r.body.indexOf("https://telegram.org/js/telegram-web-app.js") < r.body.indexOf("/site/assets/telegram-webapp.js")
    && (r.body.match(/defer/g) || []).length >= 2);
  const kobo = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Kobo Book" }, env, "10.4.0.2", "Kobo Touch 0390/4.45.23684");
  check("10e Kobo page also carries data-tg-download",
    kobo.status === 200 && kobo.body.includes("data-tg-download"), "status " + kobo.status);
  const kvH = makeKv({ "hidden:kotobkhana:7559": "manual:999:1" });
  const envH = { RLIBOOK_KV: kvH, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const hid = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub", t: "Hidden" }, envH, "10.4.0.3");
  check("10f hidden page carries no data-tg-download (no short link to intercept)",
    hid.status === 403 && !hid.body.includes("data-tg-download"), "status " + hid.status);
}

// ================= 11. Kindle PDF path + honest caveat + dual paths =
console.log("11. Kindle PDF path + honest caveat + dual paths (round 2):");
{
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const POCKETBOOK_UA = "Mozilla/5.0 (Linux like Android; en_US) AppleWebKit/534.34 PocketBook/515 (screen 600x800; FW W515.4.4.540) Mobile";
  const KINDLE_UA = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+";
  const env = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };

  const pdf = await call({ lib: "hindawi", id: "13028368", f: "pdf", t: "Kindle PDF" }, env, "10.5.0.1", KINDLE_UA);
  check("11a Kindle PDF: 200, direct-download steps ON the Kindle (tap the link here)",
    pdf.status === 200 && pdf.body.includes("اضغط هذا الرابط هنا على جهاز Kindle")
    && pdf.body.includes("سينزّل ملف PDF ويظهر في مكتبتك"), "status " + pdf.status);
  check("11b Kindle PDF: device-test flag present (NOT confirmed on a real device)",
    pdf.body.includes("لم نتحقق منها على جهاز Kindle حقيقي بعد"));
  check("11c Kindle PDF: no step 4 (3 steps), email + sendtokindle alternatives kept",
    !pdf.body.includes("الخطوة 4") && pdf.body.includes("/api/send-to-kindle")
    && pdf.body.includes("amazon.com/sendtokindle"), "status " + pdf.status);

  const epub = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Kindle EPUB" }, env, "10.5.0.2", KINDLE_UA);
  check("11d Kindle EPUB: HONEST CAVEAT present (no EPUB into the library without email or phone/computer)",
    epub.body.includes("لا توجد طريقة لإدخال ملف EPUB إلى مكتبة Kindle مباشرة دون إيميل"));
  check("11e Kindle EPUB: 4 steps kept + USB named as a third way",
    epub.body.includes("الخطوة 4") && epub.body.includes("طريقة ثالثة")
    && epub.body.includes("USB"), "status " + epub.status);

  const kobo = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "Kobo Dual" }, env, "10.5.0.3", KOBO_UA);
  check("11f Kobo: second way (Mini App) named explicitly",
    kobo.body.includes("طريقة ثانية") && kobo.body.includes("تيليجرام"));
  check("11g Kobo: still 3 steps, no step 4, no sendtokindle, no email link",
    kobo.body.includes("الخطوة 3") && !kobo.body.includes("الخطوة 4")
    && !kobo.body.includes("amazon.com/sendtokindle") && !kobo.body.includes("/api/send-to-kindle"));

  const pb = await call({ lib: "hindawi", id: "13028368", f: "epub", t: "PB Dual" }, env, "10.5.0.4", POCKETBOOK_UA);
  check("11h PocketBook: second way (Send-to-PocketBook email, pbsync) named",
    pb.body.includes("طريقة ثانية") && pb.body.includes("pbsync.com"));
  check("11i PocketBook: third way (Cloud / Dropbox / USB) named, still no endpoint link",
    pb.body.includes("طريقة ثالثة") && pb.body.includes("PocketBook Cloud")
    && pb.body.includes("Dropbox") && !pb.body.includes("/api/send-to-kindle"));
}

// ================= 12. Personal books (own) ==========================
console.log("12. Personal books (own reader link + own download):");
{
  const kv = makeKv({
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const book = { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" };
  const ownLink = await readerLinkFor(env, book, { fp: "abc123", title: "My Book" });
  const ownTok = rtokIn(ownLink);
  check("12a readerLinkFor own (fp+title match) -> rtok is own",
    ownTok !== null && (await readerTokenOwn(KEY, ownTok)) === true, ownLink.slice(0, 200));
  const libLink = await readerLinkFor(env, book, { fp: "abc123", title: "Not Mine" });
  const libTok = rtokIn(libLink);
  check("12b readerLinkFor fp + wrong title -> library token (not own)",
    libTok !== null && (await readerTokenOwn(KEY, libTok)) === false);
  const noFpLink = await readerLinkFor(env, book);
  const noFpTok = rtokIn(noFpLink);
  check("12b2 readerLinkFor without fp -> library token (not own)",
    noFpTok !== null && (await readerTokenOwn(KEY, noFpTok)) === false);
}
{
  // Full page: a flagged TG book renders 200 when fp+t prove it
  // is the caller's own upload; the reader link on it is own.
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY, PROXY_BASE_URL: PROXY };
  const own = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    t: "My Book", fp: "abc123" }, env, "10.1.0.21");
  check("12c /kindle/get flagged book + fp+t (own) -> 200",
    own.status === 200, "status " + own.status);
  const pageTok = rtokIn(own.body);
  check("12c2 the page's reader link carries an own token",
    pageTok !== null && (await readerTokenOwn(KEY, pageTok)) === true);
  const wrong = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    t: "Not Mine", fp: "abc123" }, env, "10.1.0.22");
  check("12d /kindle/get flagged book + fp + wrong title -> 403 flagged",
    wrong.status === 403, "status " + wrong.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
