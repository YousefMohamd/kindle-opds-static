// Test for the client-side converter's pure logic
// (site/convert/ocr-client.js). Standalone Node script — run from the
// repo root:
//   node site/convert/convert.test.mjs
//
// No network, no browser, no deploy. Exit 0 = all pass.
// What it asserts (the OCR behaviour proven live 2026-11-16 on real
// scans — see docs/ocr-conversion.md):
//   A. countScripts / detectPageScript: Arabic vs Latin vs mixed vs
//      empty, with the same thresholds as the bot (ocr-lang.ts) and
//      the converter (server.py).
//   B. isDiacriticRich: tashkeel density (and the honest note that
//      Tesseract strips tashkeel, so the client probe cannot see
//      it — the ar-classical override is the reliable path).
//   C. routePage: AR -> baseer, EN -> pp-ocrv6, mixed -> baseer +
//      pp-ocrv6; overrides ar / ar-classical (Qari) / en force the
//      engine while a Latin page under ar-classical stays pp-ocrv6.
//   D. tesseractLangsForOverride: the browser runs Tesseract, not
//      the GPU engines — auto loads ara+eng, ar/ar-classical load
//      ara, en loads eng.
//   E. cleanOcrText: control chars, form feeds, space collapsing,
//      empty lines at the edges.
//   F. splitLineByScript: mixed lines split into Arabic/Latin runs
//      with the right dir on each run.
//   G. splitChapters: a heading on page 1 names the first chapter
//      (no "Start" chapter); later headings split.
//   H. buildEpubParts: OPF carries dc:language (ar/en/mixed),
//      nav + chapters exist, Arabic pages get dir="rtl".
//   I. sha256Hex matches node:crypto; cacheKey is stable for the
//      same bytes and differs for different bytes (IndexedDB
//      resume key).
//   J. Mini App send-to-Kindle contract (bot-only, 2026-11-16):
//      endpoint URL exact, Arabic error messages for all five
//      bot error codes (+ unknown-code fallback), initData
//      detection, payload shape (exactly the three fields the bot
//      expects).
//   K. Cloud enhancement queue (2026-11-17, enhance-queue.js):
//      which pages qualify, language hints, enhancePage against a
//      mock endpoint (success / 429 quota / 500 / timeout /
//      empty text / oversize image), and runEnhancementQueue
//      (success-replace, quota stops the queue, other failures
//      only skip that page, non-qualifying pages never sent).
//   L. Convert-button Mini App wiring (v4.8.47): the bot's
//      ?h=&p=&f=pdf&ticket= URL params, the /api/dl-token URL,
//      the send payload's ticket/pages/quality extras, the
//      started/failed status pings, E_TOO_MANY_PAGES, and the
//      500-page cap.
//   M. OCR.space tier (2026-11-18, ocr-space.js): the free
//      per-user OCR API — language mapping, response parsing
//      (success / empty / quota / timeout / parse error), the
//      multipart POST (apikey header, FormData fields), 429/403
//      quota, oversize image never sent, no key never sent.
//      The demo key "helloworld" is used ONLY here in tests.
//   N. Smart routing (mean confidence): the 75 threshold, the
//      mean of Tesseract word confidences, strong pages keep
//      Tesseract, weak pages go to the tiers, missing confidence
//      (resumed jobs) counts as weak, blank pages never sent.
//   O. Tiered queue + content-hash cache (enhance-queue.js):
//      cache hit skips both network tiers, OCR.space wins and
//      is cached, OCR.space failure falls through to GPU, Qari
//      pages skip OCR.space, no tiers -> no-tier, per-tier quota
//      disables only that tier, strong pages never attempted,
//      second run is all cache hits (zero network).
//   P. No direct download + fair use (2026-11-18): the converter
//      page offers NO EPUB download (website rule — delivery is by
//      email or via the bot); the send path carries E_FAIR_USE with
//      the wait in minutes, and the catalog flow shows
//      "جارٍ التجهيز…" and auto-sends to the reader email.
import * as O from "./ocr-client.js";
import * as Q from "./enhance-queue.js";
import * as S from "./ocr-space.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const pending = [];
function check(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        pass++;
        console.log("  PASS " + name);
      } catch (e) {
        fail++;
        console.log("  FAIL " + name + " — " + e.message);
      }
    })()
  );
}
function eq(a, b, msg) {
  assert.deepEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const AR = "بسم الله الرحمن الرحيم الحمد لله رب العالمين والصلاة والسلام على رسول الله";
const EN = "It was a bright cold day in April and the clocks were striking thirteen";
const AR_DIACRITIC = "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ";
const MIXED = AR + " " + EN;

console.log("A. script detection");
check("Arabic page -> arabic", () => eq(O.detectPageScript(AR), "arabic"));
check("English page -> latin", () => eq(O.detectPageScript(EN), "latin"));
check("mixed page -> mixed", () => eq(O.detectPageScript(MIXED), "mixed"));
check("empty / digits -> unknown", () => eq(O.detectPageScript("123 456"), "unknown"));
check("countScripts counts Arabic range", () => {
  const c = O.countScripts(AR);
  assert.ok(c.arabic > 40 && c.latin === 0, JSON.stringify(c));
});

console.log("B. diacritic detection");
check("tashkeel-rich text is diacritic-rich", () => eq(O.isDiacriticRich(AR_DIACRITIC), true));
check("plain modern Arabic is not", () => eq(O.isDiacriticRich(AR), false));
check("English is not", () => eq(O.isDiacriticRich(EN), false));
check("Tesseract-stripped words are not (probe cannot see tashkeel)", () => {
  // Tesseract returns the words without tashkeel — see docs.
  eq(O.isDiacriticRich("بسم الله الرحمن الرحيم الحمد لله"), false);
});

console.log("C. routing");
check("Arabic page -> baseer", () => eq(O.routePage(AR).engine, "baseer"));
check("English page -> pp-ocrv6", () => eq(O.routePage(EN).engine, "pp-ocrv6"));
check("mixed page -> baseer + pp-ocrv6", () => {
  const r = O.routePage(MIXED);
  eq(r.engine, "baseer");
  eq(r.also, "pp-ocrv6");
});
check("override ar forces baseer even on Latin text", () => eq(O.routePage(EN, "ar").engine, "baseer"));
check("override ar-classical forces qari on Arabic", () => eq(O.routePage(AR, "ar-classical").engine, "qari"));
check("override ar-classical keeps pp-ocrv6 on Latin", () => eq(O.routePage(EN, "ar-classical").engine, "pp-ocrv6"));
check("override en forces pp-ocrv6 on Arabic", () => eq(O.routePage(AR, "en").engine, "pp-ocrv6"));
check("diacritic-rich page routes to qari without override", () => eq(O.routePage(AR_DIACRITIC).engine, "qari"));
// The engine-table accuracy guards (no 96.33%, Baidu not the
// Arabic default) live in the bot suite, test/ocr-lang.test.ts —
// the website has no engine table of its own; routePage names the
// target engine and the browser runs Tesseract for it.

console.log("D. Tesseract language mapping");
check("auto -> ara+eng", () => eq(O.tesseractLangsForOverride("auto"), "ara+eng"));
check("ar -> ara", () => eq(O.tesseractLangsForOverride("ar"), "ara"));
check("ar-classical -> ara", () => eq(O.tesseractLangsForOverride("ar-classical"), "ara"));
check("en -> eng", () => eq(O.tesseractLangsForOverride("en"), "eng"));
check("unknown override -> ara+eng", () => eq(O.tesseractLangsForOverride("xx"), "ara+eng"));

console.log("E. text cleanup");
check("strips form feeds and control chars", () => {
  eq(O.cleanOcrText("a\f b\x01 c"), "a b c");
});
check("collapses blank lines and trims", () => {
  eq(O.cleanOcrText("\n\nhello\n\n\nworld\n\n"), "hello\nworld");
});

console.log("F. mixed-line splitting");
check("mixed line splits into rtl + ltr runs", () => {
  const parts = O.splitLineByScript("السلام hello world");
  eq(parts.length, 2);
  eq(parts[0].script, "arabic");
  eq(parts[1].script, "latin");
});
check("pure Arabic line is one rtl run", () => {
  const parts = O.splitLineByScript("السلام عليكم");
  eq(parts.length, 1);
  eq(parts[0].script, "arabic");
});

console.log("G. chapter splitting");
check("heading on page 1 names the first chapter", () => {
  const pages = [
    { n: 1, text: "المقدمة\nنص البداية", script: "arabic" },
    { n: 2, text: "نص آخر", script: "arabic" },
  ];
  const ch = O.splitChapters(pages);
  eq(ch.length, 1);
  eq(ch[0].title, "المقدمة");
});
check("later heading splits a chapter", () => {
  const pages = [
    { n: 1, text: "المقدمة\nنص", script: "arabic" },
    { n: 2, text: "الفصل الأول\nنص آخر", script: "arabic" },
  ];
  const ch = O.splitChapters(pages);
  eq(ch.length, 2);
  eq(ch[1].title, "الفصل الأول");
});

console.log("H. EPUB parts");
check("Arabic book: OPF language ar, chapters rtl", () => {
  const parts = O.buildEpubParts("كتاب تجريبي", [
    { n: 1, text: AR, script: "arabic" },
  ]);
  assert.ok(parts.opf.includes('<dc:language>ar</dc:language>'), parts.opf);
  assert.ok(parts.chapters[0].xhtml.includes('dir="rtl"'), parts.chapters[0].xhtml);
  assert.ok(parts.nav.includes("nav.xhtml") || parts.nav.includes("toc"), parts.nav);
});
check("English book: OPF language en, chapters ltr", () => {
  const parts = O.buildEpubParts("Test Book", [
    { n: 1, text: EN, script: "latin" },
  ]);
  assert.ok(parts.opf.includes('<dc:language>en</dc:language>'), parts.opf);
  assert.ok(parts.chapters[0].xhtml.includes('dir="ltr"'), parts.chapters[0].xhtml);
});
check("mixed book: OPF language en (converter parity, valid BCP47)", () => {
  const parts = O.buildEpubParts("Mixed", [
    { n: 1, text: AR, script: "arabic" },
    { n: 2, text: EN, script: "latin" },
  ]);
  assert.ok(parts.opf.includes('<dc:language>en</dc:language>'), parts.opf);
  eq(parts.chapters.length, 1);
});
check("mixed book: Arabic page content is still wrapped rtl", () => {
  const xhtml = O.pageToXhtml({ n: 1, text: AR, script: "arabic" });
  assert.ok(xhtml.includes('dir="rtl"'), xhtml);
});

console.log("I. hashing");
check("sha256Hex matches node:crypto", async () => {
  const hex = await O.sha256Hex(new TextEncoder().encode("abc"));
  eq(hex, createHash("sha256").update("abc").digest("hex"));
});
check("cacheKey stable and sensitive", async () => {
  const a = await O.cacheKey(new Uint8Array([1, 2, 3]));
  const b = await O.cacheKey(new Uint8Array([1, 2, 3]));
  const c = await O.cacheKey(new Uint8Array([1, 2, 4]));
  eq(a, b);
  assert.notEqual(a, c);
});

console.log("J. Mini App send-to-Kindle contract (bot-only)");
check("send endpoint URL is the bot miniapp-convert-send", () => {
  eq(O.MINIAPP_CONVERT_SEND_URL, "https://rlibook-bot.mohamedyou1357.workers.dev/miniapp-convert-send");
});
check("send size limit is 20 MB", () => eq(O.MINIAPP_SEND_MAX_EPUB_BYTES, 20 * 1024 * 1024));
check("E_NO_EMAIL -> link your Kindle email in the bot first", () => {
  const m = O.miniappSendErrorMessage("E_NO_EMAIL");
  assert.ok(m.includes("إيميل الكيندل") && m.includes("البوت"), m);
});
check("E_LIMIT -> you used your 3 conversions for today", () => {
  const m = O.miniappSendErrorMessage("E_LIMIT");
  assert.ok(m.includes("الثلاثة") && m.includes("اليوم"), m);
});
check("E_BAD_INITDATA -> open the converter from the bot again", () => {
  const m = O.miniappSendErrorMessage("E_BAD_INITDATA");
  assert.ok(m.includes("البوت") && m.includes("/convert"), m);
});
check("E_TOO_BIG -> the EPUB is over 20 MB", () => {
  const m = O.miniappSendErrorMessage("E_TOO_BIG");
  assert.ok(m.includes("20 MB"), m);
});
check("E_SEND_FAILED -> sending failed, conversion not counted", () => {
  const m = O.miniappSendErrorMessage("E_SEND_FAILED");
  assert.ok(m.includes("حاول مجدداً") && m.includes("لم يُحتسب"), m);
});
check("unknown code -> generic retry message", () => {
  const m = O.miniappSendErrorMessage("E_WHATEVER");
  assert.ok(m.length > 0 && m.includes("حاول مجدداً"), m);
});
check("initData detection: non-empty string only", () => {
  eq(O.isTelegramWebAppInitData("query_id=abc&user=1"), true);
  eq(O.isTelegramWebAppInitData(""), false);
  eq(O.isTelegramWebAppInitData(undefined), false);
  eq(O.isTelegramWebAppInitData(null), false);
  eq(O.isTelegramWebAppInitData(123), false);
});
check("payload has exactly initData + filename + epubBase64", () => {
  const p = O.buildMiniappSendPayload("INIT", "book.epub", "UEsDBA==");
  eq(Object.keys(p).sort(), ["epubBase64", "filename", "initData"]);
  eq(p.initData, "INIT");
  eq(p.filename, "book.epub");
  eq(p.epubBase64, "UEsDBA==");
});

console.log("K. Cloud enhancement queue (enhance-queue.js)");
// Mock fetch helpers: a Response-like object, and a fetch that
// never answers (for the timeout test).
function mockResponse(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}
function mockFetchFor(responses) {
  // responses: array of { status, data } consumed in order, or a
  // single response reused. Records every call's URL + headers.
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, headers: (init && init.headers) || {} });
    const r = list[Math.min(i++, list.length - 1)];
    return mockResponse(r.status, r.data);
  };
  fn.calls = calls;
  return fn;
}
const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // tiny PNG header
const AR_PAGE = { n: 1, text: AR, script: "arabic", route: O.routePage(AR) };
const EN_PAGE = { n: 2, text: EN, script: "latin", route: O.routePage(EN) };
const MIXED_PAGE = { n: 3, text: MIXED, script: "mixed", route: O.routePage(MIXED) };

