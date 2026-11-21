// Test for the unified-search /book page (functions/book.js).
// Standalone Node script — run from the repo root:
//   node functions/book.test.mjs
//
// It imports the real /book Function, mocks global fetch so the five
// OPDS search-index.json files are served from the real local files
// (real matching, real counts) and /api/tg-search is served by a
// controllable mock (throw / 503 / 500 / malformed / empty / ok with
// canned Telegram results, incl. one flagged + two invalid records).
// No network, no production D1/KV, no deploy. Exit 0 = all pass.
//
// What it asserts:
//   A. OPDS-only mode (tg-search unavailable — D1 not live yet):
//      the page renders EXACTLY like the pre-unified-search /book
//      (byte-identical output was verified separately against the
//      saved original in /tmp/compare-book.mjs; here the key
//      behaviours are pinned: OPDS cards + send button, the no-match
//      page for a Telegram-only title, empty query never calls
//      tg-search).
//   B. Combined mode (mocked tg-search ok): Telegram cards appear
//      alongside OPDS cards, OPDS first, with the SAME send button
//      (lib=tg, via the proxy fetch) and the source as TEXT under the
//      book info (no t.me link anywhere). Flagged books get a 🚩
//      flag, NO send button and NO reading, pointing at the bot.
//      Invalid endpoint records are dropped, "N من total" heading.
//   C. Degradation: every tg-search failure mode still returns
//      HTTP 200 with the OPDS-only page (never a 500, never a
//      broken page); an ok:true empty reply is distinguished from
//      "not searched" by the no-match wording.
//   D. Kindle-friendly: a small combined page stays under 8 KB.

import { readFileSync } from "node:fs";
import { onRequest, fetchTelegramResults, fetchEnrichment, formatFileSize, validatePages, formatBookMeta, ereaderDownloadLabel, otherWaysNote, downloadSection, reportSection, botSendLink, BOT_LINK, REPORT_CRITERIA } from "./book.js";

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

// --- mock fetch ------------------------------------------------------
const idx = {};
for (const s of ["khazendar", "sahwa", "electronic", "hindawi", "doab"]) {
  idx["/" + s + "/search-index.json"] = readFileSync(
    new URL("../" + s + "/search-index.json", import.meta.url),
    "utf8",
  );
}

const TG_OK_RESULTS = [
  {
    title: "Everyone in This Bank Is a Thief",
    author: "Benjamin Stevenson",
    source: "kotobkhana",
    kind: "channel",
    formats: ["EPUB"],
    flagged: false,
    // Gated links, pre-built by /api/tg-search (Workstream H) — the
    // raw t.me post URL is never in an endpoint reply any more.
    get: "/kindle/get?lib=tg&h=kotobkhana&p=7559&f=epub&t=Everyone%20in%20This%20Bank%20Is%20a%20Thief",
    send: "/api/send-to-kindle?lib=tg&h=kotobkhana&p=7559&f=epub&t=Everyone%20in%20This%20Bank%20Is%20a%20Thief",
    read: "/site/reader/?lib=tg&h=kotobkhana&p=7559&f=epub&title=Everyone%20in%20This%20Bank%20Is%20a%20Thief",
    // Embedded cover (Block 4 pairing): tiny 1x1 GIF data URI.
    cover: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    // Post-text description (first description source).
    description: "وصف المنشور: سرقة بنك تتحول إلى لغز.",
  },
  {
    title: "كتاب مُعلَّم تجريبي",
    author: "مؤلف تجريبي",
    source: "darkromancenovels",
    kind: "channel",
    formats: ["PDF"],
    flagged: true,
    get: null,
    send: null,
    read: null,
    // "View in bot" deep link (Workstream 2b) — the bot shows 🚩 +
    // the source link under the 3/day cap, never a download.
    bot: "https://t.me/RliBook_bot?start=dl_darkromancenovels_123_any",
  },
  // Invalid records the page must drop, not render:
  { title: "Bad Link Book", author: "", source: "x", kind: "channel",
    formats: ["EPUB"], flagged: false,
    get: "https://example.com/evil", send: null, read: null },
  { author: "No Title", source: "x", kind: "channel",
    formats: ["EPUB"], flagged: false },
];

// Workstream 3 (metadata): one TG result per combination — both values,
// size only, pages only, neither, and junk values that must be dropped.
// `pages` has no source in the real index today, so these rows stand in
// for a future endpoint that sends one; `size` matches the real shape.
const TG_META_RESULTS = [
  { title: "WS3 Meta Both", author: "Meta Author", source: "kotobkhana",
    kind: "channel", formats: ["EPUB"], url: "https://t.me/kotobkhana/9001",
    flagged: false, size: "2.7 MB", pages: 250 },
  { title: "WS3 Meta Size", author: "Meta Author", source: "kotobkhana",
    kind: "channel", formats: ["PDF"], url: "https://t.me/kotobkhana/9002",
    flagged: false, size: "888.9 KB" },
  { title: "WS3 Meta Pages", author: "Meta Author", source: "kotobkhana",
    kind: "channel", formats: ["EPUB"], url: "https://t.me/kotobkhana/9003",
    flagged: false, pages: 132 },
  { title: "WS3 Meta Neither", author: "Meta Author", source: "kotobkhana",
    kind: "channel", formats: ["EPUB"], url: "https://t.me/kotobkhana/9004",
    flagged: false },
  { title: "WS3 Meta Junk", author: "Meta Author", source: "kotobkhana",
    kind: "channel", formats: ["EPUB"], url: "https://t.me/kotobkhana/9005",
    flagged: false, size: "junk", pages: 0 },
];

// Convert button (2026-11-18 rework): one non-flagged Telegram PDF
// result — the only card that must show the button.
const TG_PDF_RESULTS = [
  {
    title: "كتاب PDF تجريبي",
    author: "مؤلف تجريبي",
    source: "kotobkhana",
    kind: "channel",
    formats: ["PDF"],
    flagged: false,
    get: "/kindle/get?lib=tg&h=kotobkhana&p=9001&f=pdf&t=%D9%83%D8%AA%D8%A7%D8%A8%20PDF%20%D8%AA%D8%AC%D8%B1%D9%8A%D8%A8%D9%8A",
    send: "/api/send-to-kindle?lib=tg&h=kotobkhana&p=9001&f=pdf&t=%D9%83%D8%AA%D8%A7%D8%A8%20PDF%20%D8%AA%D8%AC%D8%B1%D9%8A%D8%A8%D9%8A",
    read: null,
  },
];

