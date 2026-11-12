// Test for the newest-books page (functions/new.js).
// Standalone Node script — run from the repo root:
//   node functions/new.test.mjs
//
// Mocks global fetch (the static /telegram/newest.json file) and the
// optional RLIBOOK_KV binding (live:additions), imports the real
// Function module, and calls onRequest() over HTTP semantics.
// It asserts the response contract for:
//   1. the static list renders (titles, author, source/format/date,
//      t.me link, weekly notice, count + generated date),
//   2. live KV books are prepended and de-duplicated by URL,
//   3. missing newest.json + no live books -> the honest fallback
//      page (no invented books, links to /telegram/ and /book),
//   4. ?limit clamping (500 -> 50; garbage -> 30 default),
//   5. HTML escaping (a title containing markup is escaped),
//   6. no KV binding -> works from the static file alone.
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no deploy.

import { readFileSync } from "node:fs";
import { onRequest, parseTelegramPostUrl, telegramSendUrl } from "./new.js";

const NEWEST = JSON.parse(readFileSync("site/telegram/newest.json", "utf-8"));

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("ok   " + name);
  } else {
    fail++;
    console.log("FAIL " + name + (extra ? " — " + extra : ""));
  }
}

function mockFetch(jsonData, ok = true, status = 200) {
  globalThis.fetch = async (input) => {
    const u = String(input);
    if (!u.includes("/telegram/newest.json")) {
      throw new Error("unexpected fetch: " + u);
    }
    return {
      ok,
      status,
      json: async () => {
        if (!ok) throw new Error("HTTP " + status);
        return jsonData;
      },
    };
  };
}

function mockKv(value) {
  if (value === null) return undefined; // no binding at all
  return { get: async (key) => (key === "live:additions" ? value : null) };
}

async function get(path, kvValue, newest = NEWEST, kvOverride) {
  mockFetch(newest, newest !== null);
  const env = {};
  const kv = kvOverride !== undefined ? kvOverride : mockKv(kvValue);
  if (kv !== undefined) env.RLIBOOK_KV = kv;
  const res = await onRequest({
    request: new Request("https://rlibook.tech" + path),
    env,
  });
  return { status: res.status, text: await res.text() };
}

// 1. Static list renders.
{
  const { status, text } = await get("/new", null);
  check("1 status 200", status === 200, "got " + status);
  check("1 weekly notice present",
    text.includes("القاموس ملف لا يحدّث نفسه — البوت يرسل النسخة الجديدة تلقائياً، وهذه الصفحة فيها أحدث الكتب دائماً"));
  check("1 first book title present", text.includes(NEWEST.books[0].title));
  check("1 count line present", text.includes("أحدث 30 كتاب"));
  check("1 generated date present", text.includes(NEWEST.generated_at.slice(0, 10)));
  check("1 NO book t.me link anywhere (source is text, not a link)",
    !text.includes(NEWEST.books[0].url) && !text.includes("المصدر في تليجرام"));
  check("1 send button present (lib=tg, handle+post)",
    text.includes("/api/send-to-kindle?lib=tg")
    && text.includes("📧 أرسل إلى جهازي"));
  check("1 source as text under the book info",
    text.includes("المصدر: " + NEWEST.books[0].source));
  check("1 format+date meta present",
    text.includes(NEWEST.books[0].format) && text.includes(NEWEST.books[0].date));
  check("1 no 'Kindle' label anywhere on the page",
    !text.includes("كيندلي") && !text.includes("Kindle"));
  check("1 footer links present",
    text.includes('href="/book"') && text.includes('href="/telegram/"'));
  check("1 no fake /book?q= links for telegram books", !text.includes("/book?q="));
}

// 2. Live KV books prepended + de-duplicated by URL.
{
  const liveBook = {
    title: "كتاب لحظي جديد",
    author: "مؤلف لحظي",
    source: "SomeChannel",
    format: "epub",
    date: "2026-11-12",
    url: "https://t.me/SomeChannel/999",
    added_at: "2026-11-12T15:00:00+00:00",
  };
  const dupe = { ...NEWEST.books[0], title: NEWEST.books[0].title };
  const kvValue = JSON.stringify({
    since: "2026-11-12T00:00:00+00:00",
    books: [liveBook, dupe],
  });
  const { text } = await get("/new", kvValue);
  check("2 live book first",
    text.indexOf("كتاب لحظي جديد") !== -1
    && text.indexOf("كتاب لحظي جديد") < text.indexOf(NEWEST.books[0].title));
  const occurrences = text.split(NEWEST.books[0].title).length - 1;
  check("2 duplicate live book not repeated", occurrences === 1, "got " + occurrences);
}