check("Arabic page qualifies (baseer)", () => eq(Q.pageQualifiesForEnhancement(AR_PAGE), true));
check("mixed page qualifies (baseer + pp-ocrv6)", () => eq(Q.pageQualifiesForEnhancement(MIXED_PAGE), true));
check("Latin page does NOT qualify in auto mode", () => eq(Q.pageQualifiesForEnhancement(EN_PAGE), false));
check("Latin page qualifies when override is en", () => eq(Q.pageQualifiesForEnhancement(EN_PAGE, "en"), true));
check("Arabic page qualifies under ar-classical (qari)", () => eq(Q.pageQualifiesForEnhancement(AR_PAGE, "ar-classical"), true));
check("qualify works from text alone (no precomputed route)", () => {
  eq(Q.pageQualifiesForEnhancement({ text: AR }), true);
  eq(Q.pageQualifiesForEnhancement({ text: EN }), false);
});

check("hint: override ar wins", () => eq(Q.languageHintForPage(EN_PAGE, "ar"), "ar"));
check("hint: override ar-classical wins", () => eq(Q.languageHintForPage(AR_PAGE, "ar-classical"), "ar-classical"));
check("hint: override en wins", () => eq(Q.languageHintForPage(AR_PAGE, "en"), "en"));
check("hint: Arabic page -> ar", () => eq(Q.languageHintForPage(AR_PAGE), "ar"));
check("hint: Latin page -> en", () => eq(Q.languageHintForPage(EN_PAGE), "en"));
check("hint: mixed page -> mixed", () => eq(Q.languageHintForPage(MIXED_PAGE), "mixed"));
check("hint: empty page -> auto", () => eq(Q.languageHintForPage({ text: "" }), "auto"));

