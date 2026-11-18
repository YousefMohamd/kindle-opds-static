/**
 * RliBook OCR.space tier — pure logic (no DOM).
 *
 * The cheap, per-user enhancement tier that sits BEFORE the GPU in
 * the converter pipeline: Tesseract (browser) -> OCR.space (this
 * module, the reader's own free key, called from their browser) ->
 * GPU (enhance-queue.js) -> Tesseract fallback. A dead OCR.space
 * or a dead GPU never breaks a conversion — every failure leaves
 * the standard Tesseract text in place.
 *
 * API contract (verified live 2026-11-18, https://ocr.space/ocrapi):
 *   POST https://api.ocr.space/parse/image
 *     Header: apikey: <the user's own free key>
 *     Body: multipart/form-data
 *       file: the page image (PNG/JPEG, free tier <= 1 MB)
 *       language: auto | eng (Engine 2 auto-detects; 'ara' is
 *         REJECTED by the live API with E201 "Value for parameter
 *         'language' is invalid" — verified live 2026-11-18, so
 *         we send auto for Arabic, eng for English)
 *       isOverlayRequired: false (we need text only)
 *       OCREngine: 2 (default, best all-round)
 *       scale: true (upscale low-res scans — the front-page demo
 *         uses it; it can significantly improve the result)
 *   -> 200 {
 *        ParsedResults: [{ FileParseExitCode: "1"|1 (success),
 *          ParsedText: "...", ErrorMessage, ErrorDetails }],
 *        OCRExitCode: "1"|"2"|"3"|"4" (string in the docs' example),
 *        IsErroredOnProcessing: false, ErrorMessage, ErrorDetails }
 *   FileParseExitCode: "1" success, -10 parse error, -20 timeout,
 *   -30 validation, -99 unknown.
 *
 * Free tier: 25,000 req/month, 500 req/day per IP, 1 MB/file,
 * 3 PDF pages. No card — the key comes by email (register at
 * ocr.space/ocrapi). The key is the USER's own: it is stored in
 * their browser's localStorage only, never in the repo, never in
 * a shared key, never sent anywhere except api.ocr.space. The
 * demo key "helloworld" exists only in the tests, never in
 * shipped code. With no key configured the tier is skipped
 * silently (the GPU / Tesseract path is unchanged).
 *
 * Accuracy note (from the capacity research): OCR.space Engine 2
 * is Tesseract-class — good for modern Arabic / English, well
 * below Qari on classical / diacritic-rich Arabic (Qari CER 0.061
 * vs Tesseract CER 0.436 on the same diacritic test set). So the
 * tier is for ordinary pages; diacritic-rich pages skip it and go
 * straight to the GPU (see enhance-queue.js enhanceOnePage).
 */

export const OCR_SPACE_URL = "https://api.ocr.space/parse/image";
export const OCR_SPACE_TIMEOUT_MS = 30000;
export const OCR_SPACE_MAX_IMAGE_BYTES = 1 * 1024 * 1024;
export const OCR_SPACE_ENGINE = "2";

import { cleanOcrText } from "./ocr-client.js";

/** OCR.space language code for a page + override.
 *  E201 REGRESSION (2026-11-18, verified live): the API rejects
 *  "ara" with E201 "Value for parameter 'language' is invalid".
 *  Engine 2 auto-detects the script, so Arabic pages send "auto"
 *  (NOT "ara") and English pages send "eng". */
export function ocrSpaceLanguageForPage(page, override = "auto") {
  if (override === "ar" || override === "ar-classical") return "auto";
  if (override === "en") return "eng";
  const script = (page && page.script) || "";
  if (script === "arabic") return "auto";
  if (script === "latin") return "eng";
  return "auto";
}

/** Parse an OCR.space JSON response into the shared enhancement
 *  shape. Pure — no network — so it stays testable in Node.
 *  Returns { ok: true, text, engine, confidence, lang } or
 *  { ok: false, reason } where reason is one of:
 *    "quota"       daily/monthly limit reached (the free tier
 *                  answers with an error mentioning the limit)
 *    "timeout"     the engine timed out on this image
 *                  (FileParseExitCode -20)
 *    "unavailable" any other error / malformed response
 *    "empty"       success code but no usable text
 *  The caller treats every { ok: false } as "keep the standard
 *  text" (and falls through to the GPU tier). */
