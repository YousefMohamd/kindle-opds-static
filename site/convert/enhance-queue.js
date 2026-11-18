/**
 * RliBook cloud enhancement queue — pure logic (no DOM).
 *
 * Used by site/convert/convert-app.js in the browser and tested in
 * Node by site/convert/convert.test.mjs (§K). The queue runs AFTER
 * the client-side Tesseract result is shown — it NEVER blocks the
 * conversion, and it NEVER replaces a page's text with nothing:
 * any failure, quota error, or timeout leaves the client-side
 * ("standard") text in place and is reported only as a small note
 * in the page's status line.
 *
 * Which pages qualify: the cloud engines only beat Tesseract
 * where Tesseract is weak — Arabic pages (Baseer for clean modern
 * Arabic, Qari for diacritic-rich classical Arabic). A Latin page
 * qualifies only when the user explicitly chose English
 * (override "en"), because PP-OCRv6 is the English cloud engine
 * and the user asked for it. Sending every Latin page would burn
 * the operator's daily quota for a small gain (Tesseract is
 * already good on clean modern print — see docs/ocr-conversion.md).
 *
 * Endpoint contract (server.py POST /enhance-page):
 *   POST {baseUrl}/enhance-page
 *     Content-Type: image/png | image/jpeg
 *     X-Convert-Language: auto | ar | ar-classical | en | mixed
 *     Body: one page image, <= 10 MB
 *   -> 200 {"ok": true, "text", "engine", "confidence", "lang"}
 *      429 = daily budget reached (stop the queue — every later
 *          page would 429 too)
 *      anything else = that page keeps its standard text
 */

import { cacheKey, cleanOcrText, detectPageScript, pageNeedsEnhancement, routePage } from "./ocr-client.js";
import { ocrSpaceLanguageForPage, ocrSpacePage } from "./ocr-space.js";

export const ENHANCE_PAGE_TIMEOUT_MS = 60000;
export const ENHANCE_PAGE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** True when this page is worth sending to the cloud tier.
 *  page: { text, script?, route? } — route may be precomputed by
 *  convert-app.js (from routePage at OCR time); otherwise it is
 *  computed here from the page text + override. */
export function pageQualifiesForEnhancement(page, override = "auto") {
  const text = (page && page.text) || "";
  const route = (page && page.route) || routePage(text, override);
  const engine = route.engine;
  if (engine === "baseer" || engine === "qari") return true;
  // Latin pages: only when the user explicitly asked for English
  // enhancement (override "en" -> PP-OCRv6). Auto-detected Latin
  // pages stay on Tesseract — it is already good on clean print.
  if (override === "en" && engine === "pp-ocrv6") return true;
  return false;
}

/** Language hint for POST /enhance-page, from the page + override.
 *  The override wins (the user knows the book); otherwise the
 *  detected script decides. "mixed" pages send "mixed" so the
 *  server probes and merges both engines by script. */
export function languageHintForPage(page, override = "auto") {
  if (override === "ar") return "ar";
  if (override === "ar-classical") return "ar-classical";
  if (override === "en") return "en";
  const script = (page && page.script) || detectPageScript((page && page.text) || "");
  if (script === "arabic") return "ar";
  if (script === "latin") return "en";
  if (script === "mixed") return "mixed";
  return "auto";
}

class TimeoutError extends Error {
  constructor() {
    super("enhancement timed out");
    this.name = "TimeoutError";
  }
}

/** POST one page image to the enhancement endpoint.
 *  fetchFn: (url, init) -> Response-like { status, ok, json() }
 *    (global fetch in the browser; a mock in tests).
 *  image: Blob | Uint8Array (the page, PNG/JPEG, <= 10 MB).
 *  Returns { ok: true, text, engine, confidence, lang } on
 *  success, or { ok: false, reason } where reason is one of:
 *    "quota"       429 — daily budget reached
 *    "timeout"     no answer within timeoutMs
 *    "unavailable" network error, or a non-2xx status other
 *                  than 429 (server down, 502 OCR failure, ...)
 *    "empty"       server answered but with no usable text
 *    "too-big"     image over the 10 MB cap (never sent)
 *  Never throws for an expected failure — the caller treats every
 *  { ok: false } as "keep the standard text". */