let tgMode = "throw"; // throw | 503 | 500 | malformed | empty | ok | okMeta | xss | okPdf
let tgCalls = 0;
let lastTgUrl = "";
// Ratings mock (Blocks 9): "ok" serves a rating+description for the
// first TG title and a description-only reply for the flagged title;
// "fail" throws (endpoint down); "none" returns nulls for everything.
let ratingsMode = "ok";
let ratingsCalls = 0;
const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.pathname === "/api/ratings") {
    ratingsCalls++;
    if (ratingsMode === "fail") throw new Error("ratings down");
    const title = url.searchParams.get("title") || "";
    if (title.includes("Bank Is a Thief")) {
      return jsonRes({ ok: true, title,
        rating: { value: 8.4, count: 12345, source: "Google Books" },
        description: { text: "A bank heist gone wrong, told by the thief.",
          source: "Google Books" } });
    }
    if (title.includes("كتاب مُعلَّم")) {
      return jsonRes({ ok: true, title, rating: null,
        description: { text: "وصف تجريبي من Google Books.",
          source: "Google Books" } });
    }
    return jsonRes({ ok: true, title, rating: null, description: null });
  }
  if (url.pathname === "/api/tg-search") {
    tgCalls++;
    lastTgUrl = u;
    if (tgMode === "throw") throw new Error("fetch failed (tg-search not deployed)");
    if (tgMode === "503") return jsonRes({ ok: false, error: "search unavailable (TG_D1 not bound)" }, 503);
    if (tgMode === "500") return jsonRes({ ok: false, error: "search failed: boom" }, 500);
    if (tgMode === "malformed") return new Response("{not json", { headers: { "content-type": "application/json" } });
    if (tgMode === "empty") return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 0, limit: 10, offset: 0, coverage: { indexed: 149996, target: 323325, partial: true }, results: [] });
    if (tgMode === "emptyFull") return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 0, limit: 10, offset: 0, coverage: { indexed: 323325, target: 323325, partial: false }, results: [] });
    if (tgMode === "okFull") return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 42, limit: 10, offset: 0, coverage: { indexed: 323325, target: 323325, partial: false }, results: TG_OK_RESULTS });
    if (tgMode === "okPdf") return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 1, limit: 10, offset: 0, coverage: { indexed: 323325, target: 323325, partial: false }, results: TG_PDF_RESULTS });
    if (tgMode === "okMeta") return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 5, limit: 10, offset: 0, coverage: { indexed: 323325, target: 323325, partial: false }, results: TG_META_RESULTS });
    if (tgMode === "xss") {
      return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 1, limit: 10, offset: 0, results: [
        { title: "<script>alert(1)</script>", author: "a", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: false, get: null, send: null, read: null },
      ] });
    }
    if (tgMode === "badbot") {
      // Workstream 2b: a flagged record with a tampered bot link is
      // dropped wholesale; a valid deep link passes through; a
      // missing bot field is legitimate (bot: null, card falls back
      // to the bot home link).
      return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 3, limit: 10, offset: 0, results: [
        { title: "Good Bot Link", author: "a", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: true, get: null, send: null, read: null,
          bot: "https://t.me/RliBook_bot?start=dl_testchannel_123_any" },
        { title: "Tampered Bot Link", author: "a", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: true, get: null, send: null, read: null,
          bot: "https://example.com/evil" },
        { title: "No Bot Field", author: "a", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: true, get: null, send: null, read: null },
      ] });
    }
    return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 42, limit: 10, offset: 0, coverage: { indexed: 149996, target: 323325, partial: true }, results: TG_OK_RESULTS });
  }
  if (idx[url.pathname]) {
    return new Response(idx[url.pathname], { headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};

async function getBook(q, extra = "", ua = null) {
  const headers = ua ? { "user-agent": ua } : {};
  const res = await onRequest({
    request: new Request("https://rlibook.tech/book?q=" + encodeURIComponent(q) + extra, { headers }),
    env: {},
  });
  return { status: res.status, body: await res.text(), cache: res.headers.get("cache-control") };
}

// ================= A. OPDS-only mode (tg-search unavailable) ========
console.log("A. OPDS-only mode (tg-search throws):");
tgMode = "throw";

{
  tgCalls = 0;
  const r = await getBook("لؤلؤة الحب");
  check("A1 OPDS title: 200", r.status === 200, "status " + r.status);
  check("A1 OPDS title: card + author", r.body.includes("لؤلؤة الحب") && r.body.includes("هربرت جورج ويلز"));
  check("A1 OPDS title: email is now the PRIMARY button (class btn, /api/send-to-kindle)",
    r.body.includes('class="btn" href="/api/send-to-kindle?lib=hindawi')
    && r.body.includes("أرسل لميل قارئي"));
  check("A1 OPDS title: NO VISIBLE download button without an e-reader UA (WS1b: desktop/no-UA get email + reader only; WS3b: the /kindle/get link is tg-only, hidden outside Telegram)",
    tgOnlyGetLinks(r.body).all === tgOnlyGetLinks(r.body).tgOnly
    && !stripTgOnly(r.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib=hindawi")
    && !r.body.includes("نزّل الكتاب على جهاز")
    && !r.body.includes("جرّب تنزيل الكتاب"));
  check("A1 OPDS title: footer promises email only (no 10-minute download mention)",
    r.body.includes("الإرسال بالإيميل هو الطريقة الأساسية") && !r.body.includes("رابط تنزيل يعمل 10 دقائق"));
  check("A1 OPDS title: NO direct-download link (removed 2026-11-13)",
    !r.body.includes("تنزيل مباشر")
    && !r.body.includes("https://www.hindawi.org/books/13028368.epub")
    && !r.body.includes("drive.google.com/uc?id="));
  check("A1 OPDS title: no Telegram section", !r.body.includes("من تيليجرام"));
  check("A1 OPDS title: count line is 1", r.body.includes("وجدنا 1 نتيجة لـ"));
  check("A1 OPDS title: tg-search was called once (attempted, then degraded)",
    tgCalls === 1, "calls " + tgCalls);
}
{
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("A2 TG-only title: 200, no-match page", r.status === 200 && r.body.includes("لم نجد"));
  check("A2 TG-only title: old wording (five libraries)", r.body.includes("في المكتبات الخمس"));
  check("A2 TG-only title: /telegram/ link kept", r.body.includes('href="/telegram/"'));
  check("A2 TG-only title: no hardcoded Telegram count (323 ألف كتاب dropped)",
    !r.body.includes("323 ألف كتاب"));
  check("A2 TG-only title: no partial-import note (Telegram was NOT searched)",
    !r.body.includes("ما زال يُستورَد"));
  check("A2 TG-only title: no Telegram card rendered", !r.body.includes("kotobkhana"));
  check("A2 TG-only title: no send button", !r.body.includes("/api/send-to-kindle"));
  check("A2 TG-only title: P1-6 says plainly the book is NOT available",
    r.body.includes("غير متاح"));
  check("A2 TG-only title: P1-6 links to the bot",
    r.body.includes("https://t.me/RliBook_bot"));
}
{
  // P1-6 (2026-11-17): a no-match query whose words DO match other
  // books shows RELATED recommendations (same-word titles), each
  // linking to its own /book page.
  const r = await getBook("لؤلؤة غيرموجودة");
  check("A2b no-match + related words: 200, no-match page", r.status === 200 && r.body.includes("لم نجد"));
  check("A2b no-match + related words: says the book is NOT available",
    r.body.includes("غير متاح"));
  check("A2b no-match + related words: related list shown",
    r.body.includes("كتب مشابهة قد تعجبك"));
  check("A2b no-match + related words: same-word book recommended",
    r.body.includes("لؤلؤة الحب"));
  check("A2b no-match + related words: recommendation links to its book page",
    r.body.includes("/book?q=" + encodeURIComponent("لؤلؤة الحب")));
  check("A2b no-match + related words: bot link present",
    r.body.includes("https://t.me/RliBook_bot"));
}
{
  tgCalls = 0;
  const r = await getBook("");
  check("A3 empty query: 200 + five-libraries text",
    r.status === 200 && r.body.includes("ابحث في المكتبات الخمس"));
  check("A3 empty query: no hardcoded Telegram count (323 ألف كتاب dropped)",
    !r.body.includes("323 ألف كتاب"));
  check("A3 empty query: tg-search never called", tgCalls === 0, "calls " + tgCalls);
}
{
  const r = await getBook("الحب");
  check("A4 many OPDS hits: 200, capped at 100", r.status === 200 && r.body.includes("وجدنا 100 نتيجة لـ"));
  check("A4 many OPDS hits: no Telegram section", !r.body.includes("من تيليجرام"));
}

// ============ B. Combined mode (mocked tg-search ok) ================
console.log("B. Combined mode (tg-search ok):");
tgMode = "ok";

{
  tgCalls = 0;
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B1 TG-only title: 200, no longer the no-match page",
    r.status === 200 && !r.body.includes("لم نجد"));
  check("B1 TG-only title: Telegram card (title/author/format, no source line)",
    r.body.includes("Everyone in This Bank Is a Thief")
    && r.body.includes("Benjamin Stevenson")
    && r.body.includes("EPUB")
    && !r.body.includes("المصدر:"));
  check("B1 TG-only title: section heading with total",
    r.body.includes("من تيليجرام (2 من 42)"));
  check("B1 TG-only title: no source line, no t.me post link anywhere (source-hiding 2026-11-21)",
    !r.body.includes("المصدر:") && !r.body.includes("https://t.me/kotobkhana/7559"));
  check("B1 TG-only title: email is the PRIMARY button (class btn, bot send_ deep link)",
    r.body.includes('class="btn" href="https://t.me/RliBook_bot?start=send_kotobkhana_7559"')
    && r.body.includes("أرسل لميل قارئي"));
  check("B1 TG-only title: NO VISIBLE Get-on-Kindle button without an e-reader UA (WS1b; WS3b: the link is tg-only, hidden outside Telegram)",
    tgOnlyGetLinks(r.body).all === tgOnlyGetLinks(r.body).tgOnly
    && !stripTgOnly(r.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib=tg")
    && !r.body.includes("نزّل الكتاب على جهاز")
    && !r.body.includes("جرّب تنزيل الكتاب"));
  check("B1 TG-only title: no decorative emoji on the page (2026-11-21 — only 🚩 survives)",
    !r.body.includes("📥") && !r.body.includes("📖") && !r.body.includes("🔄")
    && r.body.includes("اقرأ أونلاين"));
  check("B1 TG-only title: Read online button present (EPUB -> /site/reader/?lib=tg)",
    r.body.includes("/site/reader/?lib=tg")
    && r.body.includes("h=kotobkhana") && r.body.includes("p=7559")
    && r.body.includes("اقرأ أونلاين"));
  check("B1 TG-only title: email button comes first among VISIBLE buttons, then Read online (the Download section is tg-only, hidden outside Telegram)",
    r.body.indexOf("أرسل لميل قارئي") !== -1
    && r.body.indexOf("أرسل لميل قارئي") < r.body.indexOf("اقرأ أونلاين")
    && !stripTgOnly(r.body).includes("احصل على الكتاب على جهازك"));
  check("B1 TG-only title: NO delivery footer note without an e-reader UA (no download button rendered)",
    !r.body.includes("رابط تنزيل يعمل 10 دقائق"));
  check("B1 TG-only title: NO telegram download note without an e-reader UA",
    !r.body.includes("يجلب الملف من تيليجرام"));
  check("B1 TG-only title: the word Kindle appears nowhere on the page (P1/P2: the email button is now 'أرسل لميل قارئي' and no longer names Kindle)",
    (r.body.match(/Kindle/g) || []).length === 0 && !r.body.includes("كيندلي"));
  check("B1 TG-only title: count line is 2", r.body.includes("وجدنا 2 نتيجة لـ"));
  check("B1 tg-search called with q + limit=10",
    lastTgUrl.includes("/api/tg-search?q=") && lastTgUrl.includes("limit=10"), lastTgUrl);
  check("B1 small combined page stays Kindle-small (<8 KB)",
    r.body.length < 8192, r.body.length + " B");
}
{
  // Telegram direct-send button (v4.8.49 — design B.5): SECOND after
  // the email button on Telegram cards, only when the reader opened
  // the page with a fingerprint (fp). No emoji on the website
  // button (2026-11-21 — the B1 "no decorative emoji" check above
  // still holds).
  tgMode = "ok";
  const r = await getBook("Everyone in This Bank Is a Thief", "&fp=test-fingerprint");
  check("B6 tg-send button: present on the Telegram card (lib=tg, handle+post+format+fp)",
    r.body.includes('class="btn" href="/api/tg-send?lib=tg')
    && r.body.includes("h=kotobkhana") && r.body.includes("p=7559")
    && r.body.includes("f=epub") && r.body.includes("fp=test-fingerprint")
    && r.body.includes("أرسله لي في تيليجرام"));
  check("B6 tg-send button: second — after the email button, before Read online",
    r.body.indexOf("أرسل لميل قارئي") !== -1
    && r.body.indexOf("أرسل لميل قارئي") < r.body.indexOf("أرسله لي في تيليجرام")
    && r.body.indexOf("أرسله لي في تيليجرام") < r.body.indexOf("اقرأ أونلاين"));
  check("B6 tg-send button: the flagged card has none (🚩 + View in bot only)",
    !r.body.includes("/api/tg-send?lib=tg&amp;h=darkromancenovels")
    && !r.body.includes("/api/tg-send?lib=tg&h=darkromancenovels"));
  const rNoFp = await getBook("Everyone in This Bank Is a Thief");
  check("B6 tg-send button: absent without a fingerprint (anonymous visitor)",
    !rNoFp.body.includes("/api/tg-send?"));
  // Auto-recognition (2026-11-20): the rlb_fp cookie set by
  // /api/identify on the first catalog visit works exactly like ?fp=
  // — a reader who searched from the homepage (no fp in the link)
  // still gets the tg-send button with the fingerprint.
  const rCookie = await onRequest({
    request: new Request("https://rlibook.tech/book?q=" + encodeURIComponent("Everyone in This Bank Is a Thief"),
      { headers: { Cookie: "rlb_fp=cookie-fingerprint" } }),
    env: {},
  });
  const rCookieBody = await rCookie.text();
  check("B6 tg-send button: present from the rlb_fp cookie (no ?fp= in the URL)",
    rCookieBody.includes("/api/tg-send?lib=tg")
    && rCookieBody.includes("fp=cookie-fingerprint")
    && rCookieBody.includes("أرسله لي في تيليجرام"));
  tgMode = "ok";
}
{
  // Hit page while D1 is still partial: the Telegram half is
  // incomplete, so the partial-import note must appear here too —
  // not only on the no-match page — or "وجدنا N نتيجة" reads as
  // complete.
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B4 hit page + D1 partial: partial-import note shown under Telegram heading",
    r.body.includes("ما زال يُستورَد") && r.body.includes("19 نوفمبر 2026")
    && r.body.indexOf("ما زال يُستورَد") > r.body.indexOf("من تيليجرام"));
  check("B4 hit page + D1 partial: note says more results may follow",
    r.body.includes("لم تظهر بعد"));
}
{
  // Import finished (coverage.partial === false): the same hit page,
  // but WITHOUT the partial-import note — it expires on its own.
  tgMode = "okFull";
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B5 hit page + import done: NO partial-import note",
    !r.body.includes("ما زال يُستورَد") && !r.body.includes("19 نوفمبر 2026"));
  tgMode = "ok";
}
{
  const r = await getBook("الحب");
  check("B2 combined query: OPDS + Telegram both present",
    r.body.includes("وجدنا 102 نتيجة لـ") && r.body.includes("من تيليجرام"));
  const opdsPos = r.body.indexOf("أرسل لميل قارئي");
  const tgPos = r.body.indexOf("من تيليجرام");
  check("B2 combined query: OPDS cards before Telegram section",
    opdsPos !== -1 && tgPos !== -1 && opdsPos < tgPos);
  check("B2 combined query: NO direct-download link on any card (removed 2026-11-13)",
    !r.body.includes("تنزيل مباشر")
    && !r.body.includes("drive.google.com/uc?id=")
    && !r.body.includes("hindawi.org/books/"));
  check("B2 combined query: NO VISIBLE /kindle/get link without an e-reader UA (WS1b; WS3b: tg-only)",
    tgOnlyGetLinks(r.body).all === tgOnlyGetLinks(r.body).tgOnly
    && !stripTgOnly(r.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib="));
  check("B2 combined query: NO delivery footer note without an e-reader UA (WS1b)",
    !r.body.includes("رابط تنزيل يعمل 10 دقائق"));
  check("B2 combined query: OPDS EPUB cards have a Read online button",
    r.body.includes("/site/reader/?lib=hindawi") && r.body.includes("اقرأ أونلاين"));
  check("B2 combined query: email button comes first on the OPDS card, then Read online (the Get in between is tg-only)",
    r.body.indexOf("أرسل لميل قارئي") !== -1
    && r.body.indexOf("أرسل لميل قارئي") < r.body.indexOf("اقرأ أونلاين")
    && !stripTgOnly(r.body).includes("احصل على الكتاب على جهازك"));
}
{
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B3 flagged card: 🚩 flag shown, no 'تجاري' word (P1/P2 wording)",
    r.body.includes("🚩") && !r.body.includes("تجاري"));
  check("B3 flagged card: NO t.me link for the flagged book",
    !r.body.includes("https://t.me/darkromancenovels/123"));
  check("B3 flagged card: points at the bot instead — ONE 'View in bot' button",
    r.body.includes("View in bot")
    && r.body.includes("https://t.me/RliBook_bot?start=dl_darkromancenovels_123_any"));
  check("B3 flagged card: reason comes BEFORE the bot button",
    r.body.indexOf("🚩 هذا الكتاب عليه علامة") !== -1
    && r.body.indexOf("🚩 هذا الكتاب عليه علامة") < r.body.indexOf("View in bot"));
  check("B3 flagged card: NO send button for the flagged book",
    !r.body.includes("h=darkromancenovels"));
  check("B3 flagged card: NO Read online button for the flagged book",
    !r.body.includes("/site/reader/?lib=tg&amp;h=darkromancenovels"));
}
{
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B4 invalid endpoint records dropped (bad URL + no title)",
    !r.body.includes("Bad Link Book") && !r.body.includes("example.com/evil")
    && !r.body.includes("No Title"));
}

// ============ C. Degradation (tg-search fails) =======================
console.log("C. Degradation:");
for (const mode of ["503", "500", "malformed"]) {
  tgMode = mode;
  const r = await getBook("Everyone in This Bank Is a Thief");
  check(`C1 tg-search ${mode}: still 200, OPDS-only no-match page`,
    r.status === 200 && r.body.includes("في المكتبات الخمس")
    && r.body.includes('href="/telegram/"') && !r.body.includes("kotobkhana"),
    "status " + r.status);
}
{
  tgMode = "503";
  const r = await getBook("لؤلؤة الحب");
  check("C2 tg-search 503 + OPDS hit: OPDS card intact, 200",
    r.status === 200 && r.body.includes("لؤلؤة الحب")
    && tgOnlyGetLinks(r.body).all === tgOnlyGetLinks(r.body).tgOnly
    && !stripTgOnly(r.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib=hindawi")
    && r.body.includes("/api/send-to-kindle?lib=hindawi"));
}
{
  tgMode = "empty";
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("C3 tg-search ok:true empty: 200, searched-everywhere wording",
    r.status === 200 && r.body.includes("في كل المكتبات (الخمس + تيليجرام)"));
  check("C3 tg-search ok:true empty: partial-import note shown (D1 still partial)",
    r.body.includes("ما زال يُستورَد") && r.body.includes("19 نوفمبر 2026")
    && r.body.includes("قد يظهر لاحقًا"));
}
{
  // Import finished (coverage.partial === false): the same no-match
  // page, but WITHOUT the partial-import note — it expires on its own.
  tgMode = "emptyFull";
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("C5 tg-search empty + import done: 200, searched-everywhere wording",
    r.status === 200 && r.body.includes("في كل المكتبات (الخمس + تيليجرام)"));
  check("C5 tg-search empty + import done: NO partial-import note",
    !r.body.includes("ما زال يُستورَد") && !r.body.includes("19 نوفمبر 2026"));
}
{
  tgMode = "xss";
  const r = await getBook("zzz");
  check("C4 tg title is HTML-escaped",
    r.body.includes("&lt;script&gt;") && !r.body.includes("<script>alert"));
}

// ============ D. fetchTelegramResults unit ===========================
console.log("D. fetchTelegramResults unit:");
{
  tgMode = "throw";
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("D1 throw -> unavailable, no results",
    t.available === false && t.total === 0 && t.results.length === 0);
  check("D1 throw -> coverage null (not guessed)",
    t.coverage === null);
}
{
  tgMode = "ok";
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("D2 ok -> available, total 42, 2 valid results (2 dropped)",
    t.available === true && t.total === 42 && t.results.length === 2,
    JSON.stringify({ available: t.available, total: t.total, n: t.results.length }));
  check("D2 coverage passed through (indexed/target/partial)",
    t.coverage && t.coverage.indexed === 149996
    && t.coverage.target === 323325 && t.coverage.partial === true,
    JSON.stringify(t.coverage));
  check("D2 flagged flag survives", t.results[1] && t.results[1].flagged === true);
  check("D2 bot deep link survives passthrough",
    t.results[1] && t.results[1].bot === "https://t.me/RliBook_bot?start=dl_darkromancenovels_123_any");
  check("D2 non-flagged result carries bot: null",
    t.results[0] && t.results[0].bot === null);
  check("D2 embedded cover survives passthrough",
    t.results[0] && t.results[0].cover.startsWith("data:image/gif;base64,"));
  check("D2 post-text description survives passthrough",
    t.results[0] && t.results[0].description.includes("سرقة بنك"));
}
{
  // Workstream 2b: a tampered bot link drops the whole record;
  // a missing bot field is legitimate (bot: null).
  tgMode = "badbot";
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("D2b tampered bot link drops the record",
    t.available === true && t.results.length === 2
    && t.results.every((r) => r.title !== "Tampered Bot Link"),
    JSON.stringify(t.results.map((r) => r.title)));
  check("D2b valid bot link survives",
    t.results.some((r) => r.title === "Good Bot Link"
      && r.bot === "https://t.me/RliBook_bot?start=dl_testchannel_123_any"));
  check("D2b missing bot field -> bot null (card falls back to bot home)",
    t.results.some((r) => r.title === "No Bot Field" && r.bot === null));
  const r = await getBook("Good Bot Link");
  check("D2b flagged card without a bot field still renders a View in bot button",
    r.body.includes("View in bot") && r.body.includes("https://t.me/RliBook_bot"));
}

// ============ G. Enrichment: cover + rating + description ==========
console.log("G. Enrichment (Blocks 4 + 9):");
tgMode = "ok";
ratingsMode = "ok";
{
  ratingsCalls = 0;
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("G1 book with a rating shows it (8.4/10) with its source",
    r.body.includes("8.4/10") && r.body.includes("التقييم من Google Books"),
    r.body.slice(0, 400));
  check("G1 rating count shown (what people say: how many rated)",
    r.body.includes("12345"));
  check("G1 book with NO rating shows no rating (never a fake 0/10)",
    !r.body.includes("0/10") && (r.body.match(/\/10/g) || []).length === 1,
    "occurrences of /10: " + (r.body.match(/\/10/g) || []).length);
  check("G1 ratings endpoint called once per Telegram card",
    ratingsCalls === 2, "calls " + ratingsCalls);
  check("G1 book with a cover shows it (embedded <img>)",
    r.body.includes('<img class="cover"')
    && r.body.includes("data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="));
  check("G1 book with NO cover shows no <img> (no placeholder image)",
    (r.body.match(/<img/g) || []).length === 1,
    "img tags: " + (r.body.match(/<img/g) || []).length);
  check("G1 description prefers the post text (first source)",
    r.body.includes("وصف المنشور: سرقة بنك تتحول إلى لغز.")
    && r.body.includes("(الوصف من منشور تيليجرام)"));
  check("G1 post text present -> Google Books description NOT shown for it",
    !r.body.includes("A bank heist gone wrong"));
  check("G1 flagged book (no post text) falls back to Google Books description",
    r.body.includes("وصف تجريبي من Google Books.")
    && r.body.includes("(الوصف من Google Books)"));
  check("G1 page still Kindle-small (<8 KB)",
    r.body.length < 8192, r.body.length + " B");
}
{
  // Ratings endpoint down: the page still renders, cards intact,
  // just without ratings/descriptions from Google Books.
  ratingsMode = "fail";
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("G2 ratings down: still 200, Telegram cards intact",
    r.status === 200 && r.body.includes("Everyone in This Bank Is a Thief")
    && r.body.includes("kotobkhana"));
  check("G2 ratings down: no rating text anywhere",
    !r.body.includes("/10"));
  check("G2 ratings down: post-text description still shown",
    r.body.includes("وصف المنشور: سرقة بنك"));
  check("G2 ratings down: cover still shown (cover does not need ratings)",
    r.body.includes('<img class="cover"'));
  ratingsMode = "ok";
}
{
  // fetchEnrichment unit: ok -> rating; fail -> nulls, never throws.
  const e1 = await fetchEnrichment("https://rlibook.tech",
    "Everyone in This Bank Is a Thief", "Benjamin Stevenson");
  check("G3 fetchEnrichment ok -> 8.4/10 from Google Books",
    e1.rating && e1.rating.value === 8.4 && e1.rating.source === "Google Books");
  ratingsMode = "fail";
  const e2 = await fetchEnrichment("https://rlibook.tech", "Dune", "");
  check("G3 fetchEnrichment fail -> nulls, no throw",
    e2.rating === null && e2.description === null);
  ratingsMode = "ok";
  const e3 = await fetchEnrichment("https://rlibook.tech", "No Such Book", "");
  check("G3 fetchEnrichment no match -> nulls",
    e3.rating === null && e3.description === null);
}
{
  // Cover validation in fetchTelegramResults: a hotlink cover and an
  // oversized embedded cover are both dropped (no cover, not a bad one).
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") {
      return jsonRes({ ok: true, q: "x", total: 2, limit: 10, offset: 0, results: [
        { title: "Hotlink Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], url: "https://t.me/s/1", flagged: false,
          cover: "https://example.com/cover.jpg" },
        { title: "Huge Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], url: "https://t.me/s/2", flagged: false,
          cover: "data:image/jpeg;base64," + "A".repeat(200000) },
      ] });
    }
    if (url.pathname === "/api/ratings") {
      return jsonRes({ ok: true, title: "", rating: null, description: null });
    }
    return saved(u);
  };
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("G4 hotlink cover dropped (embedded only)",
    t.results[0] && t.results[0].cover === "");
  check("G4 oversized embedded cover dropped (Kindle-small only)",
    t.results[1] && t.results[1].cover === "");
  globalThis.fetch = saved;
}