check("enhancePage success returns cleaned text + engine", async () => {
  const fetchFn = mockFetchFor({
    status: 200,
    data: { ok: true, text: "  نص محسّن\n\n", engine: "qari", confidence: null, lang: "ar" },
  });
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test/", image: IMG, langHint: "ar" });
  eq(r.ok, true);
  eq(r.text, "نص محسّن");
  eq(r.engine, "qari");
  eq(r.lang, "ar");
  eq(fetchFn.calls.length, 1);
  eq(fetchFn.calls[0].url, "https://example.test/enhance-page");
  eq(fetchFn.calls[0].headers["X-Convert-Language"], "ar");
});
check("enhancePage 429 -> quota", async () => {
  const fetchFn = mockFetchFor({ status: 429, data: { ok: false, error: "daily budget" } });
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test", image: IMG });
  eq(r, { ok: false, reason: "quota" });
});
check("enhancePage 500 -> unavailable", async () => {
  const fetchFn = mockFetchFor({ status: 500, data: { ok: false } });
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test", image: IMG });
  eq(r, { ok: false, reason: "unavailable" });
});
check("enhancePage network throw -> unavailable", async () => {
  const fetchFn = async () => {
    throw new Error("conn refused");
  };
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test", image: IMG });
  eq(r, { ok: false, reason: "unavailable" });
});
check("enhancePage timeout -> timeout", async () => {
  const fetchFn = () => new Promise(() => {}); // never answers
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test", image: IMG, timeoutMs: 50 });
  eq(r, { ok: false, reason: "timeout" });
});
check("enhancePage empty text -> empty", async () => {
  const fetchFn = mockFetchFor({ status: 200, data: { ok: true, text: "   \n ", engine: "pp-ocrv6", confidence: 0.9, lang: "en" } });
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test", image: IMG });
  eq(r, { ok: false, reason: "empty" });
});
check("enhancePage oversize image never sent -> too-big", async () => {
  const big = new Uint8Array(Q.ENHANCE_PAGE_MAX_IMAGE_BYTES + 1);
  let called = 0;
  const fetchFn = async () => {
    called++;
    return mockResponse(200, { ok: true, text: "x" });
  };
  const r = await Q.enhancePage({ fetchFn, baseUrl: "https://example.test", image: big });
  eq(r, { ok: false, reason: "too-big" });
  eq(called, 0);
});