export async function enhancePage({ fetchFn, baseUrl, image, langHint = "auto", timeoutMs = ENHANCE_PAGE_TIMEOUT_MS }) {
  const fetchImpl = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: "unavailable" };
  const size = image ? (typeof image.size === "number" ? image.size : image.length || 0) : 0;
  if (size > ENHANCE_PAGE_MAX_IMAGE_BYTES) return { ok: false, reason: "too-big" };
  const url = String(baseUrl || "").replace(/\/+$/, "") + "/enhance-page";
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (ctrl) {
        try {
          ctrl.abort();
        } catch (e) {
          /* already gone */
        }
      }
      reject(new TimeoutError());
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchImpl(url, {
        method: "POST",
        signal: ctrl ? ctrl.signal : undefined,
        headers: {
          "Content-Type": image && image.type ? image.type : "image/png",
          "X-Convert-Language": langHint,
        },
        body: image,
      }),
      timeout,
    ]);
    if (res.status === 429) return { ok: false, reason: "quota" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      return { ok: false, reason: "unavailable" };
    }
    if (!data || data.ok !== true || typeof data.text !== "string") {
      return { ok: false, reason: "unavailable" };
    }
    const text = cleanOcrText(data.text);
    if (!text) return { ok: false, reason: "empty" };
    return {
      ok: true,
      text,
      engine: typeof data.engine === "string" ? data.engine : "",
      confidence: typeof data.confidence === "number" ? data.confidence : null,
      lang: typeof data.lang === "string" ? data.lang : "",
    };
  } catch (e) {
    if (e && e.name === "TimeoutError") return { ok: false, reason: "timeout" };
    // AbortError from the controller is the same timeout, seen
    // from the fetch side.
    if (e && (e.name === "AbortError" || e.name === "AbortError")) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run the queue over finished pages, in order, one at a time.
 *  pages: [{ n, text, script?, route? }] (sorted by n).
 *  getImage(page) -> Promise<Blob|Uint8Array> (the page image).
 *  onPageEnhanced(page, result) — called for every success; the
 *    app replaces the page text + rebuilds the EPUB there.
 *  onPageSkipped(page, reason) — called for every failure; the
 *    app only notes it (the standard text stays).
 *  isCancelled() -> bool — checked between pages.
 *  Returns { attempted, enhanced, skipped, stoppedOnQuota }.
 *  A quota failure stops the queue (later pages would 429 too);
 *  every other failure only skips that page and the queue goes on.
 *  Pages that do not qualify are never attempted and never counted. */
export async function runEnhancementQueue({
  fetchFn,
  baseUrl,
  pages,
  getImage,
  override = "auto",
  timeoutMs = ENHANCE_PAGE_TIMEOUT_MS,
  onPageEnhanced,
  onPageSkipped,
  isCancelled,
}) {
  const summary = { attempted: 0, enhanced: 0, skipped: 0, stoppedOnQuota: false };
  for (const page of pages || []) {
    if (isCancelled && isCancelled()) break;
    if (!pageQualifiesForEnhancement(page, override)) continue;
    let image = null;
    try {
      image = await getImage(page);
    } catch (e) {
      summary.attempted++;
      summary.skipped++;
      if (onPageSkipped) onPageSkipped(page, "unavailable");
      continue;
    }
    summary.attempted++;
    const result = await enhancePage({
      fetchFn,
      baseUrl,
      image,
      langHint: languageHintForPage(page, override),
      timeoutMs,
    });
    if (result.ok) {
      summary.enhanced++;
      if (onPageEnhanced) onPageEnhanced(page, result);
    } else {
      summary.skipped++;
      if (onPageSkipped) onPageSkipped(page, result.reason);
      if (result.reason === "quota") {
        summary.stoppedOnQuota = true;
        break;
      }
    }
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* tiered enhancement (2026-11-18, capacity research) — the durable   */
/* tier. The pipeline per weak page is:                               */
/*   Tesseract (browser) -> [cache hit?] -> OCR.space (reader's own   */
/*   free key, browser-side) -> GPU (cloud URL, /enhance-page) ->     */
/*   Tesseract fallback. A dead tier never breaks the conversion:    */
/*   every failure keeps the standard text and the queue goes on.    */
/*                                                                     */
/* Tier rules:                                                         */
/*   - Cache first: the page-image hash (sha256 of the image bytes)   */
/*     is looked up before any network call; a hit skips BOTH        */
/*     OCR.space and the GPU, so a second reader of the same book    */
/*     pays zero. The hash is stored on page.imageHash so a resumed  */
/*     job can hit the cache without re-rendering the page.          */
/*   - OCR.space is skipped for diacritic-rich / classical Arabic    */
/*     (route -> qari): it is Tesseract-class and cannot beat Qari   */
/*     on tashkeel; those pages go straight to the GPU.               */
/*   - The GPU tier keeps its old gate (pageQualifiesForEnhancement: */
/*     Arabic/mixed, or English with override "en").                 */
/*   - Quotas are per-tier and independent: an OCR.space quota stops */
/*     OCR.space for the rest of the run but the GPU keeps going;   */
/*     a GPU quota stops the GPU tier but OCR.space keeps going.    */
/* ------------------------------------------------------------------ */

/** Bytes of an image (Blob in the browser, Uint8Array in tests /
 *  in Node) as a Uint8Array, for hashing. */
export async function imageToBytes(image) {
  if (!image) return new Uint8Array(0);
  if (image instanceof Uint8Array) return image;
  if (typeof image.arrayBuffer === "function") {
    return new Uint8Array(await image.arrayBuffer());
  }
  return new Uint8Array(0);
}

/** Enhance ONE weak page through the tiers.
 *  page: { n, text, script?, route?, meanConfidence?, imageHash? }
 *    (imageHash is filled in here from the image bytes and kept on
 *    the page object so the caller can persist it).
 *  getImage(page) -> Promise<Blob|Uint8Array> (the page image).
 *  getOcrSpaceImage(page) -> Promise<Blob|Uint8Array> — the image
 *    for the OCR.space tier (defaults to getImage; the app passes
 *    a JPEG-downscaled variant because the free tier caps at 1 MB).
 *  getCached(hash) -> Promise<entry|null> — entry is
 *    { text, engine } (the app's IndexedDB "enhanced" store).
 *  putCached(hash, entry) -> Promise<void>.
 *  ocrSpaceKey: the user's own free OCR.space key ("" = tier off).
 *  gpuBaseUrl: the cloud URL ("" = tier off).
 *  ocrSpaceFetchFn / gpuFetchFn: fetch implementations (global
 *    fetch in the browser; mocks in tests).
 *  ocrSpaceDisabled / gpuDisabled: { current: bool } flags the
 *    caller uses to stop a tier after its quota is hit (shared
 *    across pages in one run — see runTieredEnhancementQueue).
 *  Returns { ok: true, text, engine, source } where source is
 *  "cache" | "ocr-space" | "gpu", or { ok: false, reason } where
 *  reason is the last failure ("quota" | "timeout" |
 *  "unavailable" | "empty" | "too-big" | "no-tier"). Never throws
 *  for an expected failure. */
export async function enhanceOnePage({
  page,
  getImage,
  getOcrSpaceImage,
  getCached,
  putCached,
  ocrSpaceKey,
  gpuBaseUrl,
  ocrSpaceFetchFn,
  gpuFetchFn,
  override = "auto",
  ocrSpaceDisabled,
  gpuDisabled,
  timeoutMs = ENHANCE_PAGE_TIMEOUT_MS,
}) {
  // 1. Cache first — by the stored image hash when the page
  //    already has one (a resumed job hits the cache without
  //    re-rendering the page image at all).
  if (page && typeof page.imageHash === "string" && page.imageHash && getCached) {
    try {
      const hit = await getCached(page.imageHash);
      if (hit && typeof hit.text === "string" && hit.text.trim()) {
        return { ok: true, text: hit.text, engine: hit.engine || "cache", source: "cache" };
      }
    } catch (e) {
      /* cache read failure is not fatal — fall through to tiers */
    }
  }
  // 2. The page image (needed for the hash, then for the tiers).
  let image = null;
  try {
    image = await getImage(page);
  } catch (e) {
    return { ok: false, reason: "unavailable" };
  }
  if (!image) return { ok: false, reason: "unavailable" };
  const bytes = await imageToBytes(image);
  if (bytes.length === 0) return { ok: false, reason: "unavailable" };
  const hash = cacheKey(bytes);
  if (page) page.imageHash = hash;
  // 3. Cache again by the freshly computed hash (the stored hash
  //    may have been missing or stale).
  if (getCached) {
    try {
      const hit = await getCached(hash);
      if (hit && typeof hit.text === "string" && hit.text.trim()) {
        return { ok: true, text: hit.text, engine: hit.engine || "cache", source: "cache" };
      }
    } catch (e) {
      /* fall through to tiers */
    }
  }
  const store = async (text, engine) => {
    if (!putCached) return;
    try {
      await putCached(hash, { text, engine, updatedAt: new Date().toISOString() });
    } catch (e) {
      /* cache write failure is not fatal */
    }
  };
  // 4. OCR.space — the cheap tier — unless the page routes to
  //    Qari (diacritic-rich / classical Arabic: OCR.space cannot
  //    beat Qari there, so skip it and save the reader's quota).
  const route = (page && page.route) || routePage((page && page.text) || "", override);
  const isQariPage = route.engine === "qari";
  if (ocrSpaceKey && !isQariPage && !(ocrSpaceDisabled && ocrSpaceDisabled.current)) {
    let ocrImage = image;
    try {
      ocrImage = getOcrSpaceImage ? await getOcrSpaceImage(page) : image;
    } catch (e) {
      ocrImage = image;
    }
    const ocr = await ocrSpacePage({
      fetchFn: ocrSpaceFetchFn,
      apiKey: ocrSpaceKey,
      image: ocrImage,
      langHint: ocrSpaceLanguageForPage(page, override),
    });
    if (ocr.ok) {
      await store(ocr.text, "ocr-space");
      return { ok: true, text: ocr.text, engine: "ocr-space", source: "ocr-space" };
    }
    if (ocr.reason === "quota" && ocrSpaceDisabled) ocrSpaceDisabled.current = true;
    // Any OCR.space failure falls through to the GPU tier —
    // except when there is no GPU tier at all, in which case the
    // OCR.space reason is the answer.
    if (!gpuBaseUrl || (gpuDisabled && gpuDisabled.current)) {
      return { ok: false, reason: ocr.reason };
    }
  }
  // 5. GPU — the strong tier — under its old script gate.
  if (gpuBaseUrl && !(gpuDisabled && gpuDisabled.current)) {
    if (!pageQualifiesForEnhancement(page, override)) {
      return { ok: false, reason: "no-tier" };
    }
    const gpu = await enhancePage({
      fetchFn: gpuFetchFn,
      baseUrl: gpuBaseUrl,
      image,
      langHint: languageHintForPage(page, override),
      timeoutMs,
    });
    if (gpu.ok) {
      await store(gpu.text, gpu.engine || "gpu");
      return { ok: true, text: gpu.text, engine: gpu.engine || "gpu", source: "gpu" };
    }
    if (gpu.reason === "quota" && gpuDisabled) gpuDisabled.current = true;
    return { ok: false, reason: gpu.reason };
  }
  return { ok: false, reason: "no-tier" };
}

/** Run the tiered queue over finished pages, in order, one at a
 *  time. The smart-routing gate is applied FIRST: a page whose
 *  Tesseract mean confidence is at/above the threshold keeps its
 *  standard text and is never sent anywhere (no image render, no
 *  cache lookup, no network). Weak pages go through enhanceOnePage
 *  (cache -> OCR.space -> GPU). onPageEnhanced(page, result) is
 *  called for every success (result.source tells which tier won);
 *  onPageSkipped(page, reason) for every failure. A quota failure
 *  disables only that tier for the rest of the run (the other tier
 *  keeps going) — unlike the GPU-only queue, which stops entirely
 *  on quota. Returns { attempted, enhanced, skipped,
 *  enhancedFromCache, enhancedFromOcrSpace, enhancedFromGpu,
 *  stoppedOnGpuQuota, stoppedOnOcrSpaceQuota }. */
export async function runTieredEnhancementQueue({
  fetchFn,
  gpuBaseUrl,
  ocrSpaceKey,
  pages,
  getImage,
  getOcrSpaceImage,
  getCached,
  putCached,
  override = "auto",
  timeoutMs = ENHANCE_PAGE_TIMEOUT_MS,
  onPageEnhanced,
  onPageSkipped,
  isCancelled,
}) {
  const summary = {
    attempted: 0,
    enhanced: 0,
    skipped: 0,
    enhancedFromCache: 0,
    enhancedFromOcrSpace: 0,
    enhancedFromGpu: 0,
    stoppedOnGpuQuota: false,
    stoppedOnOcrSpaceQuota: false,
  };
  const ocrSpaceDisabled = { current: false };
  const gpuDisabled = { current: false };
  for (const page of pages || []) {
    if (isCancelled && isCancelled()) break;
    if (!page || page.quality === "enhanced") continue;
    // Smart routing: strong Tesseract pages are never sent.
    if (!pageNeedsEnhancement(page)) continue;
    summary.attempted++;
    const result = await enhanceOnePage({
      page,
      getImage,
      getOcrSpaceImage,
      getCached,
      putCached,
      ocrSpaceKey,
      gpuBaseUrl,
      ocrSpaceFetchFn: fetchFn,
      gpuFetchFn: fetchFn,
      override,
      ocrSpaceDisabled,
      gpuDisabled,
      timeoutMs,
    });
    if (result.ok) {
      summary.enhanced++;
      if (result.source === "cache") summary.enhancedFromCache++;
      else if (result.source === "ocr-space") summary.enhancedFromOcrSpace++;
      else if (result.source === "gpu") summary.enhancedFromGpu++;
      if (onPageEnhanced) onPageEnhanced(page, result);
    } else {
      summary.skipped++;
      if (onPageSkipped) onPageSkipped(page, result.reason);
    }
    if (ocrSpaceDisabled.current) summary.stoppedOnOcrSpaceQuota = true;
    if (gpuDisabled.current) summary.stoppedOnGpuQuota = true;
  }
  return summary;
}
