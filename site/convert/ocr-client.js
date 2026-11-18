/**
 * RliBook client-side converter — pure logic (no DOM, no network).
 *
 * Used by site/convert/convert-app.js in the browser and tested in
 * Node by site/convert/convert.test.mjs. The OCR itself runs in
 * site/convert/ocr-worker.js (Tesseract.js, ara/eng); this module
 * only decides, cleans, splits and builds — so it stays testable
 * without a browser, a GPU, or a downloaded model.
 *
 * LANGUAGE DETECTION + ROUTING — JavaScript twin of the bot's
 * src/ocr-lang.ts. Same Unicode ranges, same thresholds; keep the
 * two in sync. Routing table (benchmarks named, figures never
 * quoted without them):
 *   Latin page             -> PP-OCRv6 (~4.5% CER on English vs
 *                             ~18% Tesseract, community benchmark)
 *   Arabic, clean modern   -> Baseer (lowest WER 0.25, Misraj-DocOCR
 *                             400 pp.)
 *   Arabic, diacritic-rich -> Qari v0.2 (CER 0.061 / WER 0.160 on
 *                             its OWN 200-page diacritic test set
 *                             ONLY — never a general Arabic figure)
 *   Mixed page             -> both engines, merge lines by script
 *   No GPU (this page)     -> Tesseract.js ara/eng (Arabic CER
 *                             0.44-0.54 — the floor, not a contender)
 *   PaddleOCR-VL is ~94.5% overall on OmniDocBench v1.5 (not
 *   Arabic-only); the "96.33%" figure was NOT confirmed — never
 *   quote it. Baidu Unlimited-OCR is NOT the Arabic champion
 *   (Arabic poor on historical scans, 60-80% on 1890s Naskh;
 *   "99%/92%" UNVERIFIED).
 */

// --- script detection (twin of src/ocr-lang.ts) -----------------------
export const ARABIC_SHARE = 0.7;
export const LATIN_SHARE = 0.3;
export const MIN_LETTERS = 10;
export const DIACRITIC_DENSITY = 0.1;

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_RE = /[A-Za-z]/g;
const TASHKEEL_RE = /[\u064B-\u0652\u0670]/g;

export function countScripts(text) {
  const arabic = (text.match(ARABIC_RE) || []).length;
  const latin = (text.match(LATIN_RE) || []).length;
  const tashkeel = (text.match(TASHKEEL_RE) || []).length;
  return { arabic, latin, tashkeel, total: arabic + latin };
}

export function detectPageScript(text) {
  const { arabic, total } = countScripts(text);
  if (total < MIN_LETTERS) return "unknown";
  const share = arabic / total;
  if (share >= ARABIC_SHARE) return "arabic";
  if (share <= LATIN_SHARE) return "latin";
  return "mixed";
}

export function isDiacriticRich(text) {
  const { arabic, tashkeel } = countScripts(text);
  if (arabic < MIN_LETTERS) return false;
  return tashkeel / arabic >= DIACRITIC_DENSITY;
}

/** Engine for one page's text: "pp-ocrv6" | "baseer" | "qari".
 *  "mixed" pages return { engine, also } — both run, lines merge
 *  by script. An override wins over detection. NOTE: "ar-classical"
 *  (classical / fully vocalised Arabic) forces Qari, because no
 *  client-side probe can detect tashkeel — Tesseract strips
 *  diacritics from its output, so isDiacriticRich() on Tesseract
 *  text is always false. The override is the reliable path. */
export function routePage(text, override = "auto") {
  const script = detectPageScript(text);
  const diacriticRich = isDiacriticRich(text);
  if (override === "en") return { engine: "pp-ocrv6", script, diacriticRich, via: "override" };
  if (override === "ar-classical") {
    if (script === "latin") return { engine: "pp-ocrv6", script, diacriticRich, via: "override" };
    return { engine: "qari", script, diacriticRich: true, via: "override" };
  }
  if (override === "ar") {
    return { engine: diacriticRich ? "qari" : "baseer", script, diacriticRich, via: "override" };
  }
  if (script === "arabic") {
    return { engine: diacriticRich ? "qari" : "baseer", script, diacriticRich, via: "detect" };
  }
  if (script === "latin" || script === "unknown") {
    return { engine: "pp-ocrv6", script, diacriticRich, via: "detect" };
  }
  return { engine: diacriticRich ? "qari" : "baseer", also: "pp-ocrv6", script, diacriticRich, via: "detect" };
}