check("queue: success replaces text, non-qualifying page never sent", async () => {
  const fetchFn = mockFetchFor({ status: 200, data: { ok: true, text: "نص محسّن", engine: "baseer", confidence: null, lang: "ar" } });
  const enhanced = [];
  const skipped = [];
  const summary = await Q.runEnhancementQueue({
    fetchFn,
    baseUrl: "https://example.test",
    pages: [AR_PAGE, EN_PAGE],
    getImage: async () => IMG,
    onPageEnhanced: (page, result) => enhanced.push([page.n, result.text]),
    onPageSkipped: (page, reason) => skipped.push([page.n, reason]),
  });
  eq(summary, { attempted: 1, enhanced: 1, skipped: 0, stoppedOnQuota: false });
  eq(enhanced, [[1, "نص محسّن"]]);
  eq(skipped, []);
  eq(fetchFn.calls.length, 1); // the Latin page was never sent
});
check("queue: quota stops the queue after the first 429", async () => {
  const fetchFn = mockFetchFor([
    { status: 200, data: { ok: true, text: "أول صفحة محسّنة", engine: "baseer", confidence: null, lang: "ar" } },
    { status: 429, data: { ok: false, error: "daily budget" } },
  ]);
  const pages = [
    { n: 1, text: AR, script: "arabic", route: O.routePage(AR) },
    { n: 2, text: AR, script: "arabic", route: O.routePage(AR) },
    { n: 3, text: AR, script: "arabic", route: O.routePage(AR) },
  ];
  const enhanced = [];
  const summary = await Q.runEnhancementQueue({
    fetchFn,
    baseUrl: "https://example.test",
    pages,
    getImage: async () => IMG,
    onPageEnhanced: (page, result) => enhanced.push(page.n),
  });
  eq(summary, { attempted: 2, enhanced: 1, skipped: 1, stoppedOnQuota: true });
  eq(enhanced, [1]);
  eq(fetchFn.calls.length, 2); // page 3 never attempted
});
check("queue: a failed page is skipped and the queue goes on", async () => {
  const fetchFn = mockFetchFor([
    { status: 500, data: { ok: false } },
    { status: 200, data: { ok: true, text: "صفحة ثانية محسّنة", engine: "qari", confidence: null, lang: "ar" } },
  ]);
  const pages = [
    { n: 1, text: AR, script: "arabic", route: O.routePage(AR) },
    { n: 2, text: AR_DIACRITIC, script: "arabic", route: O.routePage(AR_DIACRITIC) },
  ];
  const enhanced = [];
  const skipped = [];
  const summary = await Q.runEnhancementQueue({
    fetchFn,
    baseUrl: "https://example.test",
    pages,
    getImage: async () => IMG,
    onPageEnhanced: (page) => enhanced.push(page.n),
    onPageSkipped: (page, reason) => skipped.push([page.n, reason]),
  });
  eq(summary, { attempted: 2, enhanced: 1, skipped: 1, stoppedOnQuota: false });
  eq(enhanced, [2]);
  eq(skipped, [[1, "unavailable"]]);
});
check("queue: getImage failure skips that page only", async () => {
  const fetchFn = mockFetchFor({ status: 200, data: { ok: true, text: "ok", engine: "baseer", confidence: null, lang: "ar" } });
  const pages = [
    { n: 1, text: AR, script: "arabic", route: O.routePage(AR) },
    { n: 2, text: AR, script: "arabic", route: O.routePage(AR) },
  ];
  const summary = await Q.runEnhancementQueue({
    fetchFn,
    baseUrl: "https://example.test",
    pages,
    getImage: async (page) => {
      if (page.n === 1) throw new Error("render failed");
      return IMG;
    },
  });
  eq(summary, { attempted: 2, enhanced: 1, skipped: 1, stoppedOnQuota: false });
});

console.log("L. Convert-button Mini App wiring (v4.8.47)");
check("parseConvertBookParams: a Convert tap URL parses", () => {
  eq(
    O.parseConvertBookParams("?h=khazendar&p=12345&f=pdf&ticket=abcdef0123456789"),
    { handle: "khazendar", postId: "12345", format: "pdf", ticket: "abcdef0123456789" },
  );
});
check("parseConvertBookParams: plain /convert and bad params -> null", () => {
  eq(O.parseConvertBookParams(""), null);
  eq(O.parseConvertBookParams("?"), null);
  eq(O.parseConvertBookParams("?h=khazendar&p=abc&f=pdf&ticket=abcdef0123456789"), null);
  eq(O.parseConvertBookParams("?h=khazendar&p=12345&f=epub&ticket=abcdef0123456789"), null);
  eq(O.parseConvertBookParams("?h=khazendar&p=12345&f=pdf&ticket=zz"), null);
  eq(O.parseConvertBookParams("?p=12345&f=pdf&ticket=abcdef0123456789"), null);
});
check("convertBookDlTokenUrl: the Telegram dl-token URL", () => {
  eq(
    O.convertBookDlTokenUrl({ handle: "khazendar", postId: "12345", format: "pdf" }),
    "/api/dl-token?lib=tg&h=khazendar&p=12345&f=pdf",
  );
});
check("buildMiniappSendPayload: plain shape unchanged without extras", () => {
  eq(O.buildMiniappSendPayload("id", "b.epub", "AAA="), {
    initData: "id",
    filename: "b.epub",
    epubBase64: "AAA=",
  });
});
check("buildMiniappSendPayload: Convert extras ride along when valid", () => {
  eq(
    O.buildMiniappSendPayload("id", "b.epub", "AAA=", {
      ticket: "abcdef0123456789",
      pages: 42,
      quality: "enhanced",
    }),
    {
      initData: "id",
      filename: "b.epub",
      epubBase64: "AAA=",
      ticket: "abcdef0123456789",
      pages: 42,
      quality: "enhanced",
    },
  );
});
check("buildMiniappSendPayload: invalid extras are dropped, never trusted", () => {
  eq(
    O.buildMiniappSendPayload("id", "b.epub", "AAA=", {
      ticket: "not-a-ticket",
      pages: -5,
      quality: "standard",
    }),
    { initData: "id", filename: "b.epub", epubBase64: "AAA=" },
  );
});
check("buildMiniappStatusPayload: started / failed pings", () => {
  eq(O.buildMiniappStatusPayload("id", "abcdef0123456789", "started"), {
    initData: "id",
    ticket: "abcdef0123456789",
    status: "started",
  });
  eq(
    O.buildMiniappStatusPayload("id", "abcdef0123456789", "failed", "too many pages: 250"),
    {
      initData: "id",
      ticket: "abcdef0123456789",
      status: "failed",
      error: "too many pages: 250",
    },
  );
});
check("miniappSendErrorMessage: E_TOO_MANY_PAGES has a message", () => {
  const msg = O.miniappSendErrorMessage("E_TOO_MANY_PAGES");
  assert.ok(msg.includes("500"), msg);
});
check("CONVERT_MAX_PAGES is 500", () => eq(O.CONVERT_MAX_PAGES, 500));

