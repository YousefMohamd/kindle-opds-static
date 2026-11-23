// Test for the newest-books page (functions/new.js).
// Standalone Node script — run from the repo root:
//   node functions/new.test.mjs
//
// Mocks global fetch (the static /telegram/newest.json file and the
// bot Worker's /api/live-state endpoint) and the optional
// RLIBOOK_KV binding (legacy live:additions copy — the migration
// fallback), imports the real Function module, and calls onRequest()
// over HTTP semantics.
// It asserts the response contract for:
//   1. the static list renders (titles, author, source/format/date,
//      t.me link, weekly notice, count + generated date, and NO
//      direct-download link — email send is the only download path),
//   2. live books are prepended and de-duplicated by URL — from the
//      /api/live-state endpoint when it answers, and from the legacy
//      KV copy when the endpoint has no value yet,
//   3. missing newest.json + no live books -> the honest fallback
//      page (no invented books, links to /telegram/ and /book),
//   4. ?limit clamping (500 -> 50; garbage -> 30 default),
//   5. HTML escaping (a title containing markup is escaped),
//   6. no KV binding -> works from the static file alone.
// Exit 0 = all pass; non-zero + a message = failure.
// No network, no production KV, no deploy.

import { onRequest, parseTelegramPostUrl, telegramSendUrl } from "./new.js";

// NOTE (2026-11-23): the newest.json fixture is EMBEDDED below instead of
// read from site/telegram/newest.json. The live file's shape varies — the
// 2026-11-21 file stores bare handles ("url": "rwaiaty4") with no post ID,
// so parseTelegramPostUrl() returns null and no send buttons render —
// a pre-existing data-shape issue, not a page bug. This migration is
// about the data SOURCE (DO live-state first, KV fallback), not URL
// parsing, so the test pins a fixed fixture with full t.me post URLs
// (snapshot of site/telegram/newest.json, 2026-11-16) and stays green
// regardless of what the live file contains.