// ============ E. OPDS failure behaviour unchanged ====================
console.log("E. OPDS failure behaviour unchanged:");
{
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") throw new Error("down");
    if (url.pathname === "/sahwa/search-index.json") return new Response("x", { status: 404 });
    return saved(u);
  };
  const r = await getBook("الحب");
  check("E1 missing OPDS index: still 500 (never partial results as if complete)",
    r.status === 500, "status " + r.status);
  check("E1 missing OPDS index: a full HTML page, not a bare error line",
    r.body.includes("<!DOCTYPE html>") && r.body.includes("مكتبة صحوه"));
  check("E1 missing OPDS index: next step — Telegram index + home links",
    r.body.includes('href="/telegram/"') && r.body.includes('href="/"'));
  check("E1 missing OPDS index: no partial results shown",
    !r.body.includes("وجدنا") && !r.body.includes("/api/send-to-kindle"));
  globalThis.fetch = saved; // restore the standard mock for later sections
}

// ============ F. Gated-link validation in fetchTelegramResults =====
// (Workstream H: /api/tg-search returns pre-built gated links; the
// raw t.me post URL never reaches this page. A tampered reply must
// not inject an arbitrary link, and a `url` field — even a real one —
// must never be rendered.)
console.log("F. Telegram gated-link validation:");
{
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") {
      return jsonRes({ ok: true, q: "x", total: 4, limit: 10, offset: 0, results: [
        { title: "Good Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: false,
          get: "/kindle/get?lib=tg&h=s&p=1&f=epub&t=Good%20Book",
          send: "/api/send-to-kindle?lib=tg&h=s&p=1&f=epub&t=Good%20Book",
          read: "/site/reader/?lib=tg&h=s&p=1&f=epub&title=Good%20Book" },
        { title: "Evil Link Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: false,
          get: "https://evil.example/x", send: null, read: null },
        { title: "Url Field Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: false,
          url: "https://t.me/s/2", get: null, send: null, read: null },
        { title: "Mobi Book", author: "", source: "s", kind: "channel",
          formats: ["MOBI"], flagged: false, get: null, send: null, read: null },
      ] });
    }
    if (url.pathname === "/api/ratings") {
      return jsonRes({ ok: true, title: "", rating: null, description: null });
    }
    return saved(u);
  };
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("F1 valid gated links pass through",
    t.results.length === 3
    && t.results[0].get === "/kindle/get?lib=tg&h=s&p=1&f=epub&t=Good%20Book"
    && t.results[0].send !== null && t.results[0].read !== null,
    JSON.stringify(t.results.map((r) => r.title)));
  check("F1 tampered link drops the whole record (never rendered)",
    !t.results.some((r) => r.title === "Evil Link Book"));
  check("F1 a url field is ignored (never a link, never rendered)",
    t.results.some((r) => r.title === "Url Field Book")
    && t.results.find((r) => r.title === "Url Field Book").get === null
    && !("url" in t.results.find((r) => r.title === "Url Field Book")));
  check("F1 linkless MOBI book still renders (with the bot note, no buttons)",
    t.results.some((r) => r.title === "Mobi Book"
      && r.get === null && r.send === null && r.read === null));
  globalThis.fetch = saved;
}
{
  // Fingerprint rides along on the Get + Send links (a catalog user
  // never re-types their reader email). The Get link only renders
  // for an e-reader UA (WS1b), so the Get check uses a Kobo UA.
  tgMode = "ok";
  const KOBO_UA_F2 = "Kobo Touch 0390/4.45.23684";
  const r = await getBook("Everyone in This Bank Is a Thief", "&fp=FP1", KOBO_UA_F2);
  check("F2 fp passthrough on the Telegram Get link (Kobo UA)",
    r.body.includes("/kindle/get?lib=tg") && r.body.includes("fp=FP1"),
    r.body.slice(r.body.indexOf("/kindle/get?lib=tg"), r.body.indexOf("/kindle/get?lib=tg") + 120));
  check("F2 Telegram email button is the bot deep link (no direct /api/send-to-kindle on a TG card)",
    r.body.includes("https://t.me/RliBook_bot?start=send_kotobkhana_7559")
    && !r.body.includes("/api/send-to-kindle?lib=tg"));
}