console.log("M. OCR.space tier (ocr-space.js)");
// A mock fetch that records url + headers + body (FormData) and
// answers with a canned OCR.space JSON response.
function mockOcrSpaceFetch(response, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: (init && init.headers) || {}, body: init ? init.body : null });
    return mockResponse(status, response);
  };
  fn.calls = calls;
  return fn;
}
const OCR_OK = {
  ParsedResults: [{ FileParseExitCode: "1", ParsedText: "  نص من OCR.space\n\n", ErrorMessage: null, ErrorDetails: null }],
  OCRExitCode: "1",
  IsErroredOnProcessing: false,
  ErrorMessage: null,
  ErrorDetails: null,
};

check("ocrSpaceLanguageForPage: overrides + script", () => {
  // E201 REGRESSION (2026-11-18): the live API rejects "ara" — Arabic
  // pages must send "auto" (Engine 2 auto-detects the script).
  eq(S.ocrSpaceLanguageForPage(AR_PAGE, "ar"), "auto");
  eq(S.ocrSpaceLanguageForPage(AR_PAGE, "ar-classical"), "auto");
  eq(S.ocrSpaceLanguageForPage(AR_PAGE, "en"), "eng");
  eq(S.ocrSpaceLanguageForPage(AR_PAGE), "auto");
  eq(S.ocrSpaceLanguageForPage(EN_PAGE), "eng");
  eq(S.ocrSpaceLanguageForPage(MIXED_PAGE), "auto");
  eq(S.ocrSpaceLanguageForPage({ text: "" }), "auto");
});

check("parseOcrSpaceResponse: success (string + numeric exit code)", () => {
  const r1 = S.parseOcrSpaceResponse(OCR_OK);
  eq(r1.ok, true);
  eq(r1.text, "نص من OCR.space");
  eq(r1.engine, "ocr-space");
  const r2 = S.parseOcrSpaceResponse({
    ParsedResults: [{ FileParseExitCode: 1, ParsedText: "hello", ErrorMessage: null }],
    OCRExitCode: 1,
    IsErroredOnProcessing: false,
  });
  eq(r2.ok, true);
  eq(r2.text, "hello");
});
check("parseOcrSpaceResponse: empty text -> empty", () => {
  eq(S.parseOcrSpaceResponse({
    ParsedResults: [{ FileParseExitCode: "1", ParsedText: "   \n ", ErrorMessage: null }],
    OCRExitCode: "1",
    IsErroredOnProcessing: false,
  }), { ok: false, reason: "empty" });
});
check("parseOcrSpaceResponse: limit error -> quota", () => {
  eq(S.parseOcrSpaceResponse({
    ParsedResults: [],
    OCRExitCode: "4",
    IsErroredOnProcessing: true,
    ErrorMessage: "Your free API key has reached the limit of 500 requests per day",
    ErrorDetails: "",
  }), { ok: false, reason: "quota" });
});
check("parseOcrSpaceResponse: other processing error -> unavailable", () => {
  eq(S.parseOcrSpaceResponse({
    ParsedResults: [],
    OCRExitCode: "4",
    IsErroredOnProcessing: true,
    ErrorMessage: "Some internal error",
    ErrorDetails: "",
  }), { ok: false, reason: "unavailable" });
});
check("parseOcrSpaceResponse: -20 timeout, -10 parse error, no results", () => {
  eq(S.parseOcrSpaceResponse({
    ParsedResults: [{ FileParseExitCode: "-20", ParsedText: null, ErrorMessage: "timeout" }],
    OCRExitCode: "3",
    IsErroredOnProcessing: false,
  }), { ok: false, reason: "timeout" });
  eq(S.parseOcrSpaceResponse({
    ParsedResults: [{ FileParseExitCode: "-10", ParsedText: null, ErrorMessage: "parse" }],
    OCRExitCode: "3",
    IsErroredOnProcessing: false,
  }), { ok: false, reason: "unavailable" });
  eq(S.parseOcrSpaceResponse({ ParsedResults: [], OCRExitCode: "3", IsErroredOnProcessing: false }), { ok: false, reason: "unavailable" });
  eq(S.parseOcrSpaceResponse(null), { ok: false, reason: "unavailable" });
});

