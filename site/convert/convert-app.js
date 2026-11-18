/**
 * RliBook client-side converter — browser app (site/convert/).
 *
 * THE DURABLE CORE. Everything on this page runs in the user's own
 * browser: pdf.js renders the pages, Tesseract.js (in its own Web
 * Worker) reads them, and the EPUB is built here with JSZip. No
 * server, no account, no card, no expiry — this path can never be
 * switched off. The cloud enhancement queue (below) is only a
 * temporary quality booster on top of it.
 *
 * What runs where:
 *   - Render: pdf.js (vendored, ./vendor/pdf.min.mjs) — one page
 *     at a time, 200 DPI by default (max 300), canvas released
 *     after each page.
 *   - OCR: Tesseract.js ara/eng (vendored worker + core +
 *     traineddata, no CDN at runtime). Auto mode loads ara+eng
 *     and splits by script per page; a forced language loads one.
 *     The browser runs Tesseract — NOT PP-OCRv6 / Baseer / Qari
 *     (2–3B VLMs cannot run in a browser). The routing table in
 *     ocr-client.js names those as the CLOUD tier's engines; the
 *     client maps them to Tesseract langs (see
 *     tesseractLangsForOverride). Accuracy, measured live
 *     2026-11-16: Tesseract is perfect on clean modern print (AR +
 *     EN, 4/4 lines exact) and good on a real English scan
 *     (word-hit 0.88), but poor on a 19th-century Arabic Naskh scan
 *     (word-hit 0.61) — that old-print Arabic case is exactly what
 *     the cloud tier (Baseer/Qari) is for.
 *   - Progress: IndexedDB (db "rlibook-convert", store "jobs",
 *     key = sha256 of the input bytes). Close the tab mid-book
 *     and re-select the same file later: finished pages are kept
 *     and only the missing ones run again.
 *   - EPUB: ocr-client.js buildEpubParts (RTL per Arabic page,
 *     chapter-split heuristics, TOC) zipped with the vendored
 *     JSZip (shared with the reader: /site/reader/vendor/).
 *   - Enhancement: optional, only when the operator configured a
 *     cloud URL (Settings below, stored in localStorage). The page
 *     health-checks it; on failure, timeout, or quota exhaustion
 *     it keeps the client-side EPUB and says so in one line —
 *     automatic silent fallback, no dead end. Two layers:
 *       (a) the per-page queue (enhance-queue.js): after the
 *           client-side result is shown, each QUALIFYING page
 *           (Arabic/mixed, or English when the user chose "en")
 *           is POSTed as an image to POST /enhance-page and its
 *           text is replaced by the enhanced text, page by page;
 *       (b) the manual whole-book button below (POST /enhance):
 *           sends the whole file and downloads a second EPUB.
 *     The queue never blocks the result and never shows an error
 *     to the user — a failed page just keeps its standard text.
 *
 * Limits (same as the bot's /convert): input ≤ 10 MB, PDF/JPG/PNG
 * only, EPUBs are refused (they already have text). The finished
 * EPUB is the user's own file: when the page runs inside Telegram
 * (bot-only Mini App, opened from /convert), the "Send to my Kindle
 * email" button POSTs it to the bot's /miniapp-convert-send
 * endpoint, which emails it to the user's linked @kindle.com
 * address (3/day allowance, enforced by the bot). Otherwise the
 * user downloads the EPUB and emails it to their @kindle.com
 * address themselves. Conversion always runs on the END USER's
 * device — nothing runs on the site owner's device.
 */

import * as pdfjsLib from "./vendor/pdf.min.mjs";
import {
  CONVERT_MAX_PAGES,
  MINIAPP_CONVERT_SEND_URL,
  MINIAPP_CONVERT_STATUS_URL,
  MINIAPP_SEND_MAX_EPUB_BYTES,
  buildEpubParts,
  buildMiniappSendPayload,
  buildMiniappStatusPayload,
  cacheKey,
  cleanOcrText,
  convertBookDlTokenUrl,
  detectPageScript,
  isTelegramWebAppInitData,
  meanWordConfidence,
  miniappSendErrorMessage,
  pageNeedsEnhancement,
  parseConvertBookParams,
  routePage,
  tesseractLangsForOverride,
} from "./ocr-client.js";

import {
  ENHANCE_PAGE_TIMEOUT_MS,
  runTieredEnhancementQueue,
} from "./enhance-queue.js";

import { OCR_SPACE_MAX_IMAGE_BYTES } from "./ocr-space.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/site/convert/vendor/pdf.worker.min.mjs";

export const CONVERT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const CONVERT_MAX_DPI = 300;
const DB_NAME = "rlibook-convert";
const DB_STORE = "jobs";
const DB_ENHANCED_STORE = "enhanced";
const DB_VERSION = 2;
const CLOUD_URL_KEY = "rlibook-ocr-cloud-url";
const OCRSPACE_KEY = "rlibook-ocrspace-key";
const ENHANCE_TIMEOUT_MS = 10000;
const ENHANCE_POLL_MS = 5000;
const ENHANCE_POLL_MAX_MS = 10 * 60 * 1000;

