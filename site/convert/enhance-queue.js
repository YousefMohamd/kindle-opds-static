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

import { cleanOcrText, detectPageScript, routePage } from "./ocr-client.js";

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