check("ocrSpacePage: success posts multipart to api.ocr.space with apikey header", async () => {
  const fetchFn = mockOcrSpaceFetch(OCR_OK);
  // langHint "auto" is what the fixed language function sends for Arabic
  // pages (E201: the live API rejects "ara").
  const r = await S.ocrSpacePage({ fetchFn, apiKey: "helloworld", image: IMG, langHint: "auto" });
  eq(r.ok, true);
  eq(r.text, "نص من OCR.space");
  eq(r.engine, "ocr-space");
  eq(fetchFn.calls.length, 1);
  eq(fetchFn.calls[0].url, "https://api.ocr.space/parse/image");
  eq(fetchFn.calls[0].headers.apikey, "helloworld");
  const body = fetchFn.calls[0].body;
  eq(body.get("language"), "auto");
  eq(body.get("OCREngine"), "2");
  eq(body.get("isOverlayRequired"), "false");
  eq(body.get("scale"), "true");
  const file = body.get("file");
  assert.ok(file instanceof Blob, "file part is a Blob");
  eq(file.size, IMG.length);
});
check("ocrSpacePage: 429 and 403 -> quota", async () => {
  const f1 = mockOcrSpaceFetch({ ErrorMessage: "limit" }, 429);
  eq(await S.ocrSpacePage({ fetchFn: f1, apiKey: "helloworld", image: IMG }), { ok: false, reason: "quota" });
  const f2 = mockOcrSpaceFetch({ ErrorMessage: "forbidden" }, 403);
  eq(await S.ocrSpacePage({ fetchFn: f2, apiKey: "helloworld", image: IMG }), { ok: false, reason: "quota" });
});
check("ocrSpacePage: 500 -> unavailable, network throw -> unavailable", async () => {
  const f1 = mockOcrSpaceFetch({ ErrorMessage: "x" }, 500);
  eq(await S.ocrSpacePage({ fetchFn: f1, apiKey: "helloworld", image: IMG }), { ok: false, reason: "unavailable" });
  const f2 = async () => {
    throw new Error("conn refused");
  };
  eq(await S.ocrSpacePage({ fetchFn: f2, apiKey: "helloworld", image: IMG }), { ok: false, reason: "unavailable" });
});
check("ocrSpacePage: timeout -> timeout", async () => {
  const fetchFn = () => new Promise(() => {}); // never answers
  const r = await S.ocrSpacePage({ fetchFn, apiKey: "helloworld", image: IMG, timeoutMs: 50 });
  eq(r, { ok: false, reason: "timeout" });
});
check("ocrSpacePage: oversize image never sent -> too-big", async () => {
  const big = new Uint8Array(S.OCR_SPACE_MAX_IMAGE_BYTES + 1);
  let called = 0;
  const fetchFn = async () => {
    called++;
    return mockResponse(200, OCR_OK);
  };
  eq(await S.ocrSpacePage({ fetchFn, apiKey: "helloworld", image: big }), { ok: false, reason: "too-big" });
  eq(called, 0);
});
check("ocrSpacePage: no api key -> unavailable, never sent", async () => {
  let called = 0;
  const fetchFn = async () => {
    called++;
    return mockResponse(200, OCR_OK);
  };
  eq(await S.ocrSpacePage({ fetchFn, apiKey: "", image: IMG }), { ok: false, reason: "unavailable" });
  eq(await S.ocrSpacePage({ fetchFn, apiKey: "   ", image: IMG }), { ok: false, reason: "unavailable" });
  eq(called, 0);
});

console.log("N. Smart routing (mean confidence)");
check("ENHANCE_MEAN_CONFIDENCE_THRESHOLD is 75", () => eq(O.ENHANCE_MEAN_CONFIDENCE_THRESHOLD, 75));
check("meanWordConfidence: mean, null on no words, ignores non-numeric", () => {
  eq(O.meanWordConfidence([{ confidence: 90 }, { confidence: 80 }, { confidence: 70 }]), 80);
  eq(O.meanWordConfidence([]), null);
  eq(O.meanWordConfidence(null), null);
  eq(O.meanWordConfidence([{ confidence: 90 }, { confidence: "x" }, {}]), 90);
  eq(O.meanWordConfidence([{ confidence: NaN }]), null);
});

check("overallAccuracy: mean of page confidences, null when none measured", () => {
  eq(O.overallAccuracy([{ meanConfidence: 90 }, { meanConfidence: 80 }, { meanConfidence: 70 }]), 80);
  eq(O.overallAccuracy([{ meanConfidence: 95 }, { meanConfidence: 60 }, {}]), 78);
  eq(O.overallAccuracy([{ meanConfidence: 92.4 }, { meanConfidence: 91.6 }]), 92);
  eq(O.overallAccuracy([]), null);
  eq(O.overallAccuracy([{}]), null);
  eq(O.overallAccuracy([{ meanConfidence: NaN }]), null);
});
check("pageNeedsEnhancement: strong keeps Tesseract, weak goes to tiers", () => {
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: 90 }), false);
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: 75 }), false); // at threshold = keep
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: 74.9 }), true);
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: 50 }), true);
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: 0 }), true);
});
check("pageNeedsEnhancement: missing confidence -> weak (resumed jobs keep old behaviour)", () => {
  eq(O.pageNeedsEnhancement({ text: AR }), true);
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: null }), true);
  eq(O.pageNeedsEnhancement({ text: AR, meanConfidence: undefined }), true);
});
check("pageNeedsEnhancement: blank page never sent", () => {
  eq(O.pageNeedsEnhancement({ text: "", meanConfidence: 10 }), false);
  eq(O.pageNeedsEnhancement({ text: "   \n ", meanConfidence: null }), false);
  eq(O.pageNeedsEnhancement({ text: "", meanConfidence: null }), false);
});

console.log("O. Tiered queue + content-hash cache (enhance-queue.js)");
// In-memory cache for the tier tests (stands in for IndexedDB).
function memCache() {
  const map = new Map();
  return {
    map,
    getCached: async (h) => map.get(h) || null,
    putCached: async (h, e) => {
      map.set(h, e);
    },
  };
}
// A fetch that answers OCR.space and the GPU from different URLs.
function mockTierFetch({ ocrSpace, gpu }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: (init && init.headers) || {} });
    if (String(url).includes("ocr.space")) {
      const r = typeof ocrSpace === "function" ? ocrSpace() : ocrSpace;
      return mockResponse(r.status, r.data);
    }
    const r = typeof gpu === "function" ? gpu() : gpu;
    return mockResponse(r.status, r.data);
  };
  fn.calls = calls;
  return fn;
}
const GPU_OK = { ok: true, text: "نص GPU محسّن", engine: "qari", confidence: null, lang: "ar" };
const WEAK_AR = { n: 1, text: AR, script: "arabic", route: O.routePage(AR), meanConfidence: 50 };
const WEAK_EN = { n: 2, text: EN, script: "latin", route: O.routePage(EN), meanConfidence: 40 };
const WEAK_QARI = { n: 3, text: AR_DIACRITIC, script: "arabic", route: O.routePage(AR_DIACRITIC), meanConfidence: 30 };
const STRONG_AR = { n: 4, text: AR, script: "arabic", route: O.routePage(AR), meanConfidence: 92 };