// ============ H. Reader-link validation (Block 11b reader) =========
// The reader link comes pre-built from /api/tg-search; a tampered or
// missing one must never produce a Read button for a book that cannot
// be read online.
console.log("H. Telegram reader-link validation:");
{
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") {
      return jsonRes({ ok: true, q: "x", total: 2, limit: 10, offset: 0, results: [
        { title: "Evil Read Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: false,
          get: "/kindle/get?lib=tg&h=s&p=3&f=epub&t=Evil%20Read%20Book",
          send: null, read: "https://evil.example/read" },
        { title: "Pdf Only Book", author: "", source: "s", kind: "channel",
          formats: ["PDF"], flagged: false,
          get: "/kindle/get?lib=tg&h=s&p=4&f=pdf&t=Pdf%20Only%20Book",
          send: "/api/send-to-kindle?lib=tg&h=s&p=4&f=pdf&t=Pdf%20Only%20Book",
          read: null },
      ] });
    }
    if (url.pathname === "/api/ratings") {
      return jsonRes({ ok: true, title: "", rating: null, description: null });
    }
    return saved(u);
  };
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("H1 tampered reader link drops the whole record",
    !t.results.some((r) => r.title === "Evil Read Book"));
  check("H1 PDF-only book: Get + Send kept, Read null (reader opens EPUB only)",
    t.results.some((r) => r.title === "Pdf Only Book" && r.get !== null && r.send !== null && r.read === null));
  globalThis.fetch = saved;
}

