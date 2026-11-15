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
//      book info (no t.me link anywhere). Flagged books get a ⚑
//      marker, NO send button and NO reading, pointing at the bot.
//      Invalid endpoint records are dropped, "N من total" heading.
//   C. Degradation: every tg-search failure mode still returns
//      HTTP 200 with the OPDS-only page (never a 500, never a
//      broken page); an ok:true empty reply is distinguished from
//      "not searched" by the no-match wording.
//   D. Kindle-friendly: a small combined page stays under 8 KB.

import { readFileSync } from "node:fs";
import { onRequest, fetchTelegramResults, fetchEnrichment, parseTelegramPostUrl, telegramSendUrl, telegramGetUrl, telegramReaderUrl } from "./book.js";

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
    url: "https://t.me/kotobkhana/7559",
    flagged: false,
    // Embedded cover (Block 4 pairing): tiny 1x1 GIF data URI.
    cover: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    // Post-text description (first description source).
    description: "وصف المنشور: سرقة بنك تتحول إلى لغز.",
  },
  {
    title: "كتاب تجاري تجريبي",
    author: "مؤلف تجريبي",
    source: "darkromancenovels",
    kind: "channel",
    formats: ["PDF"],
    url: "https://t.me/darkromancenovels/123",
    flagged: true,
  },
  // Invalid records the page must drop, not render:
  { title: "Bad Link Book", author: "", source: "x", kind: "channel",
    formats: ["EPUB"], url: "https://example.com/evil", flagged: false },
  { author: "No Title", source: "x", kind: "channel",
    formats: ["EPUB"], url: "https://t.me/x/1", flagged: false },
];