check("enhanceOnePage: cache hit by stored imageHash — no network at all", async () => {
  const cache = memCache();
  const hash = O.cacheKey(IMG);
  await cache.putCached(hash, { text: "نص مخزّن", engine: "ocr-space", updatedAt: "2026-11-18" });
  let called = 0;
  const fetchFn = async () => {
    called++;
    return mockResponse(200, OCR_OK);
  };
  const page = { ...WEAK_AR, imageHash: hash };
  const r = await Q.enhanceOnePage({
    page,
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "helloworld",
    gpuBaseUrl: "https://example.test",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
  });
  eq(r, { ok: true, text: "نص مخزّن", engine: "ocr-space", source: "cache" });
  eq(called, 0);
});
check("enhanceOnePage: cache miss -> OCR.space wins, result is cached", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({ ocrSpace: { status: 200, data: OCR_OK }, gpu: { status: 200, data: GPU_OK } });
  const page = { ...WEAK_AR };
  const r = await Q.enhanceOnePage({
    page,
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "helloworld",
    gpuBaseUrl: "https://example.test",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
  });
  eq(r.ok, true);
  eq(r.text, "نص من OCR.space");
  eq(r.source, "ocr-space");
  eq(fetchFn.calls.length, 1); // GPU never called
  assert.ok(fetchFn.calls[0].url.includes("ocr.space"));
  // The result is now in the cache under the image hash.
  const hit = await cache.getCached(page.imageHash);
  eq(hit.text, "نص من OCR.space");
  eq(hit.engine, "ocr-space");
});
check("enhanceOnePage: OCR.space fails -> falls through to GPU", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({
    ocrSpace: { status: 500, data: { ErrorMessage: "x" } },
    gpu: { status: 200, data: GPU_OK },
  });
  const page = { ...WEAK_AR };
  const r = await Q.enhanceOnePage({
    page,
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "helloworld",
    gpuBaseUrl: "https://example.test",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
  });
  eq(r.ok, true);
  eq(r.text, "نص GPU محسّن");
  eq(r.source, "gpu");
  eq(fetchFn.calls.length, 2);
});
check("enhanceOnePage: diacritic (Qari) page skips OCR.space, goes straight to GPU", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({ ocrSpace: { status: 200, data: OCR_OK }, gpu: { status: 200, data: GPU_OK } });
  const page = { ...WEAK_QARI };
  const r = await Q.enhanceOnePage({
    page,
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "helloworld",
    gpuBaseUrl: "https://example.test",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
  });
  eq(r.ok, true);
  eq(r.source, "gpu");
  eq(fetchFn.calls.length, 1);
  assert.ok(fetchFn.calls[0].url.includes("enhance-page"));
});
check("enhanceOnePage: no tiers and cache miss -> no-tier", async () => {
  const cache = memCache();
  let called = 0;
  const fetchFn = async () => {
    called++;
    return mockResponse(200, OCR_OK);
  };
  const r = await Q.enhanceOnePage({
    page: { ...WEAK_AR },
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "",
    gpuBaseUrl: "",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
  });
  eq(r, { ok: false, reason: "no-tier" });
  eq(called, 0);
});
check("enhanceOnePage: GPU quota -> reason quota + gpuDisabled flag set", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({
    ocrSpace: { status: 500, data: { ErrorMessage: "x" } },
    gpu: { status: 429, data: { ok: false, error: "daily budget" } },
  });
  const gpuDisabled = { current: false };
  const r = await Q.enhanceOnePage({
    page: { ...WEAK_AR },
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "helloworld",
    gpuBaseUrl: "https://example.test",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
    gpuDisabled,
  });
  eq(r, { ok: false, reason: "quota" });
  eq(gpuDisabled.current, true);
});
check("enhanceOnePage: OCR.space quota disables OCR.space, GPU still runs", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({
    ocrSpace: { status: 429, data: { ErrorMessage: "limit" } },
    gpu: { status: 200, data: GPU_OK },
  });
  const ocrSpaceDisabled = { current: false };
  const r = await Q.enhanceOnePage({
    page: { ...WEAK_AR },
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
    ocrSpaceKey: "helloworld",
    gpuBaseUrl: "https://example.test",
    ocrSpaceFetchFn: fetchFn,
    gpuFetchFn: fetchFn,
    ocrSpaceDisabled,
  });
  eq(r.ok, true);
  eq(r.source, "gpu");
  eq(ocrSpaceDisabled.current, true);
});