export function parseOcrSpaceResponse(data) {
  if (!data || typeof data !== "object") return { ok: false, reason: "unavailable" };
  // A processing-level error (e.g. the free key hit its daily
  // limit) comes back with IsErroredOnProcessing true and a
  // message. Distinguish a quota error from any other error by
  // the message text — OCR.space does not give it a code.
  if (data.IsErroredOnProcessing === true) {
    const msg = String((data.ErrorMessage || "") + " " + (data.ErrorDetails || "")).toLowerCase();
    if (/limit|quota|exceed|too many|500\s*per\s*day|daily/i.test(msg)) {
      return { ok: false, reason: "quota" };
    }
    return { ok: false, reason: "unavailable" };
  }
  const results = Array.isArray(data.ParsedResults) ? data.ParsedResults : null;
  if (!results || results.length === 0) return { ok: false, reason: "unavailable" };
  const first = results[0] || {};
  const exit = first.FileParseExitCode;
  const exitNum = typeof exit === "string" ? parseInt(exit, 10) : exit;
  if (exitNum === -20) return { ok: false, reason: "timeout" };
  if (exitNum !== 1) return { ok: false, reason: "unavailable" };
  const text = cleanOcrText(typeof first.ParsedText === "string" ? first.ParsedText : "");
  if (!text) return { ok: false, reason: "empty" };
  return { ok: true, text, engine: "ocr-space", confidence: null, lang: "" };
}

/** POST one page image to OCR.space.
 *  fetchFn: (url, init) -> Response-like { status, ok, json() }
 *    (global fetch in the browser; a mock in tests).
 *  apiKey: the user's own free OCR.space key (never a shared key).
 *  image: Blob | Uint8Array (the page, PNG/JPEG, <= 1 MB free tier).
 *  Returns the same shape as enhancePage (see enhance-queue.js):
 *  { ok: true, text, engine, confidence, lang } or
 *  { ok: false, reason } ("quota" | "timeout" | "unavailable" |
 *  "empty" | "too-big"). Never throws for an expected failure. */
export async function ocrSpacePage({
  fetchFn,
  apiKey,
  image,
  langHint = "auto",
  timeoutMs = OCR_SPACE_TIMEOUT_MS,
}) {
  const fetchImpl = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: "unavailable" };
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, reason: "unavailable" };
  }
  const size = image ? (typeof image.size === "number" ? image.size : image.length || 0) : 0;
  if (size > OCR_SPACE_MAX_IMAGE_BYTES) return { ok: false, reason: "too-big" };
  if (size === 0) return { ok: false, reason: "unavailable" };
  // Multipart form-data: the image as a file part (the API also
  // accepts base64Image / url, but a file part avoids the ~33%
  // base64 overhead and needs no data-URI prefix handling).
  const form = new FormData();
  const blob =
    image instanceof Blob
      ? image
      : new Blob([image], { type: "image/png" });
  form.append("file", blob, "page.png");
  form.append("language", langHint);
  form.append("isOverlayRequired", "false");
  form.append("OCREngine", OCR_SPACE_ENGINE);
  form.append("scale", "true");
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
      reject(new Error("ocr-space timeout"));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchImpl(OCR_SPACE_URL, {
        method: "POST",
        signal: ctrl ? ctrl.signal : undefined,
        headers: { apikey: apiKey.trim() },
        body: form,
      }),
      timeout,
    ]);
    if (res.status === 429 || res.status === 403) return { ok: false, reason: "quota" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      return { ok: false, reason: "unavailable" };
    }
    return parseOcrSpaceResponse(data);
  } catch (e) {
    if (e && e.message === "ocr-space timeout") return { ok: false, reason: "timeout" };
    if (e && e.name === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