const NEWEST = {"generated_at": "2026-11-16T10:48:17.136723+00:00", "count": 30, "books": [{"title": "دليل - وتصنيف - برامج - أ - أحمد - سالم", "author": "التدريبية", "source": "ahmedsalem81", "format": "PDF", "date": "2026-11-16", "url": "https://t.me/ahmedsalem81/3922"}, {"title": "إرشاد - طلاب - الحقائق - إلى - معرفة - سنن - خير - الخلائق", "author": "صلى الله عليه وسلم", "source": "IslamicLibrary1", "format": "PDF", "date": "2026-11-16", "url": "https://t.me/IslamicLibrary1/17520"}, {"title": "‎⁨ماذا فعلت⁩", "author": "", "source": "ArwaCoffeeBook", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/ArwaCoffeeBook/6202"}, {"title": "‎⁨ماذا علمتني الحياة؟⁩", "author": "", "source": "Book_cr2", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/Book_cr2/68681"}, {"title": "‎⁨فن مخاطبة الجمهور", "author": "", "source": "To_The_Book", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/To_The_Book/66368"}, {"title": "‎⁨ضيف - غير - مرغوب - فيه - ، - شاري", "author": "لابينا⁩", "source": "ArwaCoffeeBook", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/ArwaCoffeeBook/6203"}, {"title": "يوسف أيها الصديق", "author": "", "source": "baz_book", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/baz_book/24180"}, {"title": "ومواقف - ومشاهدات - مع - العلامة - ابن - عثيمين - رحمه - الله - 1", "author": "ذكريات", "source": "jami-al-kutub-al-musawwara", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/jami-al-kutub-al-musawwara/286083"}, {"title": "وكأني أقرؤه لأول مرة", "author": "", "source": "safi_book", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/safi_book/14231"}, {"title": "وجيه - الجزار - المعلومات - الزراعية - والاقتصادية - والادارية - عن - سنجق", "author": "ديرالزور", "source": "abo_abdu", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/abo_abdu/16588"}, {"title": "وجهات ١٥ نوفمبر", "author": "عُمان", "source": "arabJournalism", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/arabJournalism/251301"}, {"title": "هذا ليس عقلي", "author": "مرح إمحمد الطبيب", "source": "asseralkotob", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/asseralkotob/2212"}, {"title": "نزهة الخاطر في عبادة جبر الخواطر", "author": "خليل بن سليمان الزوم", "source": "islamicMoral", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/islamicMoral/5692"}, {"title": "نزهة الخاطر في عبادة جبر الخواطر", "author": "", "source": "safi_book", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/safi_book/14261"}, {"title": "نداء غرناطة", "author": "سلسلة فارس الأندلس", "source": "mybook22", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/mybook22/128966"}, {"title": "مواقف - النبي - صلى الله عليه وسلم - في - الدعوة - إلى - الله", "author": "تعالى", "source": "PDFnew", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/PDFnew/112220"}, {"title": "مواقف - الصحابة - رضي - الله - عنهم - في - الدعوة - إلى - الله", "author": "تعالى", "source": "PDFnew", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/PDFnew/112222"}, {"title": "مواقف - التابعين - وأتباعهم - في - الدعوة - إلى - الله", "author": "تعالى", "source": "PDFnew", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/PDFnew/112224"}, {"title": "منهجية السير إلى الله", "author": "", "source": "baz_book", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/baz_book/24179"}, {"title": "منهج - السلف - في - العقيدة - وأثره - في - وحدة - المسلمين - للعلامة - صالح - بن", "author": "سعد", "source": "tahmilkutubwarosaililmiyah", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/tahmilkutubwarosaililmiyah/4948"}, {"title": "من مشاهير أعلام المسلمين", "author": "", "source": "KOTOB_ISLAMIC", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/KOTOB_ISLAMIC/265649"}, {"title": "مكة ١٥ نوفمبر", "author": "", "source": "arabJournalism", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/arabJournalism/251297"}, {"title": "معجم - المطبوعات - العربية - والمعربة - اليان", "author": "سركيس", "source": "All_kinds_Books_Lib", "format": "DOCX", "date": "2026-11-15", "url": "https://t.me/All_kinds_Books_Lib/1171311"}, {"title": "معجم - المطبوعات - العربية - في - المملكة - العربية - السعودية - ج - 4 - د - علي", "author": "جواد", "source": "All_kinds_Books_Lib", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/All_kinds_Books_Lib/1171310"}, {"title": "معجم - المطبوعات - العربية - في - المملكة - العربية - السعودية - ج - 3 - د - علي", "author": "جواد", "source": "All_kinds_Books_Lib", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/All_kinds_Books_Lib/1171309"}, {"title": "معجم - المطبوعات - العربية - في - المملكة - العربية - السعودية - ج - 2 - د - علي", "author": "جواد", "source": "All_kinds_Books_Lib", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/All_kinds_Books_Lib/1171308"}, {"title": "معجم - المطبوعات - العربية - في - المملكة - العربية - السعودية - ج - 1 - د - علي", "author": "جواد", "source": "All_kinds_Books_Lib", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/All_kinds_Books_Lib/1171307"}, {"title": "معتقدات وأفكار", "author": "", "source": "safi_book", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/safi_book/14237"}, {"title": "مزرعة الحيوان", "author": "جورج أورويل", "source": "Book_cr2", "format": "EPUB", "date": "2026-11-15", "url": "https://t.me/Book_cr2/68690"}, {"title": "مزرعة - الحيوان - جورج", "author": "أورويل", "source": "Book_cr2", "format": "PDF", "date": "2026-11-15", "url": "https://t.me/Book_cr2/68689"}]};

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

function mockFetch(jsonData, ok = true, status = 200, liveValue = null) {
  globalThis.fetch = async (input) => {
    const u = String(input);
    if (u.includes("/api/live-state")) {
      // Bot Worker endpoint: null = the DO key was never written
      // (404 -> the page falls back to the legacy KV copy).
      if (liveValue === null) {
        return { ok: false, status: 404, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => liveValue };
    }
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

async function get(path, kvValue, newest = NEWEST, kvOverride, liveValue = null) {
  mockFetch(newest, newest !== null, 200, liveValue);
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
  check("1 send button present (bot deep link send_<handle>_<post>)",
    text.includes("https://t.me/RliBook_bot?start=send_")
    && text.includes("أرسل لميل قارئي"));
  check("1 NO direct /api/send-to-kindle link anywhere (bot handoff, 2026-11-21)",
    !text.includes("/api/send-to-kindle"));
  check("1 no colour emoji on the page (F3: old Kindle shows tofu)",
    !text.includes("📧") && !text.includes("📚") && !text.includes("⚑") && !text.includes("🆕"));
  check("1 NO direct-download link anywhere (removed from /book 2026-11-13; /new never had one)",
    !text.includes("تنزيل مباشر")
    && !text.includes("drive.google.com/uc?id=")
    && !text.includes("direct download"));
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

// 2. Live books prepended + de-duplicated by URL — from the
// legacy KV copy while the live-state endpoint has no value yet.
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

// 2b. Live-state endpoint value wins over the legacy KV copy.
{
  const liveBook = {
    title: "كتاب لحظي من البوت",
    author: "مؤلف لحظي",
    source: "SomeChannel",
    format: "epub",
    date: "2026-11-12",
    url: "https://t.me/SomeChannel/998",
    added_at: "2026-11-12T15:00:00+00:00",
  };
  const liveValue = JSON.stringify({
    since: "2026-11-12T00:00:00+00:00",
    books: [liveBook],
  });
  const kvValue = JSON.stringify({
    since: "2026-11-12T00:00:00+00:00",
    books: [{
      title: "كتاب لحظي قديم من KV",
      author: "مؤلف قديم",
      source: "OldChannel",
      format: "epub",
      date: "2026-11-11",
      url: "https://t.me/OldChannel/997",
      added_at: "2026-11-11T15:00:00+00:00",
    }],
  });
  const { text } = await get("/new", kvValue, NEWEST, undefined, liveValue);
  check("2b endpoint book first",
    text.indexOf("كتاب لحظي من البوت") !== -1
    && text.indexOf("كتاب لحظي من البوت") < text.indexOf(NEWEST.books[0].title));
  check("2b KV copy ignored when the endpoint answers",
    !text.includes("كتاب لحظي قديم من KV"));
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

// 6. Malformed live value -> ignored, static list still renders.
{
  const { text } = await get("/new", "not-json{{");
  check("6 malformed live value ignored", text.includes(NEWEST.books[0].title));
}

// 7. Flagged books (KV denylist) + send-URL helpers + fp passthrough.
{
  // Pinned fixture: the flagged book must be IN the shown list. The
  // live newest.json rotates daily, so its first book is no longer
  // books_p/11692 — pin the flagged book first instead of assuming
  // the fixture's order (Workstream H: test-only fix, no page change).
  const flaggedFirst = { title: "كتاب مُعلَّم تجريبي", author: "مؤلف تجريبي",
    source: "books_p", format: "PDF", date: "2026-11-16",
    url: "https://t.me/books_p/11692" };
  const pinned = { ...NEWEST, count: 30,
    books: [flaggedFirst, ...NEWEST.books.slice(0, 29)] };
  const first = pinned.books[0]; // https://t.me/books_p/11692
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
  const { text } = await get("/new", null, pinned, kv);
  check("7 flagged: 🚩 flag on the flagged book, no 'تجاري' word (P1/P2 wording)",
    text.includes("🚩") && !text.includes("تجاري"));
  check("7 flagged: NO send button for the flagged book", !text.includes("p=11692"));
  check("7 flagged: one-line bot explanation, no reading",
    text.includes("🚩 هذا الكتاب عليه علامة")
    && text.includes("الموقع لا يتيح تحميله أو إرساله")
    && text.includes("قناة النشر")
    && text.includes("@RliBook_bot"));
  check("7 flagged: reason comes BEFORE the bot direction",
    text.indexOf("🚩 هذا الكتاب عليه علامة") !== -1
    && text.indexOf("🚩 هذا الكتاب عليه علامة") < text.indexOf("قناة النشر"));
  check("7 flagged: other books still have send buttons",
    text.includes("https://t.me/RliBook_bot?start=send_"));
  check("7 flag check cost: one KV get per shown book (30)",
    flagGets === 30, "flag gets=" + flagGets);
}
{
  // Bot handoff (2026-11-21): the send URL is the bot deep link and
  // carries NO fingerprint — the bot identifies the user in Telegram
  // itself. A ?fp= on the page URL must never leak into any href.
  const { text } = await get("/new?fp=FP123", null);
  check("7 fp never leaks into send URLs (bot identifies the user)",
    text.includes("https://t.me/RliBook_bot?start=send_")
    && !text.includes("FP123"));
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
    { title: "T", format: "PDF", url: "https://t.me/s/5" });
  check("7 send URL: bot deep link send_<handle>_<post>",
    u === "https://t.me/RliBook_bot?start=send_s_5", u);
  check("7 send URL: flagged book object -> null",
    telegramSendUrl({ title: "T", format: "PDF", url: "https://t.me/s/5", flagged: true }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