check("runTieredEnhancementQueue: strong page never attempted, weak pages enhanced", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({ ocrSpace: { status: 200, data: OCR_OK }, gpu: { status: 200, data: GPU_OK } });
  let images = 0;
  const enhanced = [];
  const summary = await Q.runTieredEnhancementQueue({
    fetchFn,
    gpuBaseUrl: "https://example.test",
    ocrSpaceKey: "helloworld",
    pages: [{ ...STRONG_AR }, { ...WEAK_AR }, { ...WEAK_EN }],
    // Distinct image bytes per page, so the pages do NOT share
    // a cache entry (identical bytes would — correctly — hit the
    // cache on the second page).
    getImage: async (page) => {
      images++;
      return new Uint8Array([page.n, 0x50, 0x4e, 0x47]);
    },
    getCached: cache.getCached,
    putCached: cache.putCached,
    onPageEnhanced: (page, result) => enhanced.push([page.n, result.source]),
  });
  eq(summary.attempted, 2); // the strong page was never attempted
  eq(summary.enhanced, 2);
  eq(summary.enhancedFromOcrSpace, 2);
  eq(summary.enhancedFromCache, 0);
  eq(summary.enhancedFromGpu, 0);
  eq(summary.skipped, 0);
  eq(enhanced, [[1, "ocr-space"], [2, "ocr-space"]]);
  eq(images, 2); // no image render for the strong page
});
check("runTieredEnhancementQueue: second run hits the cache — zero network", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({ ocrSpace: { status: 200, data: OCR_OK }, gpu: { status: 200, data: GPU_OK } });
  const pages = [{ ...WEAK_AR }, { ...WEAK_EN }];
  // Distinct images per page so each gets its own cache entry.
  const getImage = async (page) => new Uint8Array([page.n, 0x50, 0x4e, 0x47]);
  const first = await Q.runTieredEnhancementQueue({
    fetchFn,
    gpuBaseUrl: "https://example.test",
    ocrSpaceKey: "helloworld",
    pages,
    getImage,
    getCached: cache.getCached,
    putCached: cache.putCached,
  });
  eq(first.enhanced, 2);
  eq(first.enhancedFromOcrSpace, 2);
  const callsAfterFirst = fetchFn.calls.length;
  // Reset the pages to "un-enhanced" (a second reader) — the
  // imageHash is kept, so the cache answers without any network.
  const secondPages = pages.map((p) => ({ ...p, quality: "standard" }));
  const second = await Q.runTieredEnhancementQueue({
    fetchFn,
    gpuBaseUrl: "https://example.test",
    ocrSpaceKey: "helloworld",
    pages: secondPages,
    getImage,
    getCached: cache.getCached,
    putCached: cache.putCached,
  });
  eq(second.enhanced, 2);
  eq(second.enhancedFromCache, 2);
  eq(fetchFn.calls.length, callsAfterFirst); // zero new network calls
});
check("runTieredEnhancementQueue: OCR.space quota disables it, GPU carries the rest", async () => {
  const cache = memCache();
  let ocrCalls = 0;
  const fetchFn = async (url, init) => {
    if (String(url).includes("ocr.space")) {
      ocrCalls++;
      return mockResponse(429, { ErrorMessage: "limit" });
    }
    return mockResponse(200, GPU_OK);
  };
  const summary = await Q.runTieredEnhancementQueue({
    fetchFn,
    gpuBaseUrl: "https://example.test",
    ocrSpaceKey: "helloworld",
    pages: [{ ...WEAK_AR }, { ...WEAK_AR, n: 2 }],
    // Distinct images so the second page is NOT a cache hit of
    // the first page's GPU result (same bytes would share it).
    getImage: async (page) => new Uint8Array([page.n, 0x50, 0x4e, 0x47]),
    getCached: cache.getCached,
    putCached: cache.putCached,
  });
  eq(summary.enhanced, 2);
  eq(summary.enhancedFromGpu, 2);
  eq(summary.stoppedOnOcrSpaceQuota, true);
  eq(ocrCalls, 1); // only the first page tried OCR.space
});
check("runTieredEnhancementQueue: already-enhanced pages are skipped", async () => {
  const cache = memCache();
  const fetchFn = mockTierFetch({ ocrSpace: { status: 200, data: OCR_OK }, gpu: { status: 200, data: GPU_OK } });
  const summary = await Q.runTieredEnhancementQueue({
    fetchFn,
    gpuBaseUrl: "https://example.test",
    ocrSpaceKey: "helloworld",
    pages: [{ ...WEAK_AR, quality: "enhanced" }],
    getImage: async () => IMG,
    getCached: cache.getCached,
    putCached: cache.putCached,
  });
  eq(summary, {
    attempted: 0,
    enhanced: 0,
    skipped: 0,
    enhancedFromCache: 0,
    enhancedFromOcrSpace: 0,
    enhancedFromGpu: 0,
    stoppedOnGpuQuota: false,
    stoppedOnOcrSpaceQuota: false,
  });
  eq(fetchFn.calls.length, 0);
});

console.log("P. No direct download + fair use (2026-11-18)");
check("miniappSendErrorMessage: E_FAIR_USE names the wait in minutes", () => {
  const msg = O.miniappSendErrorMessage("E_FAIR_USE", 10);
  assert.ok(msg.includes("10") && msg.includes("دقيقة"), msg);
  assert.ok(msg.includes("ليستفيد غيرك"), msg);
});
check("miniappSendErrorMessage: E_FAIR_USE without a wait still explains the throttle", () => {
  const msg = O.miniappSendErrorMessage("E_FAIR_USE");
  assert.ok(msg.includes("الساعة الأخيرة"), msg);
});
check("miniappSendErrorMessage: E_FAIR_USE with a non-number wait falls back to the plain message", () => {
  const msg = O.miniappSendErrorMessage("E_FAIR_USE", "soon");
  assert.ok(msg.includes("الساعة الأخيرة") && !msg.includes("soon"), msg);
});
check("index.html: no direct EPUB download button (website rule)", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.ok(!html.includes("downloadBtn"), "downloadBtn must not exist");
  assert.ok(!html.includes("downloadEnhancedBtn"), "downloadEnhancedBtn must not exist");
  assert.ok(!html.includes("تحميل EPUB"), "no download wording");
  assert.ok(html.includes("sendKindleBtn"), "the send-to-Kindle button stays");
  assert.ok(html.includes("لا يوجد تحميل مباشر"), "the no-download note is shown");
});
check("convert-app.js: no downloadBlob, no download handlers (website rule)", () => {
  const js = readFileSync(new URL("./convert-app.js", import.meta.url), "utf8");
  assert.ok(!js.includes("downloadBlob"), "downloadBlob must be gone");
  assert.ok(!js.includes("downloadBtn"), "downloadBtn must be gone");
  assert.ok(!js.includes("downloadEnhancedBtn"), "downloadEnhancedBtn must be gone");
  assert.ok(js.includes("جارٍ التجهيز"), "the preparing status is shown for catalog books");
  assert.ok(js.includes("sendToKindle()"), "the catalog flow auto-sends");
  assert.ok(js.includes("E_FAIR_USE") || js.includes("waitMinutes"), "the send carries the fair-use wait");
});

await Promise.all(pending);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
