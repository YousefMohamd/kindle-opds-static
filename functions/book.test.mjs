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
import { onRequest, fetchTelegramResults, parseTelegramPostUrl, telegramSendUrl } from "./book.js";

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
const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.pathname === "/api/tg-search") {
    tgCalls++;
    lastTgUrl = u;
    if (tgMode === "throw") throw new Error("fetch failed (tg-search not deployed)");
    if (tgMode === "503") return jsonRes({ ok: false, error: "search unavailable (TG_D1 not bound)" }, 503);
    if (tgMode === "500") return jsonRes({ ok: false, error: "search failed: boom" }, 500);
    if (tgMode === "malformed") return new Response("{not json", { headers: { "content-type": "application/json" } });
    if (tgMode === "empty") return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 0, limit: 10, offset: 0, results: [] });
    if (tgMode === "xss") {
      return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 1, limit: 10, offset: 0, results: [
        { title: "<script>alert(1)</script>", author: "a", source: "s", kind: "channel",
          formats: ["EPUB"], url: "https://t.me/s/1", flagged: false },
      ] });
    }
    return jsonRes({ ok: true, q: url.searchParams.get("q"), total: 42, limit: 10, offset: 0, results: TG_OK_RESULTS });
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
  return { status: res.status, body: await res.text() };
}

// ================= A. OPDS-only mode (tg-search unavailable) ========
console.log("A. OPDS-only mode (tg-search throws):");
tgMode = "throw";

{
  tgCalls = 0;
  const r = await getBook("لؤلؤة الحب");
  check("A1 OPDS title: 200", r.status === 200, "status " + r.status);
  check("A1 OPDS title: card + author", r.body.includes("لؤلؤة الحب") && r.body.includes("هربرت جورج ويلز"));
  check("A1 OPDS title: send-to-kindle button", r.body.includes("/api/send-to-kindle?lib=hindawi"));
  check("A1 OPDS title: direct download link", r.body.includes("https://www.hindawi.org/books/13028368.epub"));
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
  check("A2 TG-only title: no Telegram card rendered", !r.body.includes("kotobkhana"));
  check("A2 TG-only title: no send button", !r.body.includes("/api/send-to-kindle"));
}
{
  tgCalls = 0;
  const r = await getBook("");
  check("A3 empty query: 200 + five-libraries text",
    r.status === 200 && r.body.includes("ابحث في المكتبات الخمس"));
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
  check("B1 TG-only title: TG send button present (lib=tg, handle+post)",
    r.body.includes("/api/send-to-kindle?lib=tg")
    && r.body.includes("h=kotobkhana") && r.body.includes("p=7559")
    && r.body.includes("📧 أرسل إلى جهازي"));
  check("B1 TG-only title: send footer note present (TG cards have send buttons)",
    r.body.includes("زر «أرسل إلى جهازي»"));
  check("B1 TG-only title: telegram note explains the send button fetches from Telegram",
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
  const r = await getBook("الحب");
  check("B2 combined query: OPDS + Telegram both present",
    r.body.includes("وجدنا 102 نتيجة لـ") && r.body.includes("من تيليجرام"));
  const opdsPos = r.body.indexOf("أرسل إلى جهازي");
  const tgPos = r.body.indexOf("من تيليجرام");
  check("B2 combined query: OPDS cards before Telegram section",
    opdsPos !== -1 && tgPos !== -1 && opdsPos < tgPos);
  check("B2 combined query: send footer note present (OPDS half shown)",
    r.body.includes("زر «أرسل إلى جهازي»"));
}
{
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("B3 flagged card: ⚑ marker shown", r.body.includes("⚑ تجاري"));
  check("B3 flagged card: NO t.me link for the flagged book",
    !r.body.includes("https://t.me/darkromancenovels/123"));
  check("B3 flagged card: points at the bot instead",
    r.body.includes("لا يمكن تنزيله أو إرساله من الموقع")
    && r.body.includes("@RliBook_bot"));
  check("B3 flagged card: NO send button for the flagged book",
    !r.body.includes("h=darkromancenovels"));
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
    && r.body.includes("/api/send-to-kindle?lib=hindawi"));
}
{
  tgMode = "empty";
  const r = await getBook("Everyone in This Bank Is a Thief");
  check("C3 tg-search ok:true empty: 200, searched-everywhere wording",
    r.status === 200 && r.body.includes("في كل المكتبات (الخمس + تيليجرام)"));
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
}
{
  tgMode = "ok";
  const t = await fetchTelegramResults("https://rlibook.tech", "x");
  check("D2 ok -> available, total 42, 2 valid results (2 dropped)",
    t.available === true && t.total === 42 && t.results.length === 2,
    JSON.stringify({ available: t.available, total: t.total, n: t.results.length }));
  check("D2 flagged flag survives", t.results[1] && t.results[1].flagged === true);
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
  check("E1 missing OPDS index still 500 naming the index",
    r.status === 500 && r.body.includes("/sahwa/search-index.json"),
    "status " + r.status);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