/** Tesseract.js language(s) for an override. The browser runs
 *  Tesseract (ara/eng) — NOT the GPU engines: the routing table
 *  names the target engine (pp-ocrv6 / baseer / qari) for the
 *  cloud tier, and this maps it to the Tesseract langs the client
 *  can actually load. "auto" loads both and splits by script. */
export function tesseractLangsForOverride(override = "auto") {
  if (override === "ar" || override === "ar-classical") return "ara";
  if (override === "en") return "eng";
  return "ara+eng";
}

// --- smart routing (demand reduction) --------------------------------
// The enhancement tiers (OCR.space, then the GPU) only ever see
// pages where the base Tesseract result looks weak. The signal is
// Tesseract's mean word confidence (0–100, from data.words in
// worker.recognize). A page at or above the threshold keeps its
// Tesseract text and is never sent anywhere — that is what cuts
// enhancement demand to roughly 20–30% of pages (see the capacity
// research: at 25% routing, 1,000 user-pages/day need only ~250
// GPU pages/day). The threshold is a named constant so it can be
// tuned after measuring real books; 75 is the starting point
// (Tesseract word confidence on clean modern print is typically
// 85–95, on degraded/old print it drops well below 70).
export const ENHANCE_MEAN_CONFIDENCE_THRESHOLD = 75;

/** Mean Tesseract word confidence (0–100) for a recognize() result.
 *  `words` is data.words (each { confidence }). Returns null when
 *  there are no usable word confidences (empty page / no words). */
export function meanWordConfidence(words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const w of words) {
    const c = w && typeof w.confidence === "number" ? w.confidence : NaN;
    if (Number.isFinite(c)) {
      sum += c;
      n++;
    }
  }
  if (n === 0) return null;
  return sum / n;
}

/** True when this page should go to the enhancement tiers.
 *  page: { text, meanConfidence? } — meanConfidence is recorded
 *  at OCR time (see convert-app.js ocrPage); pages OCR'd before
 *  this feature (resumed jobs) have no meanConfidence and are
 *  treated as weak, so resumed jobs keep the old behaviour (they
 *  were all sent to the GPU tier before). A blank page (no text)
 *  has nothing to enhance and is never sent. */
export function pageNeedsEnhancement(page, threshold = ENHANCE_MEAN_CONFIDENCE_THRESHOLD) {
  const text = (page && page.text) || "";
  if (!text.trim()) return false;
  const conf = page && typeof page.meanConfidence === "number" ? page.meanConfidence : null;
  if (conf === null || !Number.isFinite(conf)) return true;
  return conf < threshold;
}

// --- OCR text cleanup --------------------------------------------------
/** Drop a line that is only a page number (with optional dashes /
 *  brackets), and lines that are only punctuation. */
export function cleanOcrText(text) {
  // Tesseract emits form feeds (\f) as page separators and stray
  // control characters; strip them before line-splitting.
  const lines = String(text || "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .split("\n");
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-–—\[\(]?[0-9٠-٩]{1,4}[-–—\]\)]?$/.test(line)) continue;
    if (/^[^\p{L}\p{N}]+$/u.test(line)) continue;
    kept.push(line);
  }
  // Join hyphenated line-breaks (Latin words split across lines).
  const joined = kept.join("\n").replace(/([A-Za-z])-\n([a-z])/g, "$1$2");
  return joined.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split a line into script runs for mixed-line merging: returns
 *  [{ script: "arabic"|"latin", text }] in reading order. */