// 3. Missing newest.json + no live books -> honest fallback.
{
  const { status, text } = await get("/new", null, null);
  check("3 fallback status 200", status === 200, "got " + status);
  check("3 fallback says not published yet", text.includes("لم تُنشر بعد"));
  check("3 fallback keeps weekly notice",
    text.includes("القاموس ملف لا يحدّث نفسه — البوت يرسل النسخة الجديدة تلقائياً، وهذه الصفحة فيها أحدث الكتب دائماً"));
  check("3 fallback links to /telegram/ and /book",
    text.includes('href="/telegram/"') && text.includes('href="/book"'));
  check("3 fallback invents no books", !text.includes("المصدر في تليجرام"));
}

// 4. Limit clamping.
{
  const many = { generated_at: NEWEST.generated_at, count: 60,
    books: Array.from({ length: 60 }, (_, i) => ({
      title: "كتاب " + (i + 1), author: "", source: "s", format: "PDF",
      date: "2026-11-10", url: "https://t.me/s/" + (i + 1),
    })) };
  const { text: t50 } = await get("/new?limit=500", null, many);
  check("4 limit=500 clamped to 50",
    t50.includes("أحدث 50 كتاب"), "count line missing");
  const { text: t30 } = await get("/new?limit=abc", null, many);
  check("4 limit=abc defaults to 30", t30.includes("أحدث 30 كتاب"));
  const { text: t1 } = await get("/new?limit=1", null, many);
  check("4 limit=1 shows 1", t1.includes("أحدث 1 كتاب"));
}

// 5. HTML escaping.
{
  const evil = { generated_at: NEWEST.generated_at, count: 1, books: [{
    title: "<script>alert(1)</script>", author: "A & B", source: "s",
    format: "PDF", date: "2026-11-10", url: "https://t.me/s/1",
  }] };
  const { text } = await get("/new", null, evil);
  check("5 title markup escaped",
    text.includes("&lt;script&gt;") && !text.includes("<script>alert"));
  check("5 author ampersand escaped", text.includes("A &amp; B"));
}

// 6. Malformed KV value -> ignored, static list still renders.
{
  const { text } = await get("/new", "not-json{{");
  check("6 malformed KV ignored", text.includes(NEWEST.books[0].title));
}

// 7. Flagged books (KV denylist) + send-URL helpers + fp passthrough.
{
  const first = NEWEST.books[0]; // https://t.me/books_p/11692
  const flagKey = "flag:books_p:11692";
  let flagGets = 0;
  const kv = {
    get: async (key) => {
      if (key === "live:additions") return null;
      if (key.startsWith("flag:")) {
        flagGets++;
        return key === flagKey ? "1" : null;
      }
      return null;
    },
  };
  const { text } = await get("/new", null, NEWEST, kv);
  check("7 flagged: ⚑ marker on the flagged book", text.includes("⚑ تجاري"));
  check("7 flagged: NO send button for the flagged book", !text.includes("p=11692"));
  check("7 flagged: one-line bot explanation, no reading",
    text.includes("لا يمكن تنزيله أو إرساله من الموقع")
    && text.includes("@RliBook_bot"));
  check("7 flagged: other books still have send buttons",
    text.includes("/api/send-to-kindle?lib=tg"));
  check("7 flag check cost: one KV get per shown book (30)",
    flagGets === 30, "flag gets=" + flagGets);
}
{
  const { text } = await get("/new?fp=FP123", null);
  check("7 fp passthrough: send URLs carry the fingerprint",
    text.includes("&amp;fp=FP123"));
}
{
  const mobi = { generated_at: NEWEST.generated_at, count: 1, books: [{
    title: "كتاب موبي", author: "", source: "s",
    format: "MOBI", date: "2026-11-10", url: "https://t.me/s/1",
  }] };
  const { text } = await get("/new", null, mobi);
  check("7 MOBI book: no send button, bot note instead",
    !text.includes("/api/send-to-kindle") && text.includes("اطلبه من البوت"));
}
{
  check("7 parse public post",
    JSON.stringify(parseTelegramPostUrl("https://t.me/books_p/11692"))
    === JSON.stringify({ handle: "books_p", postId: 11692 }));
  check("7 parse private-group c/ link -> null",
    parseTelegramPostUrl("https://t.me/c/1/2") === null);
  const u = telegramSendUrl(
    { title: "T", format: "PDF", url: "https://t.me/s/5" }, "");
  check("7 send URL: lib=tg + handle + post + format",
    u === "/api/send-to-kindle?lib=tg&amp;h=s&amp;p=5&amp;f=pdf&amp;t=T", u);
  check("7 send URL: flagged book object -> null",
    telegramSendUrl({ title: "T", format: "PDF", url: "https://t.me/s/5", flagged: true }, "") === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