// ============ I. Review fixes (Area 2): query cap, malformed index,
// ============    non-sendable OPDS format =============================
console.log("I. Review fixes (Area 2):");
{
  // A query longer than MAX_Q_LEN is a 400 page with the search form,
  // not a search (and not a crash).
  const r = await getBook("x".repeat(201));
  check("I1 query >200 chars: 400 + plain message + search form",
    r.status === 400 && r.body.includes("طويلة جداً")
    && r.body.includes("<form") && r.body.includes('href="/"'),
    "status " + r.status);
  const r2 = await getBook("x".repeat(200));
  check("I1 query of exactly 200 chars: searched, not rejected",
    r2.status === 200 && !r2.body.includes("طويلة جداً"), "status " + r2.status);
}
{
  // A malformed (non-JSON / non-array) OPDS index is the same helpful
  // 500 HTML page as a missing one — never an uncaught throw.
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") throw new Error("down");
    if (url.pathname === "/sahwa/search-index.json") return new Response("{not json", { headers: { "content-type": "application/json" } });
    return saved(u);
  };
  const r = await getBook("الحب");
  check("I2 malformed OPDS index: 500 HTML page naming the library",
    r.status === 500 && r.body.includes("<!DOCTYPE html>")
    && r.body.includes("مكتبة صحوه"), "status " + r.status);
  check("I2 malformed OPDS index: next-step links present",
    r.body.includes('href="/telegram/"') && r.body.includes('href="/"'));
  globalThis.fetch = saved;
}
{
  // An OPDS MOBI book (no such book is in the five indexes today, so
  // the index is mocked): NO send button — the endpoint would refuse
  // it — a bot note instead, and no footer note promising a send.
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") throw new Error("down");
    if (url.pathname === "/api/ratings") {
      return jsonRes({ ok: true, title: "", rating: null, description: null });
    }
    if (url.pathname === "/khazendar/search-index.json") {
      return new Response(JSON.stringify([
        { t: "Mobi Test Book", a: "Author", i: "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq", m: "application/x-mobipocket-ebook" },
      ]), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/search-index.json")) {
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
    return saved(u);
  };
  const r = await getBook("Mobi Test");
  check("I3 OPDS MOBI card: 200, card shown",
    r.status === 200 && r.body.includes("Mobi Test Book"), "status " + r.status);
  check("I3 OPDS MOBI card: NO Get button and NO email link (Send to Kindle refuses MOBI)",
    !r.body.includes("/kindle/get?lib=khazendar")
    && !r.body.includes("/api/send-to-kindle?lib=khazendar"));
  check("I3 OPDS MOBI card: bot note instead",
    r.body.includes("لا يمكن إرسال هذا الكتاب من الموقع")
    && r.body.includes("@RliBook_bot"));
  check("I3 OPDS MOBI card: NO Read online button (reader opens EPUB only)",
    !r.body.includes("/site/reader/?lib=khazendar"));
  check("I3 OPDS MOBI card: footer does not promise a delivery link",
    !r.body.includes("رابط تنزيل يعمل 10 دقائق"));
  globalThis.fetch = saved;
}

// ============ J. Kindle delivery (Get on Kindle) contract =========
// The email send (/api/send-to-kindle, unlimited) is the primary
// PATH; the download button (5/day) is button (1) and renders only
// for an e-reader UA (WS1b: Kobo/PocketBook/generic get a device
// label, Kindle keeps "احصل على الكتاب على جهازك"); every dynamic
// response is no-store (design §6.2.5).
console.log("J. Kindle delivery contract:");
tgMode = "throw";
{
  // Kobo UA: the download button is present (device label), the
  // Get URL carries lib + id + format + title.
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const r = await getBook("لؤلؤة الحب", "", KOBO_UA);
  check("J1 OPDS card: Get URL carries lib + id + format + title",
    r.body.includes("/kindle/get?lib=hindawi")
    && r.body.includes("f=epub") && r.body.includes("t="),
    r.body.slice(r.body.indexOf("/kindle/get"), r.body.indexOf("/kindle/get") + 120));
  check("J1 OPDS card: Kobo download button is a .btn and comes FIRST (2026-11-21 order); email button is a .btn after it",
    r.body.includes('class="btn" href="/api/send-to-kindle')
    && r.body.includes('class="btn" href="/kindle/get')
    // lastIndexOf: the banner at the top of the page quotes the
    // same label, so the FIRST occurrence is the banner, not the
    // button — the button is the LAST occurrence.
    && r.body.lastIndexOf("نزّل الكتاب على جهاز Kobo") < r.body.indexOf("أرسل لميل قارئي"));
  check("J1 hit page: cache-control: no-store",
    r.cache === "no-store", r.cache);
  check("J1 hit page (Kobo): footer explains the 10-minute link + on-device download, NO sendtokindle",
    r.body.includes("رابط تنزيل يعمل 10 دقائق")
    && r.body.includes("فينزّل الكتاب مباشرة في مكتبتك")
    && !r.body.includes("amazon.com/sendtokindle"));
  check("J1 hit page: footer states email is the primary path (no unlimited claim — TG sends go via the bot) + download is 5/day",
    r.body.includes("الإرسال بالإيميل هو الطريقة الأساسية")
    && !r.body.includes("بلا حد يومي")
    && r.body.includes("5 كتب في اليوم"));
}
{
  // No-UA page: the same footer promises email only — no download
  // sentence, no sendtokindle mention (WS1b). The tg-only "Other
  // ways" note (hidden outside Telegram) does mention sendtokindle
  // for Mini App users, so the check strips tg-only sections and
  // asserts on the VISIBLE page.
  const r = await getBook("لؤلؤة الحب");
  check("J1b hit page (no UA): footer is email-only",
    r.body.includes("الإرسال بالإيميل هو الطريقة الأساسية")
    && !r.body.includes("بلا حد يومي")
    && !stripTgOnly(r.body).includes("رابط تنزيل يعمل 10 دقائق")
    && !stripTgOnly(r.body).includes("amazon.com/sendtokindle"));
}
{
  const r = await getBook("");
  check("J2 empty-query page: cache-control: no-store",
    r.cache === "no-store", r.cache);
}
{
  const r = await getBook("x".repeat(201));
  check("J3 400 page: cache-control: no-store",
    r.status === 400 && r.cache === "no-store", "status " + r.status + " cache " + r.cache);
}
{
  // Get-link eligibility now lives in /api/tg-search (the endpoint
  // builds the link or nulls it); this page only renders what the
  // endpoint returns. Pin the contract through fetchTelegramResults:
  // a valid gated link passes through, a flagged book and a MOBI
  // book arrive with a null Get link (the delivery page could not
  // complete them).
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") {
      return jsonRes({ ok: true, q: "x", total: 3, limit: 10, offset: 0, results: [
        { title: "Good Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: false,
          get: "/kindle/get?lib=tg&h=s&p=1&f=epub&t=Good%20Book",
          send: null, read: null },
        { title: "Flagged Book", author: "", source: "s", kind: "channel",
          formats: ["EPUB"], flagged: true, get: null, send: null, read: null },
        { title: "Mobi Book", author: "", source: "s", kind: "channel",
          formats: ["MOBI"], flagged: false, get: null, send: null, read: null },
      ] });
    }
    return saved(u);
  };
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  const good = t.results.find((r) => r.title === "Good Book");
  check("J4 get link passes through (lib=tg + handle + post + format + title)",
    good && good.get === "/kindle/get?lib=tg&h=s&p=1&f=epub&t=Good%20Book",
    good && good.get);
  check("J4 flagged -> Get null",
    t.results.find((r) => r.title === "Flagged Book").get === null);
  check("J4 MOBI format -> Get null (delivery page cannot complete it)",
    t.results.find((r) => r.title === "Mobi Book").get === null);
  globalThis.fetch = saved;
}
{
  // A flagged Telegram card gets NEITHER a Get button NOR an email
  // link (the B3 checks cover the send button by handle absence;
  // pin the Get button explicitly too).
  tgMode = "ok";
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("J5 flagged card: NO Get button for the flagged book",
    !r.body.includes("/kindle/get?lib=tg&amp;h=darkromancenovels"));
  check("J5 flagged card: NO email link for the flagged book",
    !r.body.includes("/api/send-to-kindle?lib=tg&amp;h=darkromancenovels"));
}

// ============ K. REGRESSION (1102): index pre-filter =============
// /book used to JSON.parse() all five search indexes (~3 MB) on
// every search — 44–53 ms CPU for a no-hit query. The shared loader
// now skips the parse for a library the needle provably cannot
// match. Count JSON.parse calls end to end: a no-hit Arabic query
// must parse NOTHING (tg-search is mocked to throw, so the page is
// OPDS-only), while a hit query parses only the libraries that
// contain the needle.
{
  const realParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = (...a) => { parseCalls++; return realParse(...a); };
  try {
    tgMode = "throw";
    parseCalls = 0;
    const noHit = await getBook("كلمةغيرموجودة");
    check("K no-hit Arabic query: 200 no-match page, ZERO index parses",
      noHit.status === 200 && noHit.body.includes("لم نجد") && parseCalls === 0,
      `status=${noHit.status} parseCalls=${parseCalls}`);
    parseCalls = 0;
    const hit = await getBook("لؤلؤة الحب");
    check("K hit query: 200 + the book, parses only the library that contains it",
      hit.status === 200 && hit.body.includes("لؤلؤة الحب") && parseCalls === 1,
      `status=${hit.status} parseCalls=${parseCalls}`);
    parseCalls = 0;
    const latin = await getBook("love");
    check("K Latin query: parses (guard trips — case could differ)",
      latin.status === 200 && parseCalls >= 1, `parseCalls=${parseCalls}`);
  } finally {
    JSON.parse = realParse;
  }
}