export function splitLineByScript(line) {
  const runs = [];
  let cur = "";
  let curScript = null;
  for (const ch of String(line)) {
    const isAr = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(ch);
    const isLat = /[A-Za-z]/.test(ch);
    const script = isAr ? "arabic" : isLat ? "latin" : curScript || "latin";
    if (curScript === null) curScript = script;
    if (script !== curScript) {
      if (cur.trim()) runs.push({ script: curScript, text: cur });
      cur = ch;
      curScript = script;
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) runs.push({ script: curScript || "latin", text: cur });
  return runs;
}

// --- chapter splitting (heuristics — OCR has no real headings) --------
// NOTE: no \b after the keyword — JS \b is ASCII-only, so it
// can never fire after an Arabic word (Arabic letters are
// non-word characters for \b) and Arabic headings would never
// match. The (?:[\s.:–-]|$) group does the same job.
const CHAPTER_RE = /^(chapter|chap\.?|part|section|باب|فصل|الباب|الفصل|مقدمة|المقدمة|خاتمة|الخاتمة)(?:[\s.:–-]|$)(.*)$/i;

export function splitChapters(pages) {
  // pages: [{ n, text }] — returns [{ title, pages: [...] }].
  const chapters = [{ title: "Start", pages: [] }];
  for (const page of pages) {
    const lines = String(page.text || "").split("\n");
    let splitAt = -1;
    let title = "";
    for (let i = 0; i < Math.min(lines.length, 6); i++) {
      const line = lines[i].trim();
      if (line.length > 3 && line.length < 80) {
        const m = CHAPTER_RE.exec(line);
        if (m) {
          splitAt = i;
          title = line;
          break;
        }
      }
    }
    if (splitAt >= 0) {
      const last = chapters[chapters.length - 1];
      if (last.pages.length === 0 && chapters.length === 1) {
        // The book opens with a chapter heading — name the first
        // chapter after it instead of leaving "Start".
        last.title = title;
      } else {
        chapters.push({ title, pages: [] });
      }
    }
    chapters[chapters.length - 1].pages.push(page);
  }
  // Drop a leading empty "Start" chapter when the first real
  // chapter begins on page 1.
  if (chapters.length > 1 && chapters[0].pages.length === 0) chapters.shift();
  return chapters;
}

// --- EPUB parts (pure strings; JSZip wraps them in the browser) -------
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function pageToXhtml(page) {
  const text = cleanOcrText(page.text || "");
  const script = detectPageScript(text);
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  const body = paras
    .map((p) => `<p>${escapeXml(p.trim()).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  const inner = body || "<p>(no text recognised on this page)</p>";
  const wrapped =
    script === "arabic" || script === "mixed"
      ? `<div dir="rtl" lang="ar">\n${inner}\n</div>`
      : inner;
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    "<!DOCTYPE html>\n" +
    '<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n' +
    `<head><title>Page ${page.n}</title></head>\n<body>\n${wrapped}\n</body>\n</html>\n`
  );
}

/** Build the EPUB's text parts from OCR pages. Returns
 *  { opf, nav, chapters: [{ name, xhtml }] }. The caller (browser)
 *  zips them with JSZip: mimetype first + stored, then
 *  META-INF/container.xml + OEBPS/* — see convert-app.js. */
export function buildEpubParts(title, pages, opts = {}) {
  const safeTitle = String(title || "book").trim() || "book";
  const lang = opts.language || (detectPageScript(pages.map((p) => p.text || "").join("\n")) === "arabic" ? "ar" : "en");
  const dir = lang === "ar" ? "rtl" : "ltr";
  const chapters = splitChapters(pages);
  const parts = chapters.map((ch, i) => {
    const name = `chap${i + 1}.xhtml`;
    const bodies = ch.pages.map((p) => pageToXhtml(p)).map((x) => {
      // pageToXhtml is a full document; extract its <body> content.
      const m = /<body>([\s\S]*)<\/body>/.exec(x);
      return m ? m[1] : "";
    });
    const xhtml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      "<!DOCTYPE html>\n" +
      `<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" dir="${dir}">\n` +
      `<head><title>${escapeXml(ch.title || `Part ${i + 1}`)}</title></head>\n<body>\n` +
      bodies.join("\n") +
      "\n</body>\n</html>\n";
    return { name, title: ch.title || `Part ${i + 1}`, xhtml };
  });
  const manifest = parts
    .map((c, i) => `<item id="c${i}" href="${c.name}" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const spine = parts.map((c, i) => `<itemref idref="c${i}"/>`).join("\n");
  const navItems = parts
    .map((c) => `<li><a href="${c.name}">${escapeXml(c.title)}</a></li>`)
    .join("\n");
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">\n' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    '<dc:identifier id="bookid">urn:rlibook:converted:' + escapeXml(safeTitle) + "</dc:identifier>\n" +
    `<dc:title>${escapeXml(safeTitle)}</dc:title>\n` +
    `<dc:language>${lang}</dc:language>\n` +
    "<dc:creator>RliBook converter (client-side)</dc:creator>\n" +
    `<meta property="dcterms:modified">${modified}</meta>\n` +
    "</metadata>\n<manifest>\n" +
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
    manifest +
    "\n</manifest>\n<spine>\n" +
    spine +
    "\n</spine>\n</package>\n";
  const nav =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    "<!DOCTYPE html>\n" +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
    "<head><title>Contents</title></head>\n<body>\n" +
    '<nav epub:type="toc"><ol>\n' + navItems + "\n</ol></nav>\n</body>\n</html>\n";
  return { opf, nav, chapters: parts, language: lang };
}

// --- content hash (cache key: one conversion serves every reader) -----
// Small synchronous SHA-256 (FIPS 180-4), so the cache key works in
// a Web Worker, on the main thread, and in Node without async
// crypto.subtle. Standard implementation; verified against
// node:crypto in convert.test.mjs.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
export function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bitLen = data.length * 8;
  const padded = [];
  for (let i = 0; i < data.length; i++) padded.push(data[i]);
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  for (let i = 7; i >= 0; i--) padded.push((bitLen / Math.pow(2, i * 8)) & 0xff);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < padded.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) {
      w[i] = (padded[off + i * 4] << 24) | (padded[off + i * 4 + 1] << 16) | (padded[off + i * 4 + 2] << 8) | padded[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const hex = (n) => ("00000000" + (n >>> 0).toString(16)).slice(-8);
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

/** Cache key for a finished EPUB / an input file: sha256 of the
 *  input bytes. One conversion serves every later reader — the GPU
 *  budget is spent once per book, never once per user. */
export function cacheKey(bytes) {
  return sha256Hex(bytes);
}

// --- Mini App send-to-Kindle contract (bot-only) ----------------------
// The converter page is BOT-ONLY: it is opened from the Telegram
// bot's /convert command as a Mini App, never linked from any
// public page. When it runs inside Telegram, the finished EPUB can
// be sent to the user's own linked Kindle email through the bot:
//   POST { initData, filename, epubBase64[, ticket, pages, quality] } (JSON) to
//   MINIAPP_CONVERT_SEND_URL
//   -> { ok: true } | { ok: false, code: 'E_NO_EMAIL' | 'E_LIMIT'
//        | 'E_BAD_INITDATA' | 'E_TOO_BIG' | 'E_TOO_MANY_PAGES'
//        | 'E_SEND_FAILED' }
// The bot validates the Telegram WebApp initData, looks up the
// linked Kindle email, enforces the 3/day convert allowance, and
// emails the EPUB via Resend. Conversion itself still runs on the
// END USER's device (this page, in their Telegram browser) —
// nothing runs on the site owner's device, and no server-side
// conversion is added here. Pure constants + message mapping, so
// they stay testable in Node (convert.test.mjs §J); the fetch
// itself lives in convert-app.js.
//
// v4.8.47 — Convert-button flow: the bot opens the page with a
// book pre-loaded (?h=<handle>&p=<postId>&f=pdf&ticket=<id>).
// The page fetches the PDF itself (via /api/dl-token, same
// origin), converts it on the device, and POSTs the EPUB back
// bound to the ticket — so the bot can cache it under the book's
// source key (dedupe). It also pings /miniapp-convert-status
// when the conversion starts ("converting…") or fails, so the
// user gets the status in chat even after closing the browser.
export const MINIAPP_CONVERT_SEND_URL =
  "https://rlibook-bot.mohamedyou1357.workers.dev/miniapp-convert-send";
export const MINIAPP_CONVERT_STATUS_URL =
  "https://rlibook-bot.mohamedyou1357.workers.dev/miniapp-convert-status";
export const MINIAPP_SEND_MAX_EPUB_BYTES = 20 * 1024 * 1024;

/** Max pages one conversion handles (v4.8.48 — mirrors the bot's
 *  CONVERT_MAX_PAGES). The page enforces it when the PDF is
 *  loaded (pdf.numPages) AND the bot enforces it on the send. */
export const CONVERT_MAX_PAGES = 500;

const MINIAPP_SEND_ERRORS = {
  E_NO_EMAIL: "لم تربط إيميل الكيندل بعد — اربطه أولاً في البوت ثم أعد المحاولة.",
  E_LIMIT: "استخدمتَ تحويلاتك الثلاثة لهذا اليوم — عُد غداً.",
  E_BAD_INITDATA: "افتح المحوّل من البوت مجدداً (أمر /convert) ثم أعد المحاولة.",
  E_TOO_BIG: "ملف EPUB أكبر من 20 MB — لا يمكن إرساله بالبريد.",
  E_TOO_MANY_PAGES: "الكتاب أكبر من 500 صفحة — قسّمه إلى أجزاء أصغر ثم حوّل كل جزء.",
  E_SEND_FAILED: "تعذّر الإرسال، حاول مجدداً — لم يُحتسب هذا التحويل من حصتك.",
  // Fair use (2026-11-18): the bot throttles a member who converted
  // a lot in the last hour, so others can use it too. The wait is
  // filled in by miniappSendErrorMessage when waitMinutes is given.
  E_FAIR_USE: "حوّلتَ كثيراً في الساعة الأخيرة — ليستفيد غيرك أيضاً، انتظر قليلاً قبل تحويلك التالي.",
};

/** Arabic message for a miniapp-convert-send error code. Unknown
 *  codes fall back to a generic retry message. E_FAIR_USE takes an
 *  optional wait in minutes (from the bot's JSON body) and names it. */
export function miniappSendErrorMessage(code, waitMinutes) {
  if (code === "E_FAIR_USE" && typeof waitMinutes === "number" && waitMinutes > 0) {
    return `حوّلتَ كثيراً في الساعة الأخيرة — ليستفيد غيرك أيضاً، انتظر ${waitMinutes} دقيقة قبل تحويلك التالي. يُفتح وحده بعدها.`;
  }
  return MINIAPP_SEND_ERRORS[code] || "تعذّر الإرسال، حاول مجدداً.";
}

/** True when the value is a usable Telegram WebApp initData
 *  (a non-empty string). The page shows the send-to-Kindle button
 *  only in that case. */
export function isTelegramWebAppInitData(value) {
  return typeof value === "string" && value.length > 0;
}

/** Request payload for POST miniapp-convert-send — the three
 *  base fields plus the Convert-button extras when present:
 *  `ticket` (binds the EPUB to the bot's server-side source key
 *  for the dedupe cache), `pages` (the PDF's page count, for the
 *  bot's 200-page cap), `quality` ("enhanced" when any page was
 *  GPU-enhanced, else "standard"). Extra fields are omitted when
 *  absent so older bot versions see exactly the old shape. */
export function buildMiniappSendPayload(initData, filename, epubBase64, extra) {
  const payload = { initData, filename, epubBase64 };
  if (extra && typeof extra.ticket === "string" && /^[0-9a-f]{16}$/.test(extra.ticket)) {
    payload.ticket = extra.ticket;
  }
  if (extra && typeof extra.pages === "number" && Number.isFinite(extra.pages) && extra.pages > 0) {
    payload.pages = Math.floor(extra.pages);
  }
  if (extra && extra.quality === "enhanced") payload.quality = "enhanced";
  return payload;
}

/** Request payload for POST miniapp-convert-status — the
 *  "converting…" / failure ping: { initData, ticket, status,
 *  error? }. The bot resolves the ticket server-side (it must
 *  belong to the initData user) and sends the status message in
 *  chat. */
export function buildMiniappStatusPayload(initData, ticket, status, error) {
  const payload = { initData, ticket, status };
  if (typeof error === "string" && error) payload.error = error.slice(0, 200);
  return payload;
}

/** Parse the Convert-button query params from the page URL
 *  (?h=<handle>&p=<postId>&f=pdf&ticket=<id>): the book the bot
 *  pre-loaded for conversion. Returns null when the page was NOT
 *  opened from a Convert tap (plain /convert — the user picks a
 *  file by hand). `search` is the location.search string
 *  (leading "?" optional) so it stays testable in Node. */
export function parseConvertBookParams(search) {
  try {
    const q = new URLSearchParams((search || "").replace(/^\?/, ""));
    const handle = (q.get("h") || "").trim();
    const postId = (q.get("p") || "").trim();
    const ticket = (q.get("ticket") || "").trim();
    const format = (q.get("f") || "").trim().toLowerCase();
    if (!handle || !/^\d+$/.test(postId) || format !== "pdf") return null;
    if (!/^[0-9a-f]{16}$/.test(ticket)) return null;
    return { handle, postId, format, ticket };
  } catch {
    return null;
  }
}

/** The /api/dl-token URL that mints a signed proxy download URL
 *  for a Convert-button book (same origin — the page calls it
 *  relative). The token issuer enforces the flag/hidden gates and
 *  the 5/day download budget; the Mini App fetches the PDF bytes
 *  from the returned `url` (Telegram books) — in memory only, the
 *  user never gets a download. */
export function convertBookDlTokenUrl(params) {
  const q =
    `lib=tg&h=${encodeURIComponent(params.handle)}` +
    `&p=${encodeURIComponent(params.postId)}` +
    `&f=${encodeURIComponent(params.format || "pdf")}`;
  return `/api/dl-token?${q}`;
}
