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
//      200-page cap.
import * as O from "./ocr-client.js";
import * as Q from "./enhance-queue.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
  assert.ok(msg.includes("200"), msg);
});
check("CONVERT_MAX_PAGES is 200", () => eq(O.CONVERT_MAX_PAGES, 200));

await Promise.all(pending);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