let tgMode = "throw"; // throw | 503 | 500 | malformed | empty | ok | xss
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
    if (title.includes("كتاب تجاري")) {
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
    if (tgMode === "xss") {
      return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 1, limit: 10, offset: 0, results: [
        { title: "<script>alert(1)</script>", author: "a", source: "s", kind: "channel",
          formats: ["EPUB"], url: "https://t.me/s/1", flagged: false },
      ] });
    }
    return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 42, limit: 10, offset: 0, coverage: { indexed: 149996, target: 323325, partial: true }, results: TG_OK_RESULTS });
  }
  if (idx[url.pathname]) {
    return new Response(idx[url.pathname], { headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};

async function getBook(q, extra = "") {
  const res = await onRequest({
    request: new Request("https://rlibook.tech/book?q=" + encodeURIComponent(q) + extra),
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
  check("A1 OPDS title: Get-on-Kindle button (primary, /kindle/get)",
    r.body.includes("/kindle/get?lib=hindawi")
    && r.body.includes("احصل على الكتاب على جهازك"));
  check("A1 OPDS title: email still present as a secondary link (not a button)",
    r.body.includes("/api/send-to-kindle?lib=hindawi")
    && r.body.includes("أرسله بالإيميل (لمن أضاف المرسل من قبل)")
    && !r.body.includes('class="btn" href="/api/send-to-kindle'));
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
  check("B1 TG-only title: Telegram card (title/author/source/format)",
    r.body.includes("Everyone in This Bank Is a Thief")
    && r.body.includes("Benjamin Stevenson")
    && r.body.includes("kotobkhana")
    && r.body.includes("EPUB"));
  check("B1 TG-only title: section heading with total",
    r.body.includes("من تيليجرام (2 من 42)"));
  check("B1 TG-only title: source as TEXT, no t.me link anywhere",
    r.body.includes("المصدر: kotobkhana") && !r.body.includes("https://t.me/kotobkhana/7559"));
  check("B1 TG-only title: Get-on-Kindle button present (lib=tg, handle+post)",
    r.body.includes("/kindle/get?lib=tg")
    && r.body.includes("h=kotobkhana") && r.body.includes("p=7559")
    && r.body.includes("احصل على الكتاب على جهازك"));
  check("B1 TG-only title: email still present as a secondary link",
    r.body.includes("/api/send-to-kindle?lib=tg")
    && r.body.includes("أرسله بالإيميل (لمن أضاف المرسل من قبل)"));
  check("B1 TG-only title: no colour emoji except the Get/Read buttons (F2: old Kindle shows tofu)",
    !r.body.includes("📧") && !r.body.includes("📚") && !r.body.includes("⚑")
    && r.body.includes("📥") && r.body.includes("📖"));
  check("B1 TG-only title: Read online button present (EPUB -> /site/reader/?lib=tg)",
    r.body.includes("/site/reader/?lib=tg")
    && r.body.includes("h=kotobkhana") && r.body.includes("p=7559")
    && r.body.includes("📖 اقرأ أونلاين"));
  check("B1 TG-only title: Get on Kindle comes first, then Read online, then the email link",
    r.body.indexOf("احصل على الكتاب على جهازك") !== -1
    && r.body.indexOf("احصل على الكتاب على جهازك") < r.body.indexOf("اقرأ أونلاين")
    && r.body.indexOf("اقرأ أونلاين") < r.body.indexOf("أرسله بالإيميل"));
  check("B1 TG-only title: delivery footer note present (TG cards have Get buttons)",
    r.body.includes("رابط تنزيل يعمل 10 دقائق"));
  check("B1 TG-only title: telegram note explains the Get button fetches from Telegram",
    r.body.includes("يجلب الملف من تيليجرام"));
  check("B1 TG-only title: no 'Kindle' label anywhere on the page",
    !r.body.includes("كيندلي") && !r.body.includes("Kindle"));
  check("B1 TG-only title: count line is 2", r.body.includes("وجدنا 2 نتيجة لـ"));
  check("B1 tg-search called with q + limit=10",
    lastTgUrl.includes("/api/tg-search?q=") && lastTgUrl.includes("limit=10"), lastTgUrl);
  check("B1 small combined page stays Kindle-small (<8 KB)",
    r.body.length < 8192, r.body.length + " B");
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
  const opdsPos = r.body.indexOf("احصل على الكتاب على جهازك");
  const tgPos = r.body.indexOf("من تيليجرام");
  check("B2 combined query: OPDS cards before Telegram section",
    opdsPos !== -1 && tgPos !== -1 && opdsPos < tgPos);
  check("B2 combined query: NO direct-download link on any card (removed 2026-11-13)",
    !r.body.includes("تنزيل مباشر")
    && !r.body.includes("drive.google.com/uc?id=")
    && !r.body.includes("hindawi.org/books/"));
  check("B2 combined query: delivery footer note present (OPDS half shown)",
    r.body.includes("رابط تنزيل يعمل 10 دقائق"));
  check("B2 combined query: OPDS EPUB cards have a Read online button",
    r.body.includes("/site/reader/?lib=hindawi") && r.body.includes("اقرأ أونلاين"));
  check("B2 combined query: Get on Kindle comes first on the OPDS card",
    r.body.indexOf("احصل على الكتاب على جهازك") !== -1
    && r.body.indexOf("احصل على الكتاب على جهازك") < r.body.indexOf("اقرأ أونلاين"));
}
{
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B3 flagged card: تجاري marker shown (F2: the word, no glyph)",
    r.body.includes("تجاري") && !r.body.includes("⚑"));
  check("B3 flagged card: NO t.me link for the flagged book",
    !r.body.includes("https://t.me/darkromancenovels/123"));
  check("B3 flagged card: points at the bot instead",
    r.body.includes("هذا الكتاب تجاري (عليه علامة)")
    && r.body.includes("الموقع لا يتيح تحميله أو إرساله")
    && r.body.includes("قناة النشر")
    && r.body.includes("@RliBook_bot"));
  check("B3 flagged card: reason comes BEFORE the bot direction",
    r.body.indexOf("هذا الكتاب تجاري (عليه علامة)") !== -1
    && r.body.indexOf("هذا الكتاب تجاري (عليه علامة)") < r.body.indexOf("قناة النشر"));
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
    && r.body.includes("/kindle/get?lib=hindawi")
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
  check("D2 embedded cover survives passthrough",
    t.results[0] && t.results[0].cover.startsWith("data:image/gif;base64,"));
  check("D2 post-text description survives passthrough",
    t.results[0] && t.results[0].description.includes("سرقة بنك"));
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

// ============ F. telegramSendUrl / parseTelegramPostUrl unit ========
console.log("F. Telegram send-URL helpers:");
{
  check("F1 parse public post", JSON.stringify(parseTelegramPostUrl("https://t.me/kotobkhana/7559"))
    === JSON.stringify({ handle: "kotobkhana", postId: 7559 }));
  check("F1 parse lowercases handle",
    parseTelegramPostUrl("https://t.me/KotobKhana/7559").handle === "kotobkhana");
  check("F1 parse private-group c/ link -> null",
    parseTelegramPostUrl("https://t.me/c/123456/789") === null);
  check("F1 parse non-t.me -> null", parseTelegramPostUrl("https://example.com/x/1") === null);
  check("F1 parse missing post id -> null", parseTelegramPostUrl("https://t.me/kotobkhana") === null);
  const u = telegramSendUrl(
    { title: "Test Book", formats: ["EPUB"], url: "https://t.me/kotobkhana/7559", flagged: false }, "");
  check("F2 send URL: lib=tg + handle + post + format",
    u === "/api/send-to-kindle?lib=tg&amp;h=kotobkhana&amp;p=7559&amp;f=epub&amp;t=Test%20Book",
    u);
  check("F2 send URL: fp passthrough",
    telegramSendUrl(
      { title: "T", formats: ["PDF"], url: "https://t.me/s/1", flagged: false }, "&amp;fp=FP1")
      .includes("&amp;fp=FP1"));
  check("F2 flagged -> null",
    telegramSendUrl({ title: "T", formats: ["EPUB"], url: "https://t.me/s/1", flagged: true }, "") === null);
  check("F2 MOBI format -> null (email refuses it)",
    telegramSendUrl({ title: "T", formats: ["MOBI"], url: "https://t.me/s/1", flagged: false }, "") === null);
  check("F2 no formats -> null",
    telegramSendUrl({ title: "T", formats: [], url: "https://t.me/s/1", flagged: false }, "") === null);
  check("F2 private-group link -> null",
    telegramSendUrl({ title: "T", formats: ["EPUB"], url: "https://t.me/c/1/2", flagged: false }, "") === null);
}

// ============ H. telegramReaderUrl unit (Block 11b reader) =========
console.log("H. Telegram reader-URL helper:");
{
  const u = telegramReaderUrl(
    { title: "Test Book", formats: ["EPUB"], url: "https://t.me/kotobkhana/7559", flagged: false });
  check("H1 reader URL: lib=tg + handle + post + f=epub + title",
    u === "/site/reader/?lib=tg&amp;h=kotobkhana&amp;p=7559&amp;f=epub&amp;title=Test%20Book",
    u);
  check("H1 reader URL: EPUB among other formats still works",
    telegramReaderUrl(
      { title: "T", formats: ["PDF", "EPUB"], url: "https://t.me/s/1", flagged: false })
      !== null);
  check("H1 PDF-only -> null (reader opens EPUB only)",
    telegramReaderUrl(
      { title: "T", formats: ["PDF"], url: "https://t.me/s/1", flagged: false }) === null);
  check("H1 MOBI-only -> null",
    telegramReaderUrl(
      { title: "T", formats: ["MOBI"], url: "https://t.me/s/1", flagged: false }) === null);
  check("H1 no formats -> null",
    telegramReaderUrl(
      { title: "T", formats: [], url: "https://t.me/s/1", flagged: false }) === null);
  check("H1 flagged -> null (flagged books never reach the reader)",
    telegramReaderUrl(
      { title: "T", formats: ["EPUB"], url: "https://t.me/s/1", flagged: true }) === null);
  check("H1 private-group link -> null",
    telegramReaderUrl(
      { title: "T", formats: ["EPUB"], url: "https://t.me/c/1/2", flagged: false }) === null);
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
// The primary button is /kindle/get; email is a secondary link;
// every dynamic response is no-store (design §6.2.5).
console.log("J. Kindle delivery contract:");
tgMode = "throw";
{
  const r = await getBook("لؤلؤة الحب");
  check("J1 OPDS card: Get URL carries lib + id + format + title",
    r.body.includes("/kindle/get?lib=hindawi")
    && r.body.includes("f=epub") && r.body.includes("t="),
    r.body.slice(r.body.indexOf("/kindle/get"), r.body.indexOf("/kindle/get") + 120));
  check("J1 OPDS card: Get button is a .btn, email link is a plain link",
    r.body.includes('class="btn" href="/kindle/get')
    && !r.body.includes('class="btn" href="/api/send-to-kindle'));
  check("J1 hit page: cache-control: no-store",
    r.cache === "no-store", r.cache);
  check("J1 hit page: footer explains the 10-minute link + sendtokindle upload",
    r.body.includes("رابط تنزيل يعمل 10 دقائق")
    && r.body.includes("amazon.com/sendtokindle"));
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
  // telegramGetUrl unit: same eligibility as telegramSendUrl, but
  // the delivery page instead of the email endpoint.
  const u = telegramGetUrl(
    { title: "Test Book", formats: ["EPUB"], url: "https://t.me/kotobkhana/7559", flagged: false }, "");
  check("J4 get URL: lib=tg + handle + post + format + title",
    u === "/kindle/get?lib=tg&amp;h=kotobkhana&amp;p=7559&amp;f=epub&amp;t=Test%20Book",
    u);
  check("J4 get URL: fp passthrough",
    telegramGetUrl(
      { title: "T", formats: ["PDF"], url: "https://t.me/s/1", flagged: false }, "&amp;fp=FP1")
      .includes("&amp;fp=FP1"));
  check("J4 flagged -> null",
    telegramGetUrl({ title: "T", formats: ["EPUB"], url: "https://t.me/s/1", flagged: true }, "") === null);
  check("J4 MOBI format -> null (delivery page cannot complete it)",
    telegramGetUrl({ title: "T", formats: ["MOBI"], url: "https://t.me/s/1", flagged: false }, "") === null);
  check("J4 no formats -> null",
    telegramGetUrl({ title: "T", formats: [], url: "https://t.me/s/1", flagged: false }, "") === null);
  check("J4 private-group link -> null",
    telegramGetUrl({ title: "T", formats: ["EPUB"], url: "https://t.me/c/1/2", flagged: false }, "") === null);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