// ================= L. E-reader family banner (Workstream E) =========
// A Kobo/PocketBook/generic UA gets a one-line banner at the top of
// the results page; Kindle/desktop get none. WS1b: the banner now
// names the device download button, and the button itself is gated
// — Kobo/PocketBook/generic get a device label, Kindle keeps the
// existing "احصل على الكتاب على جهازك" label, desktop/no-UA get no
// download button at all.
console.log("L. E-reader family banner:");
{
  tgMode = "throw";
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const POCKETBOOK_UA = "Mozilla/5.0 (Linux like Android; en_US) AppleWebKit/534.34 PocketBook/515 (screen 600x800; FW W515.4.4.540) Mobile";
  const GENERIC_UA = "eReader/2.0 (compatible)";
  const KINDLE_UA = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+";
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

  const kobo = await getBook("لؤلؤة الحب", "", KOBO_UA);
  check("L1 Kobo UA: banner present, Kobo download button present (device label), generic label absent",
    kobo.status === 200 && kobo.body.includes("أنت على جهاز Kobo")
    && kobo.body.includes("نزّل الكتاب على جهاز Kobo")
    && kobo.body.includes("/kindle/get?lib=")
    && !kobo.body.includes("احصل على الكتاب على جهازك"), "status " + kobo.status);
  const pb = await getBook("لؤلؤة الحب", "", POCKETBOOK_UA);
  check("L2 PocketBook UA: banner present, PocketBook download button present",
    pb.status === 200 && pb.body.includes("أنت على جهاز PocketBook")
    && pb.body.includes("نزّل الكتاب على جهاز PocketBook")
    && pb.body.includes("/kindle/get?lib="), "status " + pb.status);
  const gen = await getBook("لؤلؤة الحب", "", GENERIC_UA);
  check("L3 generic UA: try-direct banner, labelled unverified, try-download button present",
    gen.status === 200 && gen.body.includes("يبدو أنك على قارئ إلكتروني")
    && gen.body.includes("لم نتحقق من جهازك تحديدًا")
    && gen.body.includes("جرّب تنزيل الكتاب على جهازك")
    && gen.body.includes("/kindle/get?lib="), "status " + gen.status);
  const kindle = await getBook("لؤلؤة الحب", "", KINDLE_UA);
  check("L4 Kindle UA: NO new banner (Kindle pages already speak Kindle); existing Get button kept (phone → Send to Kindle, not a direct download)",
    kindle.status === 200 && !kindle.body.includes("أنت على جهاز Kobo")
    && !kindle.body.includes("أنت على جهاز PocketBook")
    && !kindle.body.includes("يبدو أنك على قارئ إلكتروني")
    && kindle.body.includes("احصل على الكتاب على جهازك")
    && kindle.body.includes("/kindle/get?lib="), "status " + kindle.status);
  const desktop = await getBook("لؤلؤة الحب", "", DESKTOP_UA);
  check("L5 desktop UA: NO banner, NO VISIBLE download button (email + reader only; WS3b: tg-only)",
    desktop.status === 200 && !desktop.body.includes("أنت على جهاز Kobo")
    && !desktop.body.includes("يبدو أنك على قارئ إلكتروني")
    && tgOnlyGetLinks(desktop.body).all === tgOnlyGetLinks(desktop.body).tgOnly
    && !stripTgOnly(desktop.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib=")
    && desktop.body.includes("/api/send-to-kindle?lib="), "status " + desktop.status);
  const noUa = await getBook("لؤلؤة الحب");
  check("L6 no UA: NO banner, NO VISIBLE download button (existing behaviour unchanged; WS3b: tg-only)",
    noUa.status === 200 && !noUa.body.includes("أنت على جهاز Kobo")
    && tgOnlyGetLinks(noUa.body).all === tgOnlyGetLinks(noUa.body).tgOnly
    && !stripTgOnly(noUa.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib="), "status " + noUa.status);
}

// ============ M. E-reader download button gate (Workstream 1b) ====
// The download button is a UA gate, not a proof of device: Kobo /
// PocketBook / generic UAs get a device-labelled button under the
// email button; Kindle keeps the existing button (its path is
// phone → Send to Kindle, never a direct download); desktop,
// mobile, and no-UA visitors get NO VISIBLE download button on
// the page (every /kindle/get link is inside a tg-only "Other ways" section,
// hidden outside Telegram — WS3b; no download wording in the
// footer). A spoofed UA sees the button on purpose (M6) — the
// gate deters ordinary users; the 10-minute token + 5/day cap +
// flag denylist in dl-token.js are what bound abuse (those are
// covered by functions/api/dl-token.test.mjs + get.test.mjs,
// run unchanged — see the WS1b doc).
// WS3b helper: count /kindle/get links on a page and how many sit
// inside a tg-only "Other ways" section. A desktop/mobile page must
// have every get link tg-only (all === tgOnly) and NO plain visible
// button. The tg-only class moved from the button's <p> to the whole
// .other-ways <div> (2026-11-20), so the count matches get links
// inside <div class="other-ways tg-only">...</div>.
function tgOnlyGetLinks(body) {
  const all = (body.match(/\/kindle\/get\?lib=/g) || []).length;
  const visible = stripTgOnly(body);
  const visibleCount = (visible.match(/\/kindle\/get\?lib=/g) || []).length;
  return { all, tgOnly: all - visibleCount };
}

// Strips tg-only "Other ways" sections (hidden outside Telegram) so
// a check can assert about VISIBLE buttons only. The old
// <p class="tg-only"> pattern is kept for robustness.
function stripTgOnly(body) {
  return body
    .replace(/<div class="other-ways tg-only">[\s\S]*?<\/div>/g, "")
    .replace(/<p class="tg-only">.*?<\/p>/g, "");
}

console.log("M. E-reader download button gate (WS1b):");
{
  tgMode = "ok";
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const POCKETBOOK_UA = "Mozilla/5.0 (Linux like Android; en_US) AppleWebKit/534.34 PocketBook/515 (screen 600x800; FW W515.4.4.540) Mobile";
  const GENERIC_UA = "eReader/2.0 (compatible)";
  const KINDLE_UA = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+";
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

  const kobo = await getBook("Everyone in This Bank Is a Thief", "", KOBO_UA);
  check("M1 Kobo UA: Kobo button on the Telegram card, in the Download section ABOVE the row (banner quotes the label too, hence >= 2)",
    kobo.status === 200
    && kobo.body.includes("نزّل الكتاب على جهاز Kobo")
    && (kobo.body.match(/نزّل الكتاب على جهاز Kobo/g) || []).length >= 2
    // lastIndexOf: the banner quotes the same label, so the button
    // is the LAST occurrence; it sits in the Download section
    // BEFORE the .actions row (2026-11-21 order) — before email
    // AND before Read online.
    && kobo.body.lastIndexOf("نزّل الكتاب على جهاز Kobo") < kobo.body.indexOf("أرسل لميل قارئي")
    && kobo.body.lastIndexOf("نزّل الكتاب على جهاز Kobo") < kobo.body.indexOf("اقرأ أونلاين"),
    "status " + kobo.status);
  check("M1 Kobo UA: Telegram download note + footer download note present, no sendtokindle",
    kobo.body.includes("يجلب الملف من تيليجرام")
    && kobo.body.includes("رابط تنزيل يعمل 10 دقائق")
    && !kobo.body.includes("amazon.com/sendtokindle"));
  const pb = await getBook("Everyone in This Bank Is a Thief", "", POCKETBOOK_UA);
  check("M2 PocketBook UA: PocketBook button present, Kobo label absent",
    pb.status === 200 && pb.body.includes("نزّل الكتاب على جهاز PocketBook")
    && !pb.body.includes("نزّل الكتاب على جهاز Kobo")
    && pb.body.includes("رابط تنزيل يعمل 10 دقائق"), "status " + pb.status);
  const gen = await getBook("Everyone in This Bank Is a Thief", "", GENERIC_UA);
  check("M3 generic UA: try-download button present, no device name claimed in the button",
    gen.status === 200 && gen.body.includes("جرّب تنزيل الكتاب على جهازك")
    && !gen.body.includes("نزّل الكتاب على جهاز Kobo")
    && !gen.body.includes("نزّل الكتاب على جهاز PocketBook"), "status " + gen.status);
  const kindle = await getBook("Everyone in This Bank Is a Thief", "", KINDLE_UA);
  check("M4 Kindle UA: existing Get button kept (phone → Send to Kindle), footer keeps the sendtokindle steps",
    kindle.status === 200 && kindle.body.includes("احصل على الكتاب على جهازك")
    && kindle.body.includes("/kindle/get?lib=")
    && kindle.body.includes("amazon.com/sendtokindle")
    && !kindle.body.includes("نزّل الكتاب على جهاز"), "status " + kindle.status);
  const desktop = await getBook("Everyone in This Bank Is a Thief", "", DESKTOP_UA);
  const dLinks = tgOnlyGetLinks(desktop.body);
  check("M5 desktop UA: NO VISIBLE download button — every /kindle/get link is inside a tg-only section (hidden outside Telegram)",
    desktop.status === 200 && dLinks.all > 0 && dLinks.all === dLinks.tgOnly
    && !stripTgOnly(desktop.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib=")
    && !desktop.body.includes("نزّل الكتاب على جهاز")
    && !desktop.body.includes("جرّب تنزيل الكتاب")
    && !desktop.body.includes("رابط تنزيل يعمل 10 دقائق")
    && !desktop.body.includes("يجلب الملف من تيليجرام")
    && desktop.body.includes("https://t.me/RliBook_bot?start=send_kotobkhana_7559")
    && desktop.body.includes("اقرأ أونلاين"), "status " + desktop.status + " links=" + JSON.stringify(dLinks));
  const iphone = await getBook("لؤلؤة الحب", "", IPHONE_UA);
  const iLinks = tgOnlyGetLinks(iphone.body);
  check("M5b iPhone UA: NO visible download button (every /kindle/get link is tg-only)",
    iphone.status === 200 && iLinks.all === iLinks.tgOnly
    && !stripTgOnly(iphone.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib="), "status " + iphone.status + " links=" + JSON.stringify(iLinks));
  const android = await getBook("لؤلؤة الحب", "", ANDROID_UA);
  const aLinks = tgOnlyGetLinks(android.body);
  check("M5c Android UA: NO visible download button (every /kindle/get link is tg-only)",
    android.status === 200 && aLinks.all === aLinks.tgOnly
    && !stripTgOnly(android.body).includes("<p><a class=\"btn\" href=\"/kindle/get?lib="), "status " + android.status + " links=" + JSON.stringify(aLinks));
  const spoofed = await getBook("لؤلؤة الحب", "", DESKTOP_UA + " Kobo");
  check("M6 HONEST LIMIT: a desktop UA with 'Kobo' appended DOES see the Kobo button (UA is spoofable — the gate deters, it does not prove)",
    spoofed.status === 200 && spoofed.body.includes("نزّل الكتاب على جهاز Kobo")
    && spoofed.body.includes("/kindle/get?lib="), "status " + spoofed.status);
  check("M6b spoofed UA: no tg-only duplicate (the visible button is the only one)",
    !spoofed.body.includes("class=\"tg-only\""), "status " + spoofed.status);
  check("M1b Kobo UA: no tg-only button either (visible button only)",
    !kobo.body.includes("class=\"tg-only\""));
  check("M7 Kobo UA: flagged Telegram card still gets NO download button (flag denylist beats the UA gate)",
    kobo.body.includes("كتاب مُعلَّم تجريبي")
    && !kobo.body.includes("/kindle/get?lib=tg&amp;h=darkromancenovels")
    && !kobo.body.includes("/kindle/get?lib=tg&h=darkromancenovels"));
  check("M8 ereaderDownloadLabel unit: kobo/pocketbook/generic/kindle/desktop",
    ereaderDownloadLabel("kobo") === "نزّل الكتاب على جهاز Kobo"
    && ereaderDownloadLabel("pocketbook") === "نزّل الكتاب على جهاز PocketBook"
    && ereaderDownloadLabel("generic") === "جرّب تنزيل الكتاب على جهازك"
    && ereaderDownloadLabel("kindle") === "احصل على الكتاب على جهازك"
    && ereaderDownloadLabel(null) === ""
    && ereaderDownloadLabel("desktop") === "");
  check("M8b otherWaysNote unit: Kindle explains the manual Amazon upload, Kobo/PocketBook explain the direct download — both say it is NOT the email button",
    otherWaysNote("kindle").includes("بدون إيميل")
    && otherWaysNote("kindle").includes("amazon.com/sendtokindle")
    && otherWaysNote("kindle").includes("بترفعه بنفسك")
    && otherWaysNote("kobo").includes("بدون إيميل")
    && otherWaysNote("kobo").includes("بينزّل على جهازك مباشرة")
    && !otherWaysNote("kobo").includes("sendtokindle"));
  check("M8c downloadSection unit: visible 'تنزيل الكتاب' section with the button + note; tg-only puts the class on the whole section; empty button renders nothing",
    downloadSection("<p><a class=\"btn\" href=\"/kindle/get?x=1\">B</a></p>", "kindle", false).includes("تنزيل الكتاب:")
    && downloadSection("<p><a class=\"btn\" href=\"/kindle/get?x=1\">B</a></p>", "kindle", false).includes("بدون إيميل")
    && downloadSection("<p><a class=\"btn\" href=\"/kindle/get?x=1\">B</a></p>", "kindle", false).includes("class=\"other-ways\"")
    && downloadSection("<p><a class=\"btn\" href=\"/kindle/get?x=1\">B</a></p>", "kindle", true).includes("class=\"other-ways tg-only\"")
    && downloadSection("", "kindle", false) === "");
}
{
  // Kobo UA + OPDS MOBI book (mocked index): still NO download
  // button — format eligibility is unchanged (WS-E §6 known
  // limitation, NOT fixed here: a Kobo could read MOBI directly,
  // but the Get button is hidden for MOBI/AZW3 books).
  tgMode = "throw";
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/api/tg-search") throw new Error("down");
    if (url.pathname === "/khazendar/search-index.json") {
      return new Response(JSON.stringify([
        { t: "Mobi Test Book", a: "Author", i: "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq", m: "application/x-mobipocket-ebook" },
      ]), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.endsWith("/search-index.json")) {
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
    return saved(u);
  };
  const r = await getBook("Mobi Test", "", "Kobo Touch 0390/4.45.23684");
  check("M9 Kobo UA + OPDS MOBI card: NO download button (eligibility unchanged), bot note instead",
    r.status === 200 && r.body.includes("Mobi Test Book")
    && !r.body.includes("/kindle/get?lib=khazendar")
    && r.body.includes("لا يمكن إرسال هذا الكتاب من الموقع"), "status " + r.status);
  globalThis.fetch = saved;
}

// --- N. Mini App hub tg-only button (WS3b) ---------------------------
// Inside Telegram the same /kindle/get button is rendered a second
// time with class "tg-only" — hidden by default, revealed only when
// telegram-webapp.js adds html.tg-webapp. It renders ONLY when the
// UA gate hid the download button, so the two never duplicate.
console.log("N. Mini App hub tg-only button (WS3b):");
{
  tgMode = "ok";
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const KINDLE_UA = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+";
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const desktop = await getBook("Everyone in This Bank Is a Thief", "", DESKTOP_UA);
  const dLinks = tgOnlyGetLinks(desktop.body);
  check("N1 desktop UA: tg-only /kindle/get button present (hidden outside Telegram)",
    desktop.status === 200 && dLinks.all > 0 && dLinks.all === dLinks.tgOnly,
    "status " + desktop.status + " links=" + JSON.stringify(dLinks));
  check("N1 desktop UA: tg-only button uses the generic Kindle-flow label",
    desktop.body.includes("احصل على الكتاب على جهازك")
    && !stripTgOnly(desktop.body).includes("احصل على الكتاب على جهازك"));
  check("N1 desktop UA: Mini App loader scripts + tg-only CSS in the head",
    desktop.body.includes("https://telegram.org/js/telegram-web-app.js")
    && desktop.body.includes("/site/assets/telegram-webapp.js")
    && desktop.body.includes(".tg-only{display:none}")
    && desktop.body.includes("html.tg-webapp .tg-only{display:block}"));
  const kobo = await getBook("Everyone in This Bank Is a Thief", "", KOBO_UA);
  check("N2 Kobo UA: visible Kobo button present, NO tg-only button (no duplication)",
    kobo.status === 200 && kobo.body.includes("نزّل الكتاب على جهاز Kobo")
    && !kobo.body.includes("class=\"tg-only\""));
  const kindle = await getBook("Everyone in This Bank Is a Thief", "", KINDLE_UA);
  check("N3 Kindle UA: visible Get button present, NO tg-only button (no duplication)",
    kindle.status === 200 && kindle.body.includes("احصل على الكتاب على جهازك")
    && !kindle.body.includes("class=\"tg-only\""));
  check("N4 flagged card: no tg-only button for the flagged book",
    kobo.body.includes("كتاب مُعلَّم تجريبي")
    && !(/<div class="other-ways tg-only">[\s\S]*?darkromancenovels[\s\S]*?<\/div>/.test(kobo.body)));
}

// Workstream 3: file size (from the index) + page count (no source
// today) render UNDER the format line, only when known — never an
// invented number, never "?" or "0", never a placeholder.
console.log("O. Book metadata (Workstream 3):");
{
  // Unit: formatFileSize.
  check("O1 formatFileSize passes the indexer text through",
    formatFileSize("2.7 MB") === "2.7 MB" && formatFileSize("888.9 KB") === "888.9 KB"
    && formatFileSize("23 MB") === "23 MB" && formatFileSize("512 B") === "512 B");
  check("O2 formatFileSize normalizes comma decimals + missing space + lowercase unit",
    formatFileSize("12,3 MB") === "12.3 MB" && formatFileSize("2.7MB") === "2.7 MB"
    && formatFileSize("2.7 mb") === "2.7 MB");
  check("O3 formatFileSize formats a byte count (one decimal)",
    formatFileSize(2831155) === "2.7 MB" && formatFileSize(512) === "512 B"
    && formatFileSize(1536) === "1.5 KB");
  check("O4 formatFileSize drops unknown/invalid sizes (never a fake number)",
    formatFileSize("") === null && formatFileSize("junk") === null
    && formatFileSize("0") === null && formatFileSize(null) === null
    && formatFileSize(undefined) === null && formatFileSize(-5) === null
    && formatFileSize("12.3 TB") === null && formatFileSize("12.3 XB") === null);
  // Unit: validatePages.
  check("O5 validatePages keeps a positive integer, drops the rest",
    validatePages(250) === 250 && validatePages("132") === 132
    && validatePages(0) === null && validatePages(-3) === null
    && validatePages(12.5) === null && validatePages("junk") === null
    && validatePages(null) === null && validatePages(undefined) === null);
  // Unit: formatBookMeta — the four display cases.
  check("O6 formatBookMeta both values",
    formatBookMeta({ size: "2.7 MB", pages: 250 }) === "الحجم: 2.7 MB · عدد الصفحات: 250");
  check("O7 formatBookMeta size only",
    formatBookMeta({ size: "888.9 KB" }) === "الحجم: 888.9 KB");
  check("O8 formatBookMeta pages only",
    formatBookMeta({ pages: 132 }) === "عدد الصفحات: 132");
  check("O9 formatBookMeta neither -> empty (caller renders no line)",
    formatBookMeta({}) === "" && formatBookMeta({ size: "junk", pages: 0 }) === ""
    && formatBookMeta() === "");
  // Unit: fetchTelegramResults passes size/pages through, drops junk.
  tgMode = "okMeta";
  const tg = await fetchTelegramResults("https://rlibook.tech", "WS3");
  check("O10 fetchTelegramResults: 5 results parsed",
    tg.available === true && tg.results.length === 5, "got " + tg.results.length);
  const byTitle = Object.fromEntries(tg.results.map((r) => [r.title, r]));
  check("O11 fetchTelegramResults: both values kept",
    byTitle["WS3 Meta Both"].size === "2.7 MB" && byTitle["WS3 Meta Both"].pages === 250);
  check("O12 fetchTelegramResults: size-only kept, pages absent",
    byTitle["WS3 Meta Size"].size === "888.9 KB" && !("pages" in byTitle["WS3 Meta Size"]));
  check("O13 fetchTelegramResults: pages-only kept, size absent",
    byTitle["WS3 Meta Pages"].pages === 132 && !("size" in byTitle["WS3 Meta Pages"]));
  check("O14 fetchTelegramResults: neither -> no keys at all",
    !("size" in byTitle["WS3 Meta Neither"]) && !("pages" in byTitle["WS3 Meta Neither"]));
  check("O15 fetchTelegramResults: junk size + pages 0 dropped, never shown",
    !("size" in byTitle["WS3 Meta Junk"]) && !("pages" in byTitle["WS3 Meta Junk"]));
  // End-to-end: the rendered page.
  const r = await getBook("WS3");
  check("O16 meta E2E: 200 + all five TG cards",
    r.status === 200 && ["WS3 Meta Both", "WS3 Meta Size", "WS3 Meta Pages",
      "WS3 Meta Neither", "WS3 Meta Junk"].every((t) => r.body.includes(t)),
    "status " + r.status);
  check("O17 meta E2E: both-values line under the format line",
    r.body.includes("الحجم: 2.7 MB · عدد الصفحات: 250"));
  check("O18 meta E2E: size-only and pages-only lines present",
    r.body.includes("الحجم: 888.9 KB") && r.body.includes("عدد الصفحات: 132"));
  check("O19 meta E2E: exactly 3 meta lines (neither + junk get none)",
    (r.body.match(/<p class=\"meta\">/g) || []).length === 3,
    "meta lines: " + ((r.body.match(/<p class=\"meta\">/g) || []).length));
  check("O20 meta E2E: labels appear exactly twice each (no duplicates, no leakage)",
    (r.body.match(/الحجم:/g) || []).length === 2
    && (r.body.match(/عدد الصفحات:/g) || []).length === 2);
  check("O21 meta E2E: no placeholder, no invented number anywhere",
    !r.body.includes("؟") && !r.body.includes("حجم غير معروف")
    && !r.body.includes("عدد الصفحات: 0") && !r.body.includes("junk"));
  check("O22 meta E2E: meta line sits inside the 'WS3 Meta Both' card, under the format line (no source line any more — source-hiding 2026-11-21)",
    r.body.indexOf("الحجم: 2.7 MB") > r.body.indexOf("WS3 Meta Both")
    && r.body.indexOf("الحجم: 2.7 MB") < r.body.indexOf("WS3 Meta Size"));
  // OPDS cards: no size/pages in their indexes -> no meta line at all.
  tgMode = "throw";
  const rOpds = await getBook("لؤلؤة الحب");
  check("O23 OPDS card: no metadata line (indexes carry no size/pages)",
    rOpds.status === 200 && !rOpds.body.includes('<p class="meta">')
    && !rOpds.body.includes("الحجم:") && !rOpds.body.includes("عدد الصفحات:"));
}

console.log("P. Convert button under the email button (2026-11-18 rework):");
{
  // A non-flagged Telegram PDF: the button MUST appear, under the
  // email button, with the same gated identity (lib=tg&h=&p=&f=pdf).
  tgMode = "okPdf";
  const r = await getBook("كتاب PDF تجريبي");
  check("P1 PDF card: 200 + Convert button present",
    r.status === 200 && r.body.includes("/api/convert-book?lib=tg")
    && r.body.includes("حوّل إلى EPUB"), "status " + r.status);
  check("P2 PDF card: Convert link carries the book identity (h + p + f=pdf)",
    r.body.includes("h=kotobkhana") && r.body.includes("p=9001")
    && r.body.includes("f=pdf"));
  check("P3 PDF card: Convert sits UNDER the email button (email first)",
    r.body.indexOf("أرسل لميل قارئي") !== -1
    && r.body.indexOf("أرسل لميل قارئي") < r.body.indexOf("حوّل إلى EPUB"));
  check("P4 PDF card: Convert is a plain GET link (no web_app, Kindle-safe)",
    r.body.includes('class="btn" href="/api/convert-book?lib=tg'));
  // The default TG page (EPUB card + flagged PDF card): NO Convert
  // button anywhere — EPUB is not convertible, flagged is never offered.
  tgMode = "ok";
  const r2 = await getBook("Everyone in This Bank Is a Thief");
  check("P5 EPUB + flagged cards: no Convert button anywhere",
    r2.status === 200 && !r2.body.includes("/api/convert-book")
    && !r2.body.includes("حوّل إلى EPUB"));
}

console.log("Q. Horizontal action row (2026-11-18):");
{
  // The row CSS: flex, wraps, light rise-in, reduced-motion off.
  tgMode = "okPdf";
  const r = await getBook("كتاب PDF تجريبي");
  check("Q1 row CSS: .actions is a wrapping flex row",
    r.body.includes(".actions{display:flex;flex-wrap:wrap;"));
  check("Q2 row CSS: light rise-in animation (rlb-rise, 0.25s)",
    r.body.includes("@keyframes rlb-rise")
    && r.body.includes("animation:rlb-rise .25s ease-out both"));
  check("Q3 row CSS: animation disabled under prefers-reduced-motion",
    r.body.includes("@media (prefers-reduced-motion:reduce){.actions{animation:none}}"));
  check("Q4 row CSS: hover/tap feedback on .btn",
    r.body.includes(".btn:hover") && r.body.includes(".btn:active{transform:scale(.98)}"));
  // The TG PDF card's buttons sit in ONE .actions row — email
  // first, Convert next — and the get button sits in a visible
  // Download section directly ABOVE the row (2026-11-21 order).
  // (Anchor on the Convert button — only this card
  // has one — so the row found is exactly this card's row, not
  // another card's. Note the mock has read: null, so this card has
  // no reader button; the download slot is the tg-only button
  // because the request carries no e-reader UA.)
  const convPos = r.body.indexOf("حوّل إلى EPUB");
  const rowStart = r.body.lastIndexOf('<div class="actions">', convPos);
  const rowEnd = r.body.indexOf("</div>", convPos);
  const row = rowStart !== -1 && rowEnd !== -1 ? r.body.slice(rowStart, rowEnd) : "";
  check("Q5 PDF card: email + Convert in ONE .actions row, get button NOT in the row",
    row.includes("أرسل لميل قارئي") && row.includes("حوّل إلى EPUB")
    && !row.includes("احصل على الكتاب على جهازك"));
  check("Q6 PDF card: email is the first button in the row",
    row.indexOf("أرسل لميل قارئي") < row.indexOf("حوّل إلى EPUB"));
  // The Download section directly ABOVE the row holds the get
  // button (tg-only here — no e-reader UA) with its label + note.
  const owStart = r.body.indexOf('<div class="other-ways', 0);
  const owEnd = owStart !== -1 ? r.body.indexOf("</div>", owStart) : -1;
  const ow = owStart !== -1 && owEnd !== -1 ? r.body.slice(owStart, owEnd) : "";
  check("Q6b PDF card: get button is in a visible Download section directly ABOVE the row, with the clarifying note",
    ow.includes("تنزيل الكتاب:") && ow.includes("احصل على الكتاب على جهازك")
    && ow.includes("/kindle/get?lib=tg") && ow.includes("بدون إيميل")
    && owEnd < rowStart);
  // Flagged card: the single "View in bot" button is in a row too,
  // and still the ONLY button on the card. (Anchor on the flag note.)
  tgMode = "ok";
  const r2 = await getBook("Everyone in This Bank Is a Thief");
  const flagNote = r2.body.indexOf("🚩 هذا الكتاب عليه علامة");
  const fStart = r2.body.indexOf('<div class="actions">', flagNote);
  const fEnd = r2.body.indexOf("</div>", fStart);
  const fRow = fStart !== -1 && fEnd !== -1 ? r2.body.slice(fStart, fEnd) : "";
  check("Q7 flagged card: 'View in bot' in its own .actions row, no other button",
    fRow.includes("View in bot") && !fRow.includes("أرسل لميل قارئي")
    && !fRow.includes("اقرأ أونلاين"));
  // OPDS card (Kobo UA, so a download button renders): email +
  // reader in ONE row, email first; the download button sits in a
  // visible Download section directly ABOVE the row (2026-11-21
  // order). (Anchor on the download button's href — the label text
  // also appears in the Kobo family note above the cards, so it
  // cannot anchor this.)
  tgMode = "throw";
  const KOBO_UA = "Kobo Touch 0390/4.45.23684";
  const r3 = await getBook("لؤلؤة الحب", "", KOBO_UA);
  const dlPos = r3.body.indexOf('href="/kindle/get?lib=hindawi');
  const ow2Start = r3.body.lastIndexOf('<div class="other-ways">', dlPos);
  const ow2End = ow2Start !== -1 ? r3.body.indexOf("</div>", dlPos) : -1;
  const ow2 = ow2Start !== -1 && ow2End !== -1 ? r3.body.slice(ow2Start, ow2End) : "";
  const oStart = ow2End !== -1 ? r3.body.indexOf('<div class="actions">', ow2End) : -1;
  const oEnd = oStart !== -1 ? r3.body.indexOf("</div>", oStart) : -1;
  const oRow = oStart !== -1 && oEnd !== -1 ? r3.body.slice(oStart, oEnd) : "";
  check("Q8 OPDS card: email + reader in ONE .actions row, email first; download button NOT in the row",
    oRow.includes("أرسل لميل قارئي") && oRow.includes("اقرأ أونلاين")
    && !oRow.includes("نزّل الكتاب على جهاز Kobo"));
  check("Q8b OPDS card: download button is in a visible Download section directly ABOVE the row, with the clarifying note",
    ow2.includes("تنزيل الكتاب:") && ow2.includes("نزّل الكتاب على جهاز Kobo")
    && ow2.includes("/kindle/get?lib=hindawi") && ow2.includes("بدون إيميل")
    && ow2End < oStart);
}

console.log("R. Report button LAST (2026-11-21) — wired to the existing bot report entry:");
{
  // Unit: the report row is a bot link + the criteria text, with no
  // "تجاري" / "commercial" anywhere in it (standing rule).
  check("R1 reportSection unit: bot link + criteria, no banned word",
    reportSection().includes('href="' + BOT_LINK + '"')
    && reportSection().includes("🚩 الإبلاغ عن الكتاب")
    && reportSection().includes(REPORT_CRITERIA)
    && BOT_LINK === "https://t.me/RliBook_bot"
    && !REPORT_CRITERIA.includes("تجاري")
    && !REPORT_CRITERIA.toLowerCase().includes("commercial"));
  check("R2 criteria text: recent + still sold + recent edition + publisher; PD classics never reportable",
    REPORT_CRITERIA.includes("إصداراً حديثاً ما زال يُباع")
    && REPORT_CRITERIA.includes("طبعة حديثة من دار نشر")
    && REPORT_CRITERIA.includes("الكلاسيكيات القديمة")
    && REPORT_CRITERIA.includes("المكتبات العامة"));
  // E2E, TG PDF card (no e-reader UA — download section is tg-only
  // but still in the HTML, so order is checkable): Download <
  // email < Convert < Report, Report last.
  tgMode = "okPdf";
  const r = await getBook("كتاب PDF تجريبي");
  check("R3 TG PDF card: Report button present, after Convert",
    r.status === 200 && r.body.includes("الإبلاغ عن الكتاب")
    && r.body.indexOf("حوّل إلى EPUB") < r.body.indexOf("الإبلاغ عن الكتاب"));
  check("R4 TG PDF card: full button order — Download < email < Convert < Report (last)",
    r.body.indexOf("احصل على الكتاب على جهازك") < r.body.indexOf("أرسل لميل قارئي")
    && r.body.indexOf("أرسل لميل قارئي") < r.body.indexOf("حوّل إلى EPUB")
    && r.body.indexOf("حوّل إلى EPUB") < r.body.indexOf("الإبلاغ عن الكتاب")
    && r.body.lastIndexOf("الإبلاغ عن الكتاب") > r.body.lastIndexOf("حوّل إلى EPUB"));
  check("R5 TG PDF card: criteria text next to the Report button",
    r.body.includes(REPORT_CRITERIA)
    && r.body.indexOf(REPORT_CRITERIA) > r.body.indexOf("الإبلاغ عن الكتاب"));
  // E2E, OPDS card (Kobo UA): Download < email < Read online < Report.
  tgMode = "throw";
  const r3 = await getBook("لؤلؤة الحب", "", "Kobo Touch 0390/4.45.23684");
  check("R6 OPDS card: Report button present, last after Read online",
    r3.status === 200 && r3.body.includes("الإبلاغ عن الكتاب")
    && r3.body.lastIndexOf("نزّل الكتاب على جهاز Kobo") < r3.body.indexOf("أرسل لميل قارئي")
    && r3.body.indexOf("أرسل لميل قارئي") < r3.body.indexOf("اقرأ أونلاين")
    && r3.body.indexOf("اقرأ أونلاين") < r3.body.indexOf("الإبلاغ عن الكتاب"));
  // Flagged card: NO Report button — already flagged, its only
  // button stays "View in bot" (slice from the flag note onward).
  tgMode = "ok";
  const r2 = await getBook("Everyone in This Bank Is a Thief");
  const flagNote = r2.body.indexOf("🚩 هذا الكتاب عليه علامة");
  check("R7 flagged card: no Report button (🚩 + View in bot only)",
    flagNote !== -1 && !r2.body.slice(flagNote).includes("الإبلاغ عن الكتاب"));
  check("R8 whole page: no 'تجاري' word in any report row",
    !r.body.includes("تجاري") && !r3.body.includes("تجاري"));
}

// ============ S. Website email -> bot handoff (2026-11-21) =======
// Telegram books hand off to the bot (send_<handle>_<post>) instead
// of calling /api/send-to-kindle directly; OPDS books keep the
// direct link (no handle/post, no bot deep link exists for them).
// /api/send-to-kindle itself stays: the catalog (/kindle/get) flow,
// tg-send / convert identity derivation, and the helper imports in
// convert-book.js / read.js all still use it.
console.log("S. Bot email handoff:");
{
  check("S1 botSendLink unit: TG send link -> bot deep link",
    botSendLink("/api/send-to-kindle?lib=tg&h=kotobkhana&p=7559&f=epub&t=X")
      === "https://t.me/RliBook_bot?start=send_kotobkhana_7559");
  check("S2 botSendLink unit: OPDS send link (no h/p) -> null",
    botSendLink("/api/send-to-kindle?lib=hindawi&id=13028368&f=epub&t=X") === null);
  check("S3 botSendLink unit: tampered handle / post -> null",
    botSendLink("/api/send-to-kindle?lib=tg&h=evil.example&p=1&f=epub&t=X") === null
    && botSendLink("/api/send-to-kindle?lib=tg&h=s&p=abc&f=epub&t=X") === null
    && botSendLink("/api/send-to-kindle?lib=tg&h=s&p=1") !== null);
  check("S4 botSendLink unit: non-send input -> null",
    botSendLink(null) === null && botSendLink("") === null
    && botSendLink("/api/tg-send?lib=tg&h=s&p=1&f=epub") === null);
}
{
  // E2E: OPDS card keeps the direct email link; TG card uses the bot.
  tgMode = "throw";
  const opds = await getBook("لؤلؤة الحب");
  check("S5 OPDS card: email button still direct /api/send-to-kindle",
    opds.body.includes('class="btn" href="/api/send-to-kindle?lib=hindawi')
    && opds.body.includes("أرسل لميل قارئي"));
  tgMode = "ok";
  const tg = await getBook("Everyone in This Bank Is a Thief", "&fp=FP1");
  check("S6 TG card: email button is the bot link, direct TG send gone",
    tg.body.includes('class="btn" href="https://t.me/RliBook_bot?start=send_kotobkhana_7559"')
    && !tg.body.includes("/api/send-to-kindle?lib=tg"));
  check("S7 TG card: tg-send still derives from the endpoint send link (identity carrier)",
    tg.body.includes("/api/tg-send?lib=tg"));
  tgMode = "okPdf";
  const pdf = await getBook("كتاب PDF تجريبي");
  check("S8 TG PDF card: convert still derives from the endpoint send link (identity carrier)",
    pdf.body.includes("/api/convert-book?lib=tg"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