const CONTAINER_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
  "  <rootfiles>\n" +
  '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
  "  </rootfiles>\n</container>\n";

/* ------------------------------------------------------------------ */
/* small DOM helpers                                                   */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
function show(el, on) {
  el.classList.toggle("hidden", !on);
}
function note(text, kind) {
  const el = $("notice");
  el.textContent = text;
  el.className = "note " + (kind || "");
  show(el, !!text);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ */
/* IndexedDB: jobs keyed by content hash                               */
/* ------------------------------------------------------------------ */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 store (whole-book resume) is kept as-is; v2 adds the
      // per-page enhancement cache (see below).
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "hash" });
      }
      if (!db.objectStoreNames.contains(DB_ENHANCED_STORE)) {
        db.createObjectStore(DB_ENHANCED_STORE, { keyPath: "hash" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(job) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(job);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbGet(hash) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(hash);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ */
/* per-page enhancement cache (IndexedDB store "enhanced")             */
/*                                                                     */
/* Key: sha256 of the page IMAGE bytes (the exact bytes sent for      */
/* enhancement). Value: { hash, text, engine, updatedAt }. A second  */
/* reader of the same book/page — or the same reader resuming — hits */
/* the cache and pays zero: no OCR.space call, no GPU call. The     */
/* hash is stored on the page object (page.imageHash) so a resumed   */
/* job can hit the cache without re-rendering the page image.        */
/* ------------------------------------------------------------------ */
async function dbPutEnhanced(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_ENHANCED_STORE, "readwrite");
    tx.objectStore(DB_ENHANCED_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbGetEnhanced(hash) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_ENHANCED_STORE, "readonly").objectStore(DB_ENHANCED_STORE).get(hash);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ */
/* EPUB zip (JSZip global, vendored with the reader)                   */
/* ------------------------------------------------------------------ */
async function buildEpubBlob(title, pages) {
  const parts = buildEpubParts(title, pages);
  const zip = new JSZip();
  // The mimetype MUST be first and stored (not deflated).
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", parts.opf);
  zip.file("OEBPS/nav.xhtml", parts.nav);
  for (const ch of parts.chapters) zip.file("OEBPS/" + ch.name, ch.xhtml);
  return { blob: await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" }), language: parts.language };
}
function epubFilename(title) {
  const base = String(title || "book").replace(/[\\/:*?"<>|]+/g, "").trim() || "book";
  return base + ".epub";
}

/* ------------------------------------------------------------------ */
/* Mini App send-to-Kindle (bot-only, primary delivery path)           */
/*                                                                     */
/* Shown ONLY when the page runs inside Telegram as a Mini App         */
/* (window.Telegram.WebApp.initData is a non-empty string). The        */
/* EPUB — built on the END USER's device — is POSTed as base64 to      */
/* the bot, which validates initData, checks the linked Kindle        */
/* email + the 3/day allowance, and emails the EPUB via Resend.        */
/* There is NO direct download on this page (website rule,            */
/* 2026-11-18): the EPUB reaches the reader by email, or as a file    */
/* in the Telegram chat (USB) for in-chat conversions. No server-side */
/* conversion, no localhost, nothing on the site owner's device.       */
/* ------------------------------------------------------------------ */
function telegramInitData() {
  const tg = typeof window !== "undefined" ? window.Telegram : null;
  const initData = tg && tg.WebApp ? tg.WebApp.initData : "";
  return isTelegramWebAppInitData(initData) ? initData : "";
}

function updateSendKindleButton() {
  const btn = $("sendKindleBtn");
  if (!btn) return;
  // Visible only inside Telegram AND once an EPUB is ready (the
  // standard build, or the whole-book enhanced one — either is
  // what the send carries).
  show(btn, !!telegramInitData() && !!(current && (current.epubBlob || current.enhancedBlob)));
}

/** The EPUB the send carries: the whole-book enhanced build when
 *  one was fetched (the user asked for it explicitly), else the
 *  standard build (which the per-page queue rebuilds from the
 *  enhanced pages as they land, so it is the best available too). */
function sendableEpubBlob() {
  if (!current) return null;
  return current.enhancedBlob || current.epubBlob || null;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function sendStatus(text, kind) {
  const el = $("sendKindleStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "note " + (kind || "");
  show(el, !!text);
}

async function sendToKindle() {
  const btn = $("sendKindleBtn");
  const blob = sendableEpubBlob();
  if (!current || !blob) {
    sendStatus("لا توجد نسخة EPUB جاهزة بعد — أكمل التحويل أولاً.", "err");
    return;
  }
  const initData = telegramInitData();
  if (!initData) {
    sendStatus("افتح المحوّل من بوت RliBook (أمر /convert) لتفعيل الإرسال.", "err");
    return;
  }
  if (blob.size > MINIAPP_SEND_MAX_EPUB_BYTES) {
    sendStatus(miniappSendErrorMessage("E_TOO_BIG"), "err");
    return;
  }
  btn.disabled = true;
  sendStatus("جارٍ الإرسال إلى إيميل الكيندل…", "");
  try {
    const epubBase64 = await blobToBase64(blob);
    // v4.8.47 — Convert-button extras: the ticket binds the EPUB
    // to the bot's server-side source key (dedupe cache), pages is
    // the PDF's page count (bot's 500-page cap), quality is
    // "enhanced" when any page was GPU-enhanced (else "standard"
    // — the Tesseract fallback, which is what the send carries
    // when the GPU server is down).
    const extra = {
      ticket: convertBook ? convertBook.ticket : undefined,
      pages: current.totalPages || undefined,
      quality: current.quality === "enhanced" ? "enhanced" : undefined,
    };
    const res = await fetch(MINIAPP_CONVERT_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildMiniappSendPayload(initData, current.epubName, epubBase64, extra)),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (data && data.ok === true) {
      sendStatus("✅ تم الإرسال إلى إيميل الكيندل — سيصل كتابك إلى مكتبة الكيندل خلال دقائق.", "ok");
    } else if (data && data.ok === false && data.code) {
      sendStatus(miniappSendErrorMessage(data.code, data.waitMinutes), "err");
    } else {
      sendStatus("تعذّر الإرسال، حاول مجدداً — لم يُحتسب هذا التحويل من حصتك.", "err");
    }
  } catch (e) {
    // Network failure before the bot answered: the bot never saw
    // the request, so the conversion was not counted.
    sendStatus("تعذّر الاتصال — تحقق من الإنترنت وحاول مجدداً. لم يُحتسب هذا التحويل.", "err");
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Convert-button book: fetch the pre-loaded PDF (v4.8.47)             */
/* ------------------------------------------------------------------ */

/** Fetch a Convert-button book's PDF and load it as the current
 *  file, then start the conversion on its own. The PDF comes from
 *  the signed proxy URL minted by /api/dl-token (same origin) —
 *  fetched into memory only, never downloaded by the user — and
 *  the conversion + email finish in the background, so the user
 *  may close the browser. Any failure here leaves the page usable:
 *  the user can still pick a file by hand. */
async function loadConvertBook(params) {
  note("أجلب ملف PDF من المكتبة…", "");
  try {
    const tokenRes = await fetch(convertBookDlTokenUrl(params));
    let tokenData = null;
    try {
      tokenData = await tokenRes.json();
    } catch (e) {
      tokenData = null;
    }
    const url =
      tokenData && tokenData.ok
        ? tokenData.url || (tokenData.short ? tokenData.short : "")
        : "";
    if (!url) {
      note("تعذّر جلب الملف من المكتبة — حاول مجدداً من البوت.", "err");
      await postConvertStatus("failed", "could not fetch book");
      return;
    }
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) throw new Error(`fetch ${pdfRes.status}`);
    const bytes = new Uint8Array(await pdfRes.arrayBuffer());
    if (bytes.length === 0 || bytes.length > CONVERT_MAX_INPUT_BYTES) {
      note(
        bytes.length === 0
          ? "الملف فارغ — حاول مجدداً من البوت."
          : "الملف أكبر من 10 MB — لا يمكن تحويله هنا.",
        "err",
      );
      await postConvertStatus("failed", "book too big or empty");
      return;
    }
    const filename = `book-${params.postId}.pdf`;
    await onFileChosen(new File([bytes], filename, { type: "application/pdf" }));
    // Conversion starts on its own — the user may close the
    // browser; the EPUB is emailed when it is ready.
    await runJob();
  } catch (e) {
    console.error(e);
    note("تعذّر جلب الملف من المكتبة — تحقق من الإنترنت وحاول مجدداً من البوت.", "err");
    await postConvertStatus(
      "failed",
      e && e.message ? String(e.message).slice(0, 200) : "fetch failed",
    );
  }
}

/* ------------------------------------------------------------------ */
/* conversion state                                                    */
/* ------------------------------------------------------------------ */
let current = null; // { hash, filename, title, bytes, totalPages, pages: Map(n -> page), quality, enhancedBlob }

/* Convert-button book (v4.8.47): the bot opened the page with a
 * library PDF pre-loaded (?h=&p=&f=pdf&ticket=). Null for a plain
 * /convert open (the user picks a file by hand). */
let convertBook = null; // { handle, postId, format, ticket }
/** The "converting…" ping was already sent for this book (runJob
 *  can run again on resume — the status is sent once). */
let convertStatusSent = false;

/** Best-effort status ping to the bot ("started" / "failed") for a
 *  Convert-button book: the bot sends the "converting…" / failure
 *  message in chat, so the user hears about it even after closing
 *  the browser. Fire-and-forget — a ping failure never blocks the
 *  conversion. */
async function postConvertStatus(status, error) {
  if (!convertBook || !convertBook.ticket) return;
  const initData = telegramInitData();
  if (!initData) return;
  try {
    await fetch(MINIAPP_CONVERT_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildMiniappStatusPayload(initData, convertBook.ticket, status, error),
      ),
    });
  } catch (e) {
    /* best-effort only */
  }
}
let worker = null;
let cancelled = false;

function pageRow(n, text, script, route, quality) {
  const routeLabel = route.also
    ? `${route.engine} + ${route.also} (mixed page)`
    : route.engine;
  const qualityLabel = quality === "enhanced" ? `<span class="page-quality">✦ محسّنة</span>` : "";
  return (
    `<div class="page-row"><span class="page-n">صفحة ${n}</span>` +
    `<span class="page-script">${script === "arabic" ? "عربية" : script === "latin" ? "إنجليزية" : script === "mixed" ? "مختلطة" : "؟"}</span>` +
    `<span class="page-route">${esc(routeLabel)}</span>` +
    qualityLabel +
    `<span class="page-chars">${text.length} حرف</span></div>`
  );
}

function renderProgress() {
  if (!current) return;
  const done = current.pages.size;
  const total = current.totalPages;
  $("progressBar").style.width = total ? Math.round((done / total) * 100) + "%" : "0%";
  $("progressText").textContent = `تمت ${done} من ${total} صفحة`;
  const list = $("pageList");
  list.innerHTML = [...current.pages.values()]
    .sort((a, b) => a.n - b.n)
    .map((p) => pageRow(p.n, p.text, p.script, p.route, p.quality))
    .join("");
  show($("result"), done === total && total > 0);
  updateSendKindleButton();
  if (done === total && total > 0) {
    const enhancedCount = [...current.pages.values()].filter((p) => p.quality === "enhanced").length;
    $("resultMeta").textContent =
      `جودة قياسية (على جهازك) — ${total} صفحة، ` +
      (enhancedCount > 0
        ? `${enhancedCount} صفحة حُسّنت على الخادم (✦).`
        : current.quality === "enhanced"
          ? "نُسخة محسّنة جاهزة أيضاً."
          : "بلا خادم وبلا بطاقة.");
  }
}

async function saveProgress() {
  if (!current) return;
  await dbPut({
    hash: current.hash,
    filename: current.filename,
    title: current.title,
    totalPages: current.totalPages,
    override: current.override,
    dpi: current.dpi,
    pages: [...current.pages.values()],
    quality: current.quality,
    updatedAt: new Date().toISOString(),
  });
}

async function finishJob() {
  if (!current) return;
  const pages = [...current.pages.values()].sort((a, b) => a.n - b.n);
  const { blob } = await buildEpubBlob(current.title, pages);
  current.epubBlob = blob;
  current.epubName = epubFilename(current.title);
  renderProgress();
  // No direct download on this page (website rule, 2026-11-18):
  // the EPUB reaches the reader by email (the send button below,
  // or automatically for a Convert-button book) or as a file in
  // the Telegram chat (in-chat conversions). A standalone visitor
  // (no Telegram) is told to open the converter from the bot.
  if (convertBook && convertBook.ticket && telegramInitData()) {
    note("جارٍ التجهيز… جارٍ الإرسال إلى إيميل قارئك…", "");
  } else if (!telegramInitData()) {
    note(
      "اكتمل التحويل — لتصلك نسخة EPUB، افتح المحوّل من بوت RliBook (أمر /convert) أو حوّل من داخل الشات؛ تُرسل النسخة إلى إيميل قارئك أو كملف في الشات (USB). لا يوجد تحميل مباشر هنا.",
      "ok",
    );
  } else {
    note("اكتمل التحويل — نسخة EPUB جاهزة. استخدم زر «📧 أرسل لميل قارئي» لإرسالها إلى إيميل قارئك.", "ok");
  }
  show($("enhanceBox"), true);
  updateEnhanceBox();
  // Per-page cloud enhancement, fire-and-forget: the standard
  // result above is already shown; the queue only upgrades
  // qualifying pages in place, one at a time.
  autoEnhance();
  // Catalog Convert button (2026-11-18): the book came from the
  // catalog — send the EPUB to the reader's email directly, no
  // download link, no extra tap. The standard build is the
  // sendable one; the queue rebuilds it in place, so a later
  // manual send (the button stays visible) carries the enhanced
  // pages.
  if (convertBook && convertBook.ticket && telegramInitData()) {
    await sendToKindle();
  }
}

async function ocrPage(canvas, pageNo) {
  const langs = tesseractLangsForOverride(current.override);
  if (!worker) {
    worker = await Tesseract.createWorker(langs, 1, {
      workerPath: "/site/convert/vendor/worker.min.js",
      // corePath is a DIRECTORY: the worker appends
      // "tesseract-core-simd-lstm.wasm.js" (the single-file core,
      // wasm embedded — no separate .wasm fetch to resolve). A
      // file path here loads the split .js+.wasm core, whose .wasm
      // fetch never resolves inside the worker and hangs init
      // (proven live 2026-11-16: core .js fetched, no .wasm, no
      // eng traineddata, worker stuck >300 s).
      corePath: "/site/convert/vendor/",
      langPath: "/site/convert/vendor/traineddata",
      gzip: true,
      logger: () => {},
    });
  }
  const { data } = await worker.recognize(canvas);
  const text = cleanOcrText(data.text || "");
  const script = detectPageScript(text);
  const route = routePage(text, current.override);
  // Mean word confidence (0–100) — the smart-routing signal:
  // pages at/above the threshold keep this Tesseract text and are
  // never sent to any enhancement tier (see pageNeedsEnhancement).
  const meanConfidence = meanWordConfidence(data.words || []);
  return { n: pageNo, text, script, route, meanConfidence };
}

async function runJob() {
  const btn = $("runBtn");
  btn.disabled = true;
  show($("cancelBtn"), true);
  cancelled = false;
  note("");
  // v4.8.47 — Convert-button book: the conversion is starting —
  // tell the bot once (it sends "converting…" in chat). The user
  // may close the browser from here: the EPUB is emailed when it
  // is ready.
  if (convertBook && !convertStatusSent) {
    convertStatusSent = true;
    await postConvertStatus("started");
  }
  // Catalog Convert button (2026-11-18): the page is preparing the
  // book — say so plainly ("جارٍ التجهيز…") while it converts.
  if (convertBook) {
    note("جارٍ التجهيز… يحوّل الكتاب صفحة صفحة على جهازك.", "");
  }
  try {
    const data = current.bytes;
    const ext = current.filename.toLowerCase().split(".").pop();
    if (ext === "pdf") {
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      // Kept so the enhancement queue can re-render a page image
      // later without re-parsing the file.
      current.pdfDoc = pdf;
      current.totalPages = pdf.numPages;
      // v4.8.48 — 500-page cap: over the cap the book is refused
      // before any OCR (the bot enforces the same cap on the send).
      if (pdf.numPages > CONVERT_MAX_PAGES) {
        note(
          `هذا الكتاب فيه ${pdf.numPages} صفحة — فوق حد الـ ${CONVERT_MAX_PAGES} صفحة لكل تحويل. قسّمه إلى أجزاء أصغر ثم حوّل كل جزء.`,
          "err",
        );
        await postConvertStatus("failed", `too many pages: ${pdf.numPages}`);
        return;
      }
      renderProgress();
      for (let n = 1; n <= pdf.numPages; n++) {
        if (cancelled) break;
        if (current.pages.has(n)) continue;
        const page = await pdf.getPage(n);
        // Render at the chosen DPI, but never beyond ~3500 px on the
        // long side: a page whose size is already in pixels (some
        // scan-to-PDF tools do this) would otherwise render a
        // 40-megapixel canvas and stall the OCR worker.
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(current.dpi / 72, 3500 / Math.max(v1.width, v1.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        page.cleanup();
        const result = await ocrPage(canvas, n);
        canvas.width = 0;
        canvas.height = 0;
        current.pages.set(n, result);
        await saveProgress();
        renderProgress();
      }
    } else {
      // Single image = one page.
      current.totalPages = 1;
      renderProgress();
      if (!current.pages.has(1)) {
        const blob = new Blob([data], { type: current.mime });
        const url = URL.createObjectURL(blob);
        try {
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = url;
          });
          const scale = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          const result = await ocrPage(canvas, 1);
          canvas.width = 0;
          canvas.height = 0;
          current.pages.set(1, result);
          await saveProgress();
          renderProgress();
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    }
    if (cancelled) {
      note("أُوقف التحويل — تقدّمك محفوظ، أعد اختيار الملف نفسه للاستئناف.", "");
    } else {
      await finishJob();
    }
  } catch (err) {
    console.error(err);
    note("تعذّر التحويل: " + (err && err.message ? err.message : err) + " — تقدّمك محفوظ، حاول مجدداً.", "err");
    // v4.8.47 — tell the bot the conversion failed (it sends the
    // failure message in chat). A cancellation is not an error —
    // it never reaches this catch.
    await postConvertStatus(
      "failed",
      err && err.message ? String(err.message).slice(0, 200) : "conversion failed",
    );
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch (e) {
        /* already gone */
      }
      worker = null;
    }
    btn.disabled = false;
    show($("cancelBtn"), false);
  }
}

async function onFileChosen(file) {
  if (!file) return;
  const ext = file.name.toLowerCase().split(".").pop();
  if (!["pdf", "jpg", "jpeg", "png"].includes(ext)) {
    note("الصيغة مرفوضة — PDF أو JPG أو PNG فقط. ملفات EPUB فيها نص أصلاً ولا تحتاج تحويلاً.", "err");
    return;
  }
  if (file.size > CONVERT_MAX_INPUT_BYTES) {
    note("الملف أكبر من 10 MB — قسّمه إلى أجزاء أصغر أو اضغطه ثم أعد المحاولة.", "err");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = cacheKey(bytes);
  const title = file.name.replace(/\.[^.]*$/, "") || "book";
  const override = $("langSel").value;
  const dpi = Math.min(CONVERT_MAX_DPI, parseInt($("dpiSel").value, 10) || 200);
  const saved = await dbGet(hash).catch(() => null);
  current = {
    hash,
    filename: file.name,
    title,
    bytes,
    mime: file.type,
    totalPages: saved ? saved.totalPages : 0,
    pages: new Map((saved ? saved.pages : []).map((p) => [p.n, p])),
    override,
    dpi,
    quality: saved ? saved.quality || "standard" : "standard",
    enhancedBlob: null,
    pdfDoc: null, // pdf.js document, kept for re-rendering page images
    enhancing: false, // per-page queue running (guard against double runs)
  };
  show($("work"), true);
  show($("result"), false);
  show($("enhanceBox"), false);
  $("fileMeta").textContent =
    `${file.name} — ${(file.size / 1024 / 1024).toFixed(1)} MB — البصمة ${hash.slice(0, 12)}…` +
    (saved && saved.pages.length ? ` — استئناف: ${saved.pages.length} صفحة محفوظة.` : "");
  renderProgress();
  if (saved && saved.pages.length && saved.totalPages && saved.pages.length >= saved.totalPages) {
    await finishJob();
    // finishJob sets its own "done" note — restore the resume wording.
    note("هذا الملف محوّل من قبل — النتيجة جاهزة.", "ok");
    return;
  }
  note(saved && saved.pages.length ? "استئناف من حيث توقفت." : "جاهز — اضغط «ابدأ التحويل».", "");
}

/* ------------------------------------------------------------------ */
/* cloud enhancement queue (secondary, optional)                       */
/* ------------------------------------------------------------------ */
function cloudUrl() {
  return (localStorage.getItem(CLOUD_URL_KEY) || "").trim().replace(/\/+$/, "");
}
function updateEnhanceBox() {
  const url = cloudUrl();
  $("cloudUrl").value = url;
  show($("enhanceActions"), !!url);
  if (!url) {
    $("cloudStatus").textContent = "لا يوجد خادم تحسين مضبوط — التحويل على جهازك يعمل كاملاً بدونه.";
  } else {
    $("cloudStatus").textContent = "خادم التحسين: " + url;
  }
  // OCR.space key status (the cheap tier — the reader's own key,
  // stored in their browser only).
  const key = ocrSpaceKey();
  $("ocrSpaceKey").value = key;
  show($("retryEnhanceBtn"), !!(current && current.pages && current.pages.size > 0));
  if (!key) {
    $("ocrSpaceStatus").textContent = "بلا مفتاح — تُتخطى طبقة OCR.space بصمت، ويبقى GPU / Tesseract.";
  } else {
    $("ocrSpaceStatus").textContent = "مفتاح OCR.space محفوظ في متصفحك (500 صفحة/يوم لكل جهاز).";
  }
}

async function healthCheck(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url + "/health", { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Per-page cloud enhancement queue (automatic, after the
 *  client-side result is shown). The TIERED queue (2026-11-18,
 *  capacity research): for each WEAK page (Tesseract mean
 *  confidence below the threshold — strong pages are never sent),
 *  in order: content-hash cache -> OCR.space (the reader's own
 *  free key, browser-side) -> GPU (the configured cloud URL).
 *  A cache hit skips both network tiers, so a second reader of
 *  the same book/page pays zero. A dead tier never breaks the
 *  conversion: the page keeps its standard text and the queue
 *  goes on; a quota disables only that tier for the rest of the
 *  run. The standard result is already shown and downloadable
 *  before this starts; the queue only upgrades weak pages in
 *  place, and the EPUB is rebuilt so the download / send-to-Kindle
 *  buttons always serve the best text so far. */
function ocrSpaceKey() {
  return (localStorage.getItem(OCRSPACE_KEY) || "").trim();
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas toBlob failed"))), "image/png");
  });
}

async function getPageImage(page) {
  const ext = current.filename.toLowerCase().split(".").pop();
  if (ext !== "pdf") {
    // Single image input: the original file bytes are the page.
    return new Blob([current.bytes], { type: current.mime || "image/png" });
  }
  if (!current.pdfDoc) throw new Error("no PDF document for re-render");
  const pdfPage = await current.pdfDoc.getPage(page.n);
  const v1 = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(current.dpi / 72, 3500 / Math.max(v1.width, v1.height));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  pdfPage.cleanup();
  const blob = await canvasToBlob(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

/** The page image for the OCR.space tier: the free tier caps at
 *  1 MB, so a PNG over the cap is re-encoded as JPEG (quality
 *  0.85, long side capped at 2000 px) — text pages compress far
 *  better as JPEG and stay readable. If the JPEG is still over
 *  the cap the PNG is returned and the tier answers "too-big"
 *  (the GPU tier, 10 MB cap, still gets its shot). */
async function getPageImageForOcrSpace(page) {
  const png = await getPageImage(page);
  if (!png || (typeof png.size === "number" && png.size <= OCR_SPACE_MAX_IMAGE_BYTES)) {
    return png;
  }
  // Re-encode as JPEG via a canvas.
  const url = URL.createObjectURL(png);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    canvas.width = 0;
    canvas.height = 0;
    return jpeg || png;
  } catch (e) {
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function autoEnhance() {
  if (!current || current.enhancing) return;
  const url = cloudUrl();
  const key = ocrSpaceKey();
  const pages = [...current.pages.values()].sort((a, b) => a.n - b.n);
  const weak = pages.filter((p) => p.quality !== "enhanced" && pageNeedsEnhancement(p));
  if (weak.length === 0) return;
  // Nothing to gain without any tier AND without a stored image
  // hash to check the cache by: a fresh book with no key and no
  // GPU URL would only re-render pages for cache lookups that
  // must miss. Resumed books (stored imageHash) still get their
  // cache-only pass.
  const hasTier = !!(key || url);
  const hasStoredHash = weak.some((p) => typeof p.imageHash === "string" && p.imageHash);
  if (!hasTier && !hasStoredHash) return;
  current.enhancing = true;
  const statusEl = $("enhanceStatus");
  const setStatus = (t) => {
    if (statusEl) statusEl.textContent = t;
  };
  const tierNote = [
    key ? "OCR.space" : null,
    url ? "GPU" : null,
  ].filter(Boolean).join(" + ") || "الكاش فقط";
  setStatus(`جارٍ تحسين ${weak.length} صفحة ضعيفة (${tierNote})… (نسختك القياسية جاهزة بالفعل)`);
  let failed = 0;
  try {
    const summary = await runTieredEnhancementQueue({
      fetchFn: fetch,
      gpuBaseUrl: url,
      ocrSpaceKey: key,
      pages: weak,
      getImage: getPageImage,
      getOcrSpaceImage: getPageImageForOcrSpace,
      getCached: (hash) => dbGetEnhanced(hash).catch(() => null),
      putCached: (hash, entry) => dbPutEnhanced({ hash, ...entry }).catch(() => {}),
      override: current.override,
      timeoutMs: ENHANCE_PAGE_TIMEOUT_MS,
      onPageEnhanced: async (page, result) => {
        page.text = result.text;
        page.script = detectPageScript(result.text);
        page.route = routePage(result.text, current.override);
        page.quality = "enhanced";
        page.enhancedEngine = result.engine;
        page.enhancedSource = result.source;
        // Any enhanced page lifts the whole job to "enhanced" so
        // the send-to-Kindle payload carries quality=enhanced.
        current.quality = "enhanced";
        await saveProgress();
        // Rebuild the EPUB so the download / send-to-Kindle
        // buttons serve the enhanced text immediately.
        const rebuilt = await buildEpubBlob(
          current.title,
          [...current.pages.values()].sort((a, b) => a.n - b.n)
        );
        current.epubBlob = rebuilt.blob;
        renderProgress();
      },
      onPageSkipped: (_page, _reason) => {
        failed++;
      },
      isCancelled: () => !current,
    });
    const fromCache = summary.enhancedFromCache;
    const fromOcr = summary.enhancedFromOcrSpace;
    const fromGpu = summary.enhancedFromGpu;
    const parts = [];
    if (fromCache > 0) parts.push(`${fromCache} من الكاش`);
    if (fromOcr > 0) parts.push(`${fromOcr} عبر OCR.space`);
    if (fromGpu > 0) parts.push(`${fromGpu} عبر GPU`);
    if (summary.enhanced > 0 && summary.skipped === 0) {
      setStatus(`✅ حُسّنت ${summary.enhanced} صفحة (${parts.join("، ")}) — نسخة EPUB الحالية تتضمنها.`);
    } else if (summary.enhanced > 0) {
      setStatus(
        `حُسّنت ${summary.enhanced} صفحة (${parts.join("، ")})؛ ${summary.skipped} صفحة بقيت بالجودة القياسية` +
          (summary.stoppedOnGpuQuota ? " (بلغ خادم GPU حدّه اليومي)." : "") +
          (summary.stoppedOnOcrSpaceQuota ? " (بلغ OCR.space حدّه اليومي)." : ".")
      );
    } else if (summary.stoppedOnGpuQuota || summary.stoppedOnOcrSpaceQuota) {
      setStatus("بلغت طبقات التحسين حدّها اليومي — نسختك القياسية جاهزة وتعمل.");
    } else {
      // Small note only: the standard result is unaffected.
      setStatus("التحسين غير متاح الآن — نسختك القياسية جاهزة وتعمل.");
    }
  } catch (e) {
    // The queue itself must never throw into the page: standard
    // text stands, one small note.
    setStatus("التحسين غير متاح الآن — نسختك القياسية جاهزة وتعمل.");
  } finally {
    if (current) current.enhancing = false;
  }
}

async function requestEnhanced() {
  if (!current || !current.bytes) return;
  const url = cloudUrl();
  if (!url) return;
  const btn = $("enhanceBtn");
  btn.disabled = true;
  $("enhanceStatus").textContent = "أتحقق من خادم التحسين…";
  const health = await healthCheck(url, ENHANCE_TIMEOUT_MS);
  if (!health || health.ok !== true) {
    $("enhanceStatus").textContent =
      "خادم التحسين غير متاح الآن — نسختك القياسية جاهزة وتعمل. حاول لاحقاً.";
    btn.disabled = false;
    return;
  }
  $("enhanceStatus").textContent = "أرسل الملف للتحسين (قد يستغرق دقائق)…";
  let jobId = null;
  let epubB64 = null;
  let quality = "enhanced";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let res;
    try {
      res = await fetch(url + "/enhance", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": current.mime || "application/pdf",
          "X-Enhance-Filename": encodeURIComponent(current.filename),
          "X-Convert-Language": current.override,
        },
        body: current.bytes,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      $("enhanceStatus").textContent = "بلغ خادم التحسين حدّه اليومي — نسختك القياسية جاهزة.";
      btn.disabled = false;
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.status === "done" && data.epub_b64) {
      epubB64 = data.epub_b64;
    } else if (data.job_id) {
      jobId = data.job_id;
      const started = Date.now();
      while (Date.now() - started < ENHANCE_POLL_MAX_MS) {
        await new Promise((r) => setTimeout(r, ENHANCE_POLL_MS));
        const poll = await fetch(url + "/enhance/" + encodeURIComponent(jobId));
        if (!poll.ok) throw new Error("HTTP " + poll.status);
        const pdata = await poll.json();
        if (pdata.status === "done" && pdata.epub_b64) {
          epubB64 = pdata.epub_b64;
          quality = pdata.quality || "enhanced";
          break;
        }
        if (pdata.status === "failed") throw new Error(pdata.error || "enhancement failed");
        $("enhanceStatus").textContent = "جارٍ التحسين على الخادم… (أبقِ الصفحة مفتوحة)";
      }
    }
  } catch (e) {
    // Silent fallback: the client-side result stands.
    $("enhanceStatus").textContent =
      "تعذّر التحسين الآن (" + (e && e.message ? e.message : "خطأ") + ") — نسختك القياسية جاهزة وتعمل.";
    btn.disabled = false;
    return;
  }
  if (!epubB64) {
    $("enhanceStatus").textContent = "انتهت مهلة التحسين — نسختك القياسية جاهزة.";
    btn.disabled = false;
    return;
  }
  const bin = atob(epubB64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  current.enhancedBlob = new Blob([bytes], { type: "application/epub+zip" });
  current.quality = "enhanced";
  await saveProgress();
  renderProgress();
  // The enhanced build is now what the send button carries (no
  // direct download on this page — website rule, 2026-11-18).
  $("enhanceStatus").textContent = "وصلت النسخة المحسّنة (جودة محسّنة) — استخدم زر «📧 أرسل لميل قارئي» لإرسالها إلى إيميل قارئك.";
  updateSendKindleButton();
  btn.disabled = false;
}

/* ------------------------------------------------------------------ */
/* wire up                                                             */
/* ------------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  // Inside Telegram, tell the Mini App host we are ready.
  try {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.ready) {
      window.Telegram.WebApp.ready();
    }
  } catch (e) {
    /* not in Telegram — the send button stays hidden */
  }
  $("fileInput").addEventListener("change", (e) => onFileChosen(e.target.files[0]));
  $("runBtn").addEventListener("click", runJob);
  $("cancelBtn").addEventListener("click", () => {
    cancelled = true;
  });
  $("sendKindleBtn").addEventListener("click", sendToKindle);
  $("saveCloudBtn").addEventListener("click", async () => {
    const url = $("cloudUrl").value.trim().replace(/\/+$/, "");
    localStorage.setItem(CLOUD_URL_KEY, url);
    updateEnhanceBox();
    if (!url) {
      $("cloudStatus").textContent = "حُفظ — لا يوجد خادم تحسين. التحويل على جهازك يعمل كاملاً.";
      return;
    }
    $("cloudStatus").textContent = "أتحقق…";
    const health = await healthCheck(url, ENHANCE_TIMEOUT_MS);
    if (!health) {
      $("cloudStatus").textContent = "تعذّر الوصول إلى " + url + " — تحقق من الرابط، ونسختك القياسية تعمل بدونه.";
      return;
    }
    const engines = Object.entries(health.engines || {})
      .filter(([, v]) => v.available)
      .map(([k]) => k)
      .join(", ");
    $("cloudStatus").textContent =
      `متصل — المحركات المتاحة: ${engines || "؟"}، ` +
      `الحصة اليومية: ${health.quota ? health.quota.pages_today + "/" + (health.quota.budget || "∞") + " صفحة" : "؟"}.`;
  });
  $("saveOcrSpaceBtn").addEventListener("click", async () => {
    const key = $("ocrSpaceKey").value.trim();
    localStorage.setItem(OCRSPACE_KEY, key);
    updateEnhanceBox();
    if (!key) {
      $("ocrSpaceStatus").textContent = "حُفظ — بلا مفتاح، تُتخطى طبقة OCR.space.";
      return;
    }
    $("ocrSpaceStatus").textContent = "حُفظ المفتاح في متصفحك — تُفعّل طبقة OCR.space للصفحات الضعيفة.";
    // A key saved after the run: retry the tiered queue over the
    // weak pages that are still un-enhanced (autoEnhance reads
    // the key fresh for each page).
    if (current && current.pages && current.pages.size > 0) {
      await autoEnhance();
    }
  });
  $("retryEnhanceBtn").addEventListener("click", async () => {
    await autoEnhance();
  });
  $("enhanceBtn").addEventListener("click", requestEnhanced);
  updateEnhanceBox();
  // v4.8.47 — Convert-button book: the bot opened the page with a
  // library PDF pre-loaded (?h=&p=&f=pdf&ticket=). Fetch it and
  // start the conversion on its own; a plain /convert open has no
  // params and behaves exactly as before (the user picks a file).
  convertBook = parseConvertBookParams(window.location.search || "");
  if (convertBook) {
    convertStatusSent = false;
    loadConvertBook(convertBook);
  }
});
