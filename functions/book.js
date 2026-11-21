// Cloudflare Pages Function: human-readable HTML book/search page (RliBook).
// Route: GET /book?q=...
//
//   GET /book?q=الصلح
//     -> 200 text/html — the matching books as a plain readable page:
//        title, author, library, format, and the four action
//        buttons in exact order (2026-11-21): (1) Download — a
//        device download button in its own section above the row,
//        ONLY for an e-reader User-Agent (Workstream 1b: Kobo
//        "نزّل الكتاب على جهاز Kobo", PocketBook likewise, generic
//        "جرّب تنزيل الكتاب على جهازك", Kindle keeps the existing
//        "احصل على الكتاب على جهازك" — which is NOT a direct
//        download: it opens /kindle/get, whose Kindle steps are
//        phone → download → Send to Kindle for Web); (2) "أرسل لميل
//        قارئي" — the reader email (Telegram books hand off to the
//        bot via the send_<handle>_<post> deep link, under the bot's
//        limits; OPDS books send direct via /api/send-to-kindle —
//        the primary path on a Kindle, whose browser cannot
//        download files at all); (3) Convert (Telegram PDF books
//        only); (4) Report LAST, with the copyright criteria text
//        next to it, wired to the bot's main-menu Report flow.
//        Plus an "اقرأ أونلاين" reader button (EPUB only) between
//        Convert and Report. Desktop and mobile browsers see NO
//        download button at all (email + reader + convert + report
//        only). The download button always points at the delivery
//        page /kindle/get — a 10-minute short link, max 5
//        downloads/day — never at a file. No JavaScript, minimal
//        CSS, tiny page — built for the Kindle experimental browser.
//        (Button order 2026-11-16 was email first; 2026-11-21 puts
//        Download first to match the bot's restructured results.)
//
// Why this exists: the catalog dictionary links to a book page. The old
// link pointed at /opds/search, which returns an Atom XML feed — the
// Kindle browser shows that as raw XML code ("corrupted embed code").
// This page renders the SAME search (same five search-index.json files,
// same substring matching as functions/opds/search.js) as HTML.
//
// Data: the five public OPDS libraries (khazendar, sahwa,
// electronic, hindawi, doab) PLUS the Telegram catalog — unified
// search. Telegram results come from GET /api/tg-search
// (functions/api/tg-search.js), which queries the TG_D1 database
// (D1 + FTS5; the D1 snapshot is still being imported — see the
// `coverage` field on /api/tg-search for the live indexed count).
// endpoint owns all Telegram search logic (Arabic normalization,
// FTS5 AND + longest-word fallback, flagged check), so there is one
// implementation of it and /book stays a thin renderer. /book sends
// one same-origin subrequest to /api/tg-search and parses only the
// ~2 KB JSON reply (~0.02 ms CPU locally — three orders of magnitude
// below parsing a Telegram shard, ~129 ms for 19.9 MB).
//
// Activation: this file can deploy BEFORE D1 exists. Until
// /api/tg-search is deployed and TG_D1 is populated, the subrequest
// fails (404/503) and /book silently renders exactly what it renders
// today (OPDS-only, including the no-match page with the /telegram/
// link). The moment tg-search is live and D1 has books, Telegram
// cards appear with no further change to this file.
//
// Telegram cards are NORMAL cards (title, author, format)
// with the SAME "أرسل لميل قارئي" primary button as
// OPDS cards — the button sends the book to the Kindle by email
// (Telegram books via the bot deep link, OPDS books direct).
// Under it, the SAME device download
// button as OPDS cards (Workstream 1b: shown only for an e-reader
// User-Agent — Kobo/PocketBook/generic get a device label, Kindle
// keeps "احصل على الكتاب على جهازك"; desktop/mobile get none),
// which opens the delivery page /kindle/get (a 10-minute short
// link; the proxy fetches the file from Telegram for the short
// link's target; max 5 downloads/day). The card links come
// pre-built from /api/tg-search (get/send/read) — the endpoint
// never returns the raw t.me post URL to this page, so no card can
// ever link straight to a Telegram post.
// Source-hiding (2026-11-21): NO source line anywhere on this
// page. The endpoint populates `source` only for flagged books,
// and this page never renders it — the channel handle survives
// only INSIDE the delivery URLs (h=<handle>) as the delivery
// identity, never as visible text, and never as a t.me link.
// Flagged Telegram books show a 🚩 flag and ONE
// button, "View in bot" (Workstream 2b) — the bot deep link from
// /api/tg-search — and NO send button and NO reading on the website,
// per the website rule that flagged books are flagged but not
// readable/downloadable on the site — they point at the bot instead,
// which enforces the 3/day cap.
//
// Book metadata (Workstream 3): under the format line each card shows
// the file size and the page count — ONLY when the data exists.
// The file size comes from the Telegram index (D1 books.size, via
// /api/tg-search `size` — all 327,408 Telegram books in the live
// shards carry one, measured 2026-11-16). The page count has NO
// source anywhere today (no `pages` column in D1, no page count in
// the Telegram shards or the OPDS indexes), so it is ALWAYS omitted
// for now — the renderers carry the field forward-compatibly (if a
// future index/endpoint sends `pages`, the card shows it; until then
// nothing is invented, estimated, or shown as "?" or "0"). OPDS
// cards have neither value today (their search-index.json holds only
// title/author/id/mime), so they show no metadata line — the same
// formatBookMeta() call runs for them, so a future index rebuild
// that adds size/pages flows through with no further change here.
//
// Enrichment (Blocks 4 + 9): Telegram cards also show, when available,
// an embedded cover (Block 4 pairing — a data:image/* URI stored with
// the book metadata, never a hotlink; no cover -> no <img> at all),
// a rating X/10 with its source (Block 9, via /api/ratings — Google
// Books first, Open Library fallback; no rating -> nothing, never a
// fake 0), and a short description with its source (Telegram post text
// first, Google Books second). OPDS cards are NOT enriched (up to 100
// cards x external fetches would blow the subrequest budget and slow
// the Kindle page). Every enrichment call degrades to "not shown".
//
// Graceful degradation (never a 500 from the Telegram half): the
// tg-search fetch is wrapped so it can only resolve to
// { available, total, coverage, results } — a throw, a non-200 status, a
// { ok: false } body, or malformed results all yield
// available:false + no results, and /book falls back to OPDS-only.
// OPDS failures return a 500 HTML page naming the failed index, with
// links to /telegram/ and the home page — never a bare error line
// and never partial results presented as complete.
//
// Download honesty: the Kindle's built-in browser REFUSES to download
// EPUB/PDF ("Invalid File Type — Only .AZW, .PRC, .MOBI or .TXT"), and
// the dialog's ".AZW" does NOT cover ".azw3" (BicBucStriim #287: *.azw3
// hits the same error, *.mobi downloads). So there is no direct browser
// download for these books on a Kindle, and the page renders NO direct-download
// link at all (removed 2026-11-13: device test showed tapping it
// failed with a white page + error codes 175/101). The PRIMARY path is
// the reader email: for OPDS books a direct /api/send-to-kindle
// send, for Telegram books the bot deep link (botSendLink). Amazon
// converts EPUB to AZW3/KFX on delivery, straight into the library.
// The secondary path is the delivery page /kindle/get: a 10-minute
// short link (max 5 downloads/day). On a Kobo/PocketBook the short
// link is tapped ON the device and the file lands in the library
// (their browsers download EPUBs directly); on a Kindle the short
// link is opened on a phone/computer and uploaded at
// amazon.com/sendtokindle; a desktop/mobile browser gets no button
// for it at all (Workstream 1b, below).
//
// E-reader download button (Workstream 1b,
// docs/ereader-download-button.md): the download button on a card
// is gated on the request's User-Agent family (detectEReaderFamily).
// Kobo/PocketBook get a device-named button, a generic e-reader UA
// gets a labelled try-direct button, Kindle keeps the existing
// button (its path is phone → Send to Kindle, never a direct
// download), and desktop/mobile/no-UA visitors get NO download
// button — email + reader only. The footer note and the Telegram
// note describe the download ONLY when a download button was
// actually rendered on the page, so a desktop visitor is never
// promised a button that is not there.
// HONEST LIMIT: the User-Agent is self-asserted and trivially
// spoofable — any desktop can send a Kobo UA and see the button
// (pinned in book.test.mjs M6). The gate is a deterrent for
// ordinary users, NOT a hard block: what bounds abuse is the
// 10-minute single-book token + 5/day cap + flagged-book denylist
// in /api/dl-token.js, and /kindle/get stays reachable by direct
// URL by design (the phone half of the Kindle flow and the bot
// link both need it — a desktop that types the URL still gets the
// phone-flow page, still token-gated and capped).
//
// Mini App hub (Workstream 3b): inside Telegram the same /kindle/get
// button is rendered a second time with class "tg-only" — hidden by
// default, revealed only when telegram-webapp.js adds html.tg-webapp
// (i.e. only inside the Telegram Mini App). It renders ONLY when the
// UA gate above hid the download button, so the two never duplicate.
// The server cannot detect the Mini App (the webview sends a mobile
// Telegram UA, so downloadLabel is "" there); the client-side class
// is the only gate. The label is the generic Kindle-flow one —
// inside Telegram the device family is unknowable without identity
// (a future step: a validated-initData device lookup).
//
// E-reader families (docs/ereader-detection.md §4.3): a Kobo,
// PocketBook, or generic e-reader UA gets a one-line banner at the
// top of the page (direct download on the device) naming the button
// to tap. Kindle/desktop get no banner.
//
// Every dynamic response sends `cache-control: no-store` (changed
// 2026-11-16 from `no-store`: max-age=0
// still permits a heuristic/store-then-revalidate path in some
// caches, no-store does not — and a cached copy of this page must
// never be served to another visitor).
//
// Free-tier friendly: same cost profile as /opds/search (five static
// JSON fetches, ~3 MB total, no KV, no D1) + one same-origin
// subrequest to /api/tg-search (1 of the 50/subrequest budget) whose
// reply is ~2 KB. Network wait does not count toward the 10 ms CPU
// limit; /book's own CPU grows by only the ~0.02 ms to parse it.
// The five indexes are loaded through loadSearchIndex
// (functions/opds/search.js), which skips the JSON.parse for a
// library the needle provably cannot match — a no-hit query used to
// parse all ~3 MB (44–53 ms CPU, past the 10 ms budget: 1102 shape)
// and now costs ~2–3 ms of raw-text scanning instead.

// E-reader family banner (docs/ereader-detection.md §4.3): a
// Kobo/PocketBook/generic visitor gets one line at the top of the
// page saying the delivery page downloads straight onto their
// device. Kindle/desktop get no banner (Kindle pages already speak
// Kindle). The button itself never changes — the delivery page
// carries the per-family behaviour.
import { detectEReaderFamily } from "./kindle/[[path]].js";
import { parseCookies, COOKIE_NAME } from "./api/identify.js";

// Device-specific download button label (Workstream 1b —
// docs/ereader-download-button.md). The download button on a book
// card is shown ONLY for these families, under the email button:
//   kobo / pocketbook — a direct download on the device itself;
//   generic — a labelled try (the device is unverified, so the
//     label promises an attempt, not a device);
//   kindle — the EXISTING "احصل على الكتاب على جهازك" button,
//     which is NOT a direct download: the Kindle browser cannot
//     download EPUBs, so the button opens /kindle/get, whose
//     Kindle steps are phone → download → Send to Kindle for Web.
// Desktop / mobile / no-UA visitors get "" — NO download button
// at all (email + reader only). Tolino/Boox UAs also get "":
// detectEReaderFamily returns null for them (no family yet —
// open item in the doc), so they are treated like desktop until
// a family is assigned. Exported for tests.
export function ereaderDownloadLabel(family) {
  if (family === "kobo") return "نزّل الكتاب على جهاز Kobo";
  if (family === "pocketbook") return "نزّل الكتاب على جهاز PocketBook";
  if (family === "generic") return "جرّب تنزيل الكتاب على جهازك";
  if (family === "kindle") return "احصل على الكتاب على جهازك";
  return "";
}

// "Other ways" note (2026-11-20): clarifies the get/download button
// is NOT the email button — no email is sent. Kindle (and the
// Telegram Mini App, which uses the Kindle-flow label) goes
// phone/computer → download → Amazon Send to Kindle for Web;
// Kobo/PocketBook/generic download straight onto the device.
export function otherWaysNote(family) {
  if (family === "kobo" || family === "pocketbook" || family === "generic") {
    return "بدون إيميل: ده مش زر «أرسل لميل قارئي» — الكتاب بينزّل على جهازك مباشرة، من غير ما يتبعت بالإيميل.";
  }
  return "بدون إيميل: ده مش زر «أرسل لميل قارئي» — الإيميل بيوصّل الكتاب لمكتبتك تلقائياً، أما هنا فإنت اللي بتنزّل الكتاب على موبايلك أو كمبيوترك وبعدين بترفعه بنفسك في amazon.com/sendtokindle.";
}

// Renders the Download section (2026-11-21): the get/download
// button sits in its own visible section, rendered BEFORE the main
// .actions row so Download is button (1) on every card — email (2),
// Convert (3), Report (4, last). The button is real, not collapsed,
// not behind a click, with a short note clarifying this is NOT the
// email path. `buttonHtml` is the button's <p>...</p>; `tgOnly` puts
// the class on the whole section so a Mini App-only button stays
// hidden outside Telegram (the label + note must not show without
// their button). Returns "" when there is no button. Exported for
// tests. (Was otherWaysSection until 2026-11-21: the section moved
// from below the row to above it and became the primary slot.)
export function downloadSection(buttonHtml, family, tgOnly) {
  if (!buttonHtml) return "";
  const cls = tgOnly ? "other-ways tg-only" : "other-ways";
  return "<div class=\"" + cls + "\">\n"
    + "<p class=\"other-ways-label\">تنزيل الكتاب:</p>\n"
    + buttonHtml
    + "<p class=\"note\">" + otherWaysNote(family) + "</p>\n"
    + "</div>\n";
}

// The Report row (2026-11-21): button (4) — LAST on every
// non-flagged card — plus the copyright criteria text next to it.
// The button wires to the EXISTING bot report entry: the bot home,
// where the user taps Report in the main menu and types the book
// name (the bot's entry is the in-Telegram cb_report_menu flow —
// there is no report deep link, and no website report backend is
// invented here). Criteria (design doc §4.5 reasons + §3.3
// two-signal rule + §5.1/§5.2/§5.4): reportable = a recent
// publication still under copyright — still sold, recent edition,
// commercial publisher; public-domain classics (Project Gutenberg
// / Open Library public) are NEVER reportable. The word
// "commercial" / "تجاري" never appears in user-facing text (standing
// rule) — "ما زال يُباع" carries that signal instead. Flagged
// cards never get this row (already flagged — their only button is
// "View in bot"). Exported for tests.
export const BOT_LINK = "https://t.me/RliBook_bot";
// Bot handoff for the website email button (2026-11-21): a Telegram
// book's send link (/api/send-to-kindle?lib=tg&h=<handle>&p=<post>)
// becomes the bot deep link send_<handle>_<post>, so the send falls
// under the bot's limits (heavy-action bucket 3/hour, fingerprint)
// instead of calling the endpoint directly. Returns null when the
// link is not a Telegram send link (OPDS books have no handle/post —
// no bot deep link exists for them, so they keep the direct link) or
// when handle/post fail validation — the caller then falls back to
// the direct link and never renders a broken bot link. Exported for
// tests.
export function botSendLink(send) {
  if (typeof send !== "string" || !send.startsWith("/api/send-to-kindle?")) return null;
  const q = new URLSearchParams(send.slice("/api/send-to-kindle?".length));
  const h = q.get("h") || "", p = q.get("p") || "";
  if (!/^[A-Za-z0-9_]{1,64}$/.test(h) || !/^\d+$/.test(p)) return null;
  return `https://t.me/RliBook_bot?start=send_${h}_${p}`;
}
export const REPORT_CRITERIA = "يُبلَّغ عن الكتاب فقط إذا كان إصداراً حديثاً ما زال يُباع وله طبعة حديثة من دار نشر — أما الكلاسيكيات القديمة والكتب المتاحة مجاناً في المكتبات العامة فلا يُبلَّغ عنها أبداً.";
export function reportSection() {
  return "<div class=\"report\">\n"
    + "<p><a class=\"btn\" href=\"" + BOT_LINK + "\">🚩 الإبلاغ عن الكتاب</a></p>\n"
    + "<p class=\"note\">" + REPORT_CRITERIA
    + " في البوت اضغط «Report» من القائمة الرئيسية واكتب اسم الكتاب.</p>\n"
    + "</div>\n";
}

const TG_LIMIT = 10; // Telegram cards per page (OPDS stays capped at 100)
const MAX_Q_LEN = 200; // A title/author query longer than this is a 400 page, not a search

// Shared search-index loader (functions/opds/search.js): fetches one
// library's search-index.json as text and skips the JSON.parse when
// the needle provably cannot match anything in it — the five indexes
// total ~3 MB, and parsing all of them on a no-hit query cost
// 44–53 ms CPU against the 10 ms free-tier budget (1102 shape).
import { loadSearchIndex } from "./opds/search.js";
// -- book metadata (Workstream 3) --------------------------------------
// File size + page count, shown UNDER the format line on a card.
// Same validation as functions/api/tg-search.js validateSize (kept
// as a local copy, like parseTelegramPostUrl below): the indexer's
// size text is "2.7 MB" / "888.9 KB" (digits, optional decimal with
// "." or ",", unit B/KB/MB/GB); a byte count formats to the same
// shape with one decimal. Anything else yields null — an unknown
// size is omitted, never invented. Exported for tests.
const SIZE_TEXT_RE = /^\d+(?:[.,]\d+)?\s*(B|KB|MB|GB)$/i;

export function formatFileSize(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!SIZE_TEXT_RE.test(text)) return null;
    const m = /^(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)$/i.exec(text);
    return `${m[1].replace(",", ".")} ${m[2].toUpperCase()}`;
  }
  if (typeof value === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    let size = n;
    for (const unit of ["B", "KB", "MB", "GB"]) {
      if (size < 1024 || unit === "GB") {
        return `${size.toFixed(1).replace(/\.0$/, "")} ${unit}`;
      }
      size /= 1024;
    }
  }
  return null;
}

/** A page count -> a positive integer, or null when unknown/invalid
 *  (0, negative, fractional, non-numeric: all omitted, never shown
 *  as "0" or guessed). Exported for tests. */
export function validatePages(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** The metadata line for one card (Arabic, the site language), or ""
 *  when NEITHER value is known — the caller then renders no line at
 *  all. "الحجم: 2.7 MB" / "عدد الصفحات: 250", joined with " · " when
 *  both are present. Exported for tests. */
export function formatBookMeta({ size, pages } = {}) {
  const parts = [];
  const s = formatFileSize(size);
  if (s) parts.push(`الحجم: ${s}`);
  const p = validatePages(pages);
  if (p !== null) parts.push(`عدد الصفحات: ${p}`);
  return parts.join(" · ");
}

// Query the Telegram catalog via the /api/tg-search endpoint.
// NEVER throws and NEVER returns a partial/untrusted result: any
// failure — endpoint not deployed yet (404), D1 not bound (503),
// D1 empty, non-JSON or { ok: false } reply — yields
// { available: false, total: 0, coverage: null, results: [] }, and the
// caller falls back to OPDS-only. `available: true` means the endpoint
// answered with ok:true (even with zero results: D1 was searched and
// is empty for this query). `coverage` is the endpoint's coverage
// object ({ indexed, target, partial }) passed through validated —
// null when the endpoint did not send one — so the caller can say
// honestly that D1 is still a partial snapshot (import finishes
// 2026-11-19) instead of guessing. Each result is validated: a title
// is required, and the get/send/read links are used only when they
// are strings on the expected same-origin paths — the raw t.me post
// URL is never read here, so a bad endpoint reply can never inject
// an arbitrary link into the page.
// `origin` is the request origin (same-origin subrequest, like the
// OPDS index fetches below). Exported for tests.
export async function fetchTelegramResults(origin, q, limit = TG_LIMIT) {
  try {
    const tgUrl = new URL("/api/tg-search", origin);
    tgUrl.searchParams.set("q", q);
    tgUrl.searchParams.set("limit", String(limit));
    const res = await fetch(tgUrl.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) return {available: false, total: 0, coverage: null, results: []};
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.results)) {
      return {available: false, total: 0, coverage: null, results: []};
    }
    const results = [];
    for (const r of data.results) {
      if (!r || typeof r.title !== "string" || !r.title) continue;
      // Gated links only (Workstream H): /api/tg-search returns the
      // delivery-page, email and reader links pre-built server-side
      // — the raw t.me post URL is NEVER in the response, so this
      // page cannot be made to render one even if the endpoint reply
      // is tampered with. A link is used only when it is a string on
      // the expected same-origin path; anything else is dropped.
      // A record that CLAIMS a link (non-null) which fails that check
      // is a tampered reply — the whole record is dropped. A record
      // with no links at all (nulls — e.g. a MOBI book, which no
      // delivery path accepts) is legitimate and still renders, with
      // the "ask the bot" note instead of buttons.
      // `r.url` is deliberately never read here.
      const link = (v, prefix) =>
        (typeof v === "string" && v.startsWith(prefix) ? v : null);
      const get = link(r.get, "/kindle/get?");
      const send = link(r.send, "/api/send-to-kindle?");
      const read = link(r.read, "/site/reader/?");
      // The "View in bot" deep link (Workstream 2b, flagged books
      // only): exactly t.me/RliBook_bot?start=dl_<handle>_<post>_any.
      // Anything else is a tampered reply — the record is dropped,
      // like a bad get/send/read link. A missing bot field (an older
      // endpoint reply) is legitimate: the card falls back to the
      // bot home link.
      const bot = (typeof r.bot === "string"
        && /^https:\/\/t\.me\/RliBook_bot\?start=dl_[A-Za-z0-9_]{1,64}_\d{1,10}_any$/.test(r.bot))
        ? r.bot : null;
      const badLink = (v, ok) => v !== null && v !== undefined && ok === null;
      if (badLink(r.get, get) || badLink(r.send, send) || badLink(r.read, read) || badLink(r.bot, bot)) continue;
      // Cover (Block 4 pairing): EMBEDDED only — a data:image/* URI
      // stored with the book metadata, small enough for the Kindle
      // browser (<= 150 KB). Anything else (a hotlink, an oversized
      // blob, a non-image) is dropped: no evidence = no cover, and a
      // wrong/huge cover is worse than no cover.
      let cover = "";
      if (typeof r.cover === "string"
        && /^data:image\/(jpeg|png|webp|gif);base64,/.test(r.cover)
        && r.cover.length <= 150000) {
        cover = r.cover;
      }
      // Description from the Telegram post text (first source for the
      // description; Google Books is second, via /api/ratings).
      const description = typeof r.description === "string"
        ? r.description.slice(0, 2000)
        : "";
      // Metadata (Workstream 3): file size from the endpoint (`size`,
      // validated — junk is dropped); page count is passed through
      // when the endpoint ever sends one (no source provides it
      // today, so it is absent and the card omits it).
      const size = formatFileSize(r.size);
      const pages = validatePages(r.pages);
      results.push({
        title: r.title,
        author: typeof r.author === "string" ? r.author : "",
        source: typeof r.source === "string" ? r.source : "",
        kind: r.kind === "group" ? "group" : "channel",
        formats: Array.isArray(r.formats)
          ? r.formats.filter((f) => typeof f === "string")
          : [],
        flagged: r.flagged === true,
        get,
        send,
        read,
        bot,
        cover,
        description,
        ...(size ? { size } : {}),
        ...(pages !== null ? { pages } : {}),
      });
    }
    return {
      available: true,
      total: Number.isFinite(data.total) ? data.total : results.length,
      coverage: data.coverage && typeof data.coverage === "object"
        ? {
            indexed: Number.isFinite(data.coverage.indexed)
              ? data.coverage.indexed : null,
            target: Number.isFinite(data.coverage.target)
              ? data.coverage.target : null,
            partial: data.coverage.partial === true,
          }
        : null,
      results,
    };
  } catch (e) {
    console.warn("[book] telegram search unavailable:", e && e.message);
    return {available: false, total: 0, coverage: null, results: []};
  }
}

// Formats the email endpoint accepts (Send-to-Kindle's list). A Telegram
// book in any other format (MOBI/AZW3/KFX) gets no send button — the
// endpoint would refuse it anyway — and a note pointing at the bot.
// (Kept for the OPDS cards in onRequest below; the Telegram cards use
// the pre-built gated links /api/tg-search returns — see
// fetchTelegramResults — so no t.me post URL is ever parsed here.)
export const TG_SENDABLE_FORMATS = new Set(["epub", "pdf", "doc", "docx", "txt"]);

// Rating + description for one book, via the same-origin
// /api/ratings endpoint (functions/api/ratings.js: Google Books first,
// Open Library as fallback). NEVER throws and NEVER returns a rating
// the endpoint did not confidently match: any failure — endpoint not
// deployed yet, upstream down, no match — yields
// { rating: null, description: null }, and the card simply shows no
// rating (never a fake 0). Exported for tests.
export async function fetchEnrichment(origin, title, author = "") {
  try {
    const u = new URL("/api/ratings", origin);
    u.searchParams.set("title", title || "");
    if (author) u.searchParams.set("author", author);
    const res = await fetch(u.toString(), {headers: {"accept": "application/json"}});
    if (!res.ok) return {rating: null, description: null};
    const data = await res.json();
    if (!data || data.ok !== true) return {rating: null, description: null};
    const rating = data.rating
      && Number.isFinite(Number(data.rating.value))
      && data.rating.value > 0 && data.rating.value <= 10
      && typeof data.rating.source === "string" && data.rating.source
      ? {
          value: Number(data.rating.value),
          count: Number(data.rating.count) || 0,
          source: data.rating.source,
        }
      : null;
    const description = data.description
      && typeof data.description.text === "string" && data.description.text
      && typeof data.description.source === "string" && data.description.source
      ? {text: data.description.text.slice(0, 2000), source: data.description.source}
      : null;
    return {rating, description};
  } catch (e) {
    console.warn("[book] ratings unavailable:", e && e.message);
    return {rating: null, description: null};
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") || "").trim();
  // Fingerprint from the user's personal catalog file (?fp=), when the
  // book page was opened from a catalog that carries it. The dictionary
  // files already sent link WITHOUT fp — then the page shows the email
  // form instead (see functions/api/send-to-kindle.js).
  // Auto-recognition (2026-11-20): ?fp= wins; otherwise the rlb_fp
  // cookie set by /api/identify on the first catalog visit — so a
  // reader who searched from the homepage (no fp in the link) still
  // gets working Send/Get links.
  const fp = (url.searchParams.get("fp") || "").trim()
    || (parseCookies(context.request.headers.get("Cookie") || "")[COOKIE_NAME] || "").trim();
  const fpQ = fp ? "&amp;fp=" + encodeURIComponent(fp) : "";
  // E-reader family banner (see the import above): one line, only
  // for Kobo / PocketBook / generic UAs, inserted after head() on
  // the user-facing pages below (not on error pages).
  const family = detectEReaderFamily(context.request.headers.get("user-agent") || "");
  // WS1b download gate: the label is "" for desktop/mobile/no-UA
  // (and for Tolino/Boox — no family yet), so no download button
  // renders for them. See ereaderDownloadLabel above.
  const downloadLabel = ereaderDownloadLabel(family);
  const familyNote = family === "kobo"
    ? "<p><b>أنت على جهاز Kobo</b> — اضغط «نزّل الكتاب على جهاز Kobo» ثم اضغط الرابط على جهازك، "
      + "فينزّل الكتاب مباشرة في مكتبتك (أو انقله عبر USB).</p>\n"
    : family === "pocketbook"
      ? "<p><b>أنت على جهاز PocketBook</b> — اضغط «نزّل الكتاب على جهاز PocketBook» ثم اضغط الرابط على جهازك، "
        + "فينزّل الكتاب مباشرة في مكتبتك (أو انقله عبر USB).</p>\n"
      : family === "generic"
        ? "<p><b>يبدو أنك على قارئ إلكتروني</b> — لم نتحقق من جهازك تحديدًا؛ اضغط زر التنزيل أدناه، "
          + "وإن لم ينزّل فافتحه من هاتفك وانقل الملف عبر USB.</p>\n"
        : "";
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const fpHidden = fp
    ? "<input type=\"hidden\" name=\"fp\" value=\"" + esc(fp) + "\"> "
    : "";

  const head = (title, qVal = q) => "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1C2826;background:#DFF1F4}"
    + "h1{font-size:1.4rem;margin-bottom:.2rem}h2{font-size:1.1rem;margin:.6rem 0 .2rem}"
    + "a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;margin:.3rem 0;"
    + "border-radius:6px;background:#44667b;color:#fff;text-decoration:none;font-weight:600;"
    + "transition:background-color .15s ease-out,transform .15s ease-out}"
    + ".btn:hover{background:#0b5cad}.btn:active{transform:scale(.98)}"
    + ".actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.6rem 0;"
    + "animation:rlb-rise .25s ease-out both}"
    + ".actions p{margin:0}.actions .btn{margin:0}"
    + ".actions p:first-child .btn{background:#0b5cad}"
    + ".other-ways{margin:.6rem 0}"
    + ".other-ways p{margin:.2rem 0}.other-ways .btn{margin:0}"
    + ".other-ways-label{font-weight:600}"
    + ".report{margin:.6rem 0}.report p{margin:.2rem 0}"
    + "@supports not (gap:.5rem){.actions p{margin:.2rem 0 .2rem .5rem}.actions p:last-child{margin-left:0}}"
    + "@keyframes rlb-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}"
    + "@media (prefers-reduced-motion:reduce){.actions{animation:none}}"
    + ".card{border:1px solid #C4E0EB;border-radius:8px;background:#fff;padding:.8rem 1rem;margin:.8rem 0}"
    + ".cover{max-width:120px;height:auto;border-radius:6px;border:1px solid #C4E0EB}"
    + ".rating{font-weight:600}.desc{font-size:.95rem}"
    + ".src{color:#555;font-size:.85rem}"
    + ".meta{color:#555;font-size:.9rem}"
    + ".note{color:#555;font-size:.9rem}input[type=search]{font-size:1rem;padding:.4rem;width:70%}"
    + "input[type=submit]{font-size:1rem;padding:.4rem .8rem}"
    + ".tg-only{display:none}html.tg-webapp .tg-only{display:block}</style>\n"
    + "<script defer src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n"
    + "<script defer src=\"/site/assets/telegram-webapp.js\"></script>\n</head>\n<body>\n"
    + "<h1>RliBook</h1>\n"
    + "<form method=\"get\" action=\"/book\">"
    + "<input type=\"search\" name=\"q\" value=\"" + esc(qVal) + "\" "
    + "placeholder=\"ابحث بالعنوان أو المؤلف…\" aria-label=\"بحث\"> "
    + fpHidden
    + "<input type=\"submit\" value=\"بحث\"></form>\n";

  const foot = "<p class=\"note\"><a href=\"/\">الرئيسية</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a> · "
    + "<a href=\"https://t.me/RliBook_bot\">البوت @RliBook_bot</a></p>\n"
    + "</body></html>";

  if (!q) {
    const body = head("بحث")
      + familyNote
      + "<p>ابحث في المكتبات الخمس: خازندار، صحوه، المكتبة الإلكترونية، "
      + "هنداوي، DOAB.</p>\n"
      + "<p class=\"note\">للبحث في فهرس تيليجرام، استخدم "
      + "<a href=\"/telegram/\">صفحة فهرس تيليجرام</a>.</p>\n"
      + foot;
    return new Response(body, {headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"}});
  }

  if (q.length > MAX_Q_LEN) {
    const body = head("بحث", q.slice(0, MAX_Q_LEN))
      + "<p>كلمة البحث طويلة جداً — جرّب كلمة أقصر من العنوان أو اسم المؤلف.</p>\n"
      + foot;
    return new Response(body, {status: 400, headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"}});
  }

  const LIBS = [
    {slug: "khazendar", label: "خازندار", kind: "drive"},
    {slug: "sahwa", label: "مكتبة صحوه", kind: "drive"},
    {slug: "electronic", label: "المكتبة الإلكترونية", kind: "drive"},
    {slug: "hindawi", label: "هنداوي", kind: "hindawi"},
    {slug: "doab", label: "DOAB", kind: "doab"},
  ];
  const needle = q.toLowerCase();
  // Start the Telegram search NOW so it runs in parallel with the
  // OPDS loop below (wall-clock overlap; network wait is not CPU).
  // The promise is made non-rejecting here, so even if the OPDS loop
  // returns early (500 on a missing index) there is no unhandled
  // rejection from the Telegram half.
  const tgPromise = fetchTelegramResults(url.origin, q)
    .catch(() => ({available: false, total: 0, coverage: null, results: []}));
  // An OPDS index that cannot be read (missing file, bad JSON) is a
  // 500 — but a 500 the user can act on: a full page naming the
  // library, with links to the Telegram index and home, never a bare
  // error line and never partial results presented as complete.
  const opdsFail = (lib) => {
    const body = head("خطأ")
      + "<p>تعذّر تحميل فهرس مكتبة " + esc(lib.label)
      + " الآن — حاول مجدداً بعد دقيقة.</p>\n"
      + "<p>إلى ذلك الحين: ابحث في <a href=\"/telegram/\">فهرس تيليجرام</a>"
      + " أو عُد إلى <a href=\"/\">الرئيسية</a>.</p>\n"
      + foot;
    return new Response(body, {status: 500, headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"}});
  };
  const hits = [];
  for (const lib of LIBS) {
    // A library the pre-filter clears ({ skip: true }) has no hits —
    // no JSON.parse, no scan. A library whose index cannot be loaded
    // is a 500 naming the library (see opdsFail above).
    const loaded = await loadSearchIndex(url.origin, lib.slug, needle);
    if (loaded.error) return opdsFail(lib);
    if (loaded.skip) continue;
    const books = loaded.books;
    for (const b of books) {
      if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(needle)) {
        hits.push({lib, b});
        if (hits.length >= 100) break;
      }
    }
    if (hits.length >= 100) break;
  }

  // Telegram half: resolves to { available, total, coverage, results } — never
  // throws, never 500s the page. available:false means "not searched"
  // (endpoint/D1 not live yet); available:true + 0 results means
  // "searched, nothing found".
  const tg = await tgPromise;

  const fmt = (b) => {
    const m = (b.m || b.f || "").toLowerCase();
    if (m.includes("pdf")) return "PDF";
    if (m.includes("epub")) return "EPUB";
    if (m.includes("msword") || m.includes("wordprocessingml")) return "DOC";
    if (m.includes("mobi") || m.includes("x-mobipocket")) return "MOBI";
    if (m.includes("text/plain")) return "TXT";
    if (m.includes("azw")) return "AZW3";
    return (b.f || b.m || "").toUpperCase();
  };

  // Raw format code for the send-to-kindle endpoint (sendable: epub/pdf/
  // doc/docx/txt — the endpoint refuses mobi/azw3, which Send-to-Kindle
  // no longer accepts by email).
  const fmtCode = (b) => {
    const m = (b.m || b.f || "").toLowerCase();
    if (m.includes("pdf")) return "pdf";
    if (m.includes("epub")) return "epub";
    if (m.includes("wordprocessingml")) return "docx";
    if (m.includes("msword")) return "doc";
    if (m.includes("mobi") || m.includes("x-mobipocket")) return "mobi";
    if (m.includes("text/plain")) return "txt";
    if (m.includes("azw")) return "azw3";
    return (b.f || "epub").toLowerCase();
  };

  let body = head("بحث: " + q);
  if (familyNote) body += familyNote;
  if (hits.length === 0 && tg.results.length === 0) {
    // P1-6 (2026-11-17): the no-match page must say plainly the book
    // is NOT available, show RELATED recommendations, and link to the
    // bot. Related = a relaxed search on the query's words, longest
    // first (max 3 words — the most specific word usually matches;
    // a nonsense word simply yields nothing and the next is tried),
    // same sources and same substring matching for OPDS, the
    // endpoint's own longest-word fallback for Telegram, capped at 5,
    // deduped by title. Runs only on the no-match path, so a hit page
    // pays nothing; an index error here is skipped silently (the main
    // loop above already 500s on a genuinely broken index).
    const related = [];
    const seenRelated = new Set();
    const pushRelated = (title, author, source) => {
      const key = (title || "").toLowerCase();
      if (!title || seenRelated.has(key) || related.length >= 5) return;
      seenRelated.add(key);
      related.push({title, author, source});
    };
    const relWords = q.split(/\s+/).filter((w) => w.length >= 2)
      .sort((a, b) => b.length - a.length).slice(0, 3);
    for (const relWord of relWords) {
      if (related.length >= 5) break;
      const rw = relWord.toLowerCase();
      for (const lib of LIBS) {
        const loaded = await loadSearchIndex(url.origin, lib.slug, rw);
        if (loaded.error || loaded.skip) continue;
        for (const b of loaded.books) {
          if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(rw)) {
            pushRelated(b.t, b.a, lib.label);
            if (related.length >= 5) break;
          }
        }
        if (related.length >= 5) break;
      }
      if (related.length < 5) {
        const tgRel = await fetchTelegramResults(url.origin, relWord, 5);
        // Source-hiding (2026-11-21): Telegram related books show no
        // source label — pass "" so the "(source)" suffix disappears.
        // OPDS related books keep their library label above.
        for (const r of tgRel.results || []) {
          pushRelated(r.title, r.author, "");
        }
      }
    }
    const relatedHtml = related.length
      ? "<h2>كتب مشابهة قد تعجبك</h2>\n<ul>\n"
        + related.map((r) =>
          "<li><a href=\"/book?q=" + encodeURIComponent(r.title) + "\">"
          + esc(r.title) + "</a>"
          + (r.author ? " — " + esc(r.author) : "")
          + (r.source ? " (" + esc(r.source) + ")" : "")
          + "</li>\n").join("")
        + "</ul>\n"
      : "";
    const botLine = "<p>أو اطلبه من البوت "
      + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n";
    if (tg.available) {
      // Telegram WAS searched (endpoint + D1 live) and found nothing
      // either — say so, instead of sending the user to the index.
      // While the D1 import is still running (finishes Thu 2026-11-19)
      // a missing book may only be missing from D1 so far: say so,
      // but only when the endpoint reports D1 as still partial — the
      // note disappears on its own once the import finishes.
      body += "<p>لم نجد «" + esc(q) + "» في كل المكتبات (الخمس + تيليجرام) — الكتاب غير متاح حالياً.</p>\n"
        + "<p>جرّب كلمة أخرى من العنوان أو اسم المؤلف.</p>\n"
        + relatedHtml
        + botLine;
      if (tg.coverage && tg.coverage.partial) {
        body += "<p class=\"note\">ملاحظة: فهرس تيليجرام ما زال يُستورَد — "
          + "يكتمل الخميس 19 نوفمبر 2026، فالكتاب قد يظهر لاحقًا.</p>\n";
      }
      body += foot;
    } else {
      // Telegram was NOT searched (endpoint/D1 not live yet) — the
      // exact page /book rendered before unified search, unchanged,
      // except the hardcoded Telegram count is dropped (the count is
      // shown on the homepage/stats). No partial-import note here:
      // this branch points at the static /telegram/ index (the full
      // manifest), not the partial D1 search.
      body += "<p>لم نجد «" + esc(q) + "» في المكتبات الخمس — الكتاب غير متاح حالياً.</p>\n"
        + "<p>الكتاب قد يكون في <a href=\"/telegram/\">فهرس تيليجرام</a> "
        + "— ابحث عنه هناك بالعنوان أو المؤلف.</p>\n"
        + relatedHtml
        + botLine
        + foot;
    }
    return new Response(body, {headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"}});
  }

  const shown = hits.length + tg.results.length;
  body += "<p>وجدنا " + shown + " نتيجة لـ «" + esc(q) + "»:</p>\n";
  // WS1b: true once ANY download button was actually rendered on
  // this page — the footer note describes the download only then.
  let anyDownload = false;
  for (const {lib, b} of hits) {
    // Send by email only works for the formats Send-to-Kindle accepts
    // (epub/pdf/doc/docx/txt) — and the same set governs the secondary
    // "Get on Kindle" button (Send to Kindle for Web does not accept
    // MOBI/AZW3 either). A MOBI/AZW3 book gets NO email button and NO
    // Get button — the endpoints would refuse them — and a note
    // pointing at the bot instead, so the page never shows a button
    // that is certain to fail.
    // (No MOBI/AZW3 book is in the five indexes today, 2026-11-14, so
    // this is defensive: a future catalog rebuild may add one.)
    const sendable = TG_SENDABLE_FORMATS.has(fmtCode(b));
    const sendUrl = sendable
      ? "/api/send-to-kindle?lib=" + lib.slug
        + "&amp;id=" + encodeURIComponent(b.i)
        + "&amp;f=" + fmtCode(b)
        + "&amp;t=" + encodeURIComponent(b.t || "") + fpQ
      : null;
    // Secondary button: the delivery page (/kindle/get) — same
    // eligibility as the email button (a format Send to Kindle for
    // Web does not accept gets no Get button either; see I3).
    const getUrl = sendable
      ? "/kindle/get?lib=" + lib.slug
        + "&amp;id=" + encodeURIComponent(b.i)
        + "&amp;f=" + fmtCode(b)
        + "&amp;t=" + encodeURIComponent(b.t || "") + fpQ
      : null;
    // "Read online" (Block 11b reader): EPUB only — the reader opens
    // EPUB books, so a PDF/DOC/MOBI book gets no button (its honest
    // page lives in the reader itself). Same URL contract as
    // site/reader/README.md (buildReaderUrl): lib + id + title + author.
    const readerUrl = fmtCode(b) === "epub"
      ? "/site/reader/?lib=" + lib.slug
        + "&amp;id=" + encodeURIComponent(b.i)
        + "&amp;title=" + encodeURIComponent(b.t || "")
        + (b.a ? "&amp;author=" + encodeURIComponent(b.a) : "")
      : null;
    body += "<div class=\"card\"><h2>" + esc(b.t) + "</h2>\n";
    if (b.a) body += "<p>المؤلف: " + esc(b.a) + "</p>\n";
    body += "<p>" + esc(lib.label) + " · " + esc(fmt(b)) + "</p>\n";
    // Button order (2026-11-21): Download FIRST (the download
    // section, rendered before the row), then email (primary,
    // direct /api/send-to-kindle — OPDS books have no handle/post
    // for the bot deep link), then Read online, then Report LAST (report
    // section, after the row). OPDS cards have no Convert button
    // (/api/convert-book accepts lib=tg only).
    // Metadata (Workstream 3): file size + page count UNDER the format
    // line — only when known (OPDS indexes carry neither today, so no
    // line renders; a future index rebuild flows through unchanged).
    const opdsMeta = formatBookMeta({ size: b.size, pages: b.pages });
    if (opdsMeta) body += "<p class=\"meta\">" + esc(opdsMeta) + "</p>\n";
    // WS1b: the download button renders ONLY when the visitor's
    // UA is an e-reader family (downloadLabel !== ""). Desktop /
    // mobile / no-UA visitors see email + reader only — no
    // /kindle/get link anywhere on their page.
    // Action row (2026-11-18): the card's buttons sit side by side
    // in one flex row (.actions) instead of stacked <p>s — email
    // first (primary), then download, then Read online. Each button's
    // own markup is unchanged; only the wrapper is new. The row
    // wraps on narrow e-reader screens, and fades + rises in on
    // load (see the .actions CSS — pure CSS, no JS, and disabled
    // under prefers-reduced-motion).
    let actions = "";
    if (sendUrl) {
      actions += "<p><a class=\"btn\" href=\"" + sendUrl + "\">أرسل لميل قارئي</a></p>\n";
    }
    // Download (2026-11-21): the get/download button lives in its
    // own visible section (downloadSection), rendered BEFORE the
    // actions row so it is button (1). The button's href and
    // fingerprint are unchanged; only its placement moved.
    let otherWaysBtn = "";
    let otherWaysTgOnly = false;
    if (getUrl && downloadLabel) {
      anyDownload = true;
      otherWaysBtn = "<p><a class=\"btn\" href=\"" + getUrl + "\">" + downloadLabel + "</a></p>\n";
    }
    // WS3b (Mini App hub): the SAME /kindle/get button, shown ONLY
    // inside Telegram (class tg-only, revealed by telegram-webapp.js
    // when it adds html.tg-webapp) and ONLY when the UA gate above
    // hid the download button — so the two never duplicate. The
    // server cannot detect the Mini App (no UA/identity signal: the
    // Mini App webview sends a mobile Telegram UA, so downloadLabel
    // is "" here); the client-side tg-webapp class is the only gate.
    // Label is the generic Kindle-flow one: inside Telegram the
    // device family (Kobo vs Kindle) is unknowable without identity.
    // NOTE: this branch deliberately does NOT set anyDownload — the
    // footer/download notes describe a VISIBLE button (WS1b rule),
    // and this button is CSS-hidden outside Telegram. Inside
    // Telegram the button itself is the affordance; the note stays
    // hidden there (it is server-rendered once and cannot be both).
    // The tg-only class goes on the whole download section now
    // (downloadSection), so the label + note never show without
    // their button outside Telegram.
    if (getUrl && !downloadLabel) {
      otherWaysBtn = "<p><a class=\"btn\" href=\"" + getUrl + "\">احصل على الكتاب على جهازك</a></p>\n";
      otherWaysTgOnly = true;
    }
    if (readerUrl) actions += "<p><a class=\"btn\" href=\"" + readerUrl + "\">اقرأ أونلاين</a></p>\n";
    if (otherWaysBtn) body += downloadSection(otherWaysBtn, family, otherWaysTgOnly);
    if (actions) body += "<div class=\"actions\">\n" + actions + "</div>\n";
    body += reportSection();
    if (!sendUrl) {
      body += "<p class=\"note\">لا يمكن إرسال هذا الكتاب من الموقع — "
        + "اطلبه من البوت "
        + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n";
    }
    body += "</div>\n";
  }

  // ---- Telegram results: same card layout, same SEND button --------
  // The button hands off to the bot (botSendLink: the send_
  // deep link); the source is never rendered (source-hiding,
  // 2026-11-21) — the handle survives only inside the delivery URLs
  // (h=<handle>) as the delivery identity. Flagged books get NO send
  // button and NO reading on the website, per the website rule
  // (flagged = shown with a 🚩 flag, reachable via the bot, which
  // enforces the 3/day cap); a book that cannot be sent (private
  // group, no usable format, MOBI/AZW3/KFX) gets a note instead.
  if (tg.results.length > 0) {
    body += "<h2>من تيليجرام"
      + (tg.total > tg.results.length
        ? " (" + tg.results.length + " من " + tg.total + ")"
        : "")
      + "</h2>\n";
    // WS1b: true once a Telegram card rendered a download button
    // — the Telegram note below is shown only then.
    let tgDownload = false;
    // Partial-import note (same gate as the no-match page): while D1
    // is still a partial snapshot the Telegram results on this page
    // are incomplete — more matches may appear once the import
    // finishes (Thu 2026-11-19). Shown only while coverage.partial
    // is true, so it disappears on its own when the import finishes.
    if (tg.coverage && tg.coverage.partial) {
      body += "<p class=\"note\">ملاحظة: فهرس تيليجرام ما زال يُستورَد — "
        + "يكتمل الخميس 19 نوفمبر 2026، فقد تكون هناك نتائج أخرى لم تظهر بعد.</p>\n";
    }
    // Enrichment (Block 9): one /api/ratings subrequest per Telegram
    // card, in parallel (max TG_LIMIT = 10 — inside the 50-subrequest
    // budget). Each call never throws and returns nulls on any failure,
    // so a missing/unreachable ratings endpoint only means "no rating
    // shown". OPDS cards are NOT enriched: up to 100 cards x external
    // fetches would blow the budget and slow the Kindle page.
    const enrichments = await Promise.all(
      tg.results.map((r) => fetchEnrichment(url.origin, r.title, r.author)),
    );
    for (let i = 0; i < tg.results.length; i++) {
      const r = tg.results[i];
      const enr = enrichments[i] || {rating: null, description: null};
      body += "<div class=\"card\"><h2>" + esc(r.title) + "</h2>\n";
      // Cover (Block 4 pairing): shown ONLY when the pairing supplied
      // an embedded cover. No cover -> no <img> at all, never a
      // placeholder image (a wrong cover is worse than no cover).
      if (r.cover) {
        body += "<p><img class=\"cover\" src=\"" + esc(r.cover)
          + "\" alt=\"غلاف: " + esc(r.title) + "\" width=\"120\"></p>\n";
      }
      if (r.author) body += "<p>المؤلف: " + esc(r.author) + "</p>\n";
      // Rating: shown ONLY when the endpoint confidently matched the
      // book. No rating -> NOTHING here (never a fake "0/10": a missing
      // rating must not look like a bad rating).
      if (enr.rating) {
        body += "<p class=\"rating\">" + esc(String(enr.rating.value)) + "/10"
          + (enr.rating.count
            ? " · " + esc(String(enr.rating.count)) + " تقييمًا" : "")
          + " <span class=\"src\">— التقييم من " + esc(enr.rating.source)
          + "</span></p>\n";
      }
      // Description: Telegram post text first, Google Books second.
      // Short (a few lines) and always with its source.
      const postDesc = (r.description || "").replace(/\s+/g, " ").trim();
      const desc = postDesc
        ? {text: postDesc.slice(0, 400), source: "منشور تيليجرام"}
        : enr.description;
      if (desc && desc.text) {
        body += "<p class=\"desc\">" + esc(desc.text)
          + " <span class=\"src\">(الوصف من " + esc(desc.source) + ")</span></p>\n";
      }
      // Formats only — no "تيليجرام" label (source-hiding,
      // 2026-11-21: the word Telegram never appears in the UI).
      const tgFmtLine = (r.formats.length ? esc(r.formats.join("، ")) : "")
        + (r.flagged ? " · 🚩" : "");
      if (tgFmtLine) body += "<p>" + tgFmtLine + "</p>\n";
      // Metadata (Workstream 3): file size + page count UNDER the format
      // line — only when known (size comes from the index via tg-search;
      // pages has no source today, so a page-less book shows size alone,
      // and a book with neither shows no line at all).
      const tgMeta = formatBookMeta({ size: r.size, pages: r.pages });
      if (tgMeta) body += "<p class=\"meta\">" + esc(tgMeta) + "</p>\n";
      // No "المصدر:" line (source-hiding, 2026-11-21).
      if (r.flagged) {
        // Flagged book (Workstream 2b): shown with the
        // 🚩 flag and ONE button, "View in bot" — the bot
        // deep link from /api/tg-search (the bot shows 🚩 + the
        // source channel link under the 3/day cap and never
        // downloads it). No send, no delivery page, no reader.
        // A missing bot field (an older endpoint reply) falls back
        // to the bot home link.
        body += "<p class=\"note\">🚩 هذا الكتاب عليه علامة — الموقع لا يتيح تحميله أو إرساله.</p>\n"
          + "<div class=\"actions\">\n"
          + "<p><a class=\"btn\" href=\"" + esc(r.bot || "https://t.me/RliBook_bot") + "\">View in bot</a></p>\n"
          + "</div>\n";
      } else {
        // Button order (2026-11-21): Download FIRST (the download
        // section, rendered before the row), then email (primary
        // button — bot deep link, see botSendLink), then the Telegram direct-send
        // (same send family), then Convert, then "Read online"
        // (Block 11b reader, EPUB only, never flagged), then
        // Report LAST (report section, after the row). The links
        // come pre-built from /api/tg-search (gated: the page
        // mints the 10-minute short link; the raw post URL never
        // reaches this page). The fingerprint rides along on the
        // Get and Send links (fpQ), so a catalog user never
        // re-types their reader email.
        const sendUrl = r.send ? esc(r.send) + fpQ : null;
        // Email (2026-11-21): Telegram books hand off to the bot
        // (botSendLink above) — the button opens the send_ deep link
        // and the send falls under the bot's limits; the direct
        // /api/send-to-kindle link survives only as the fallback when
        // the handle/post cannot be parsed. tg-send / Convert below
        // still derive their identity from r.send itself.
        const emailUrl = sendUrl ? (botSendLink(r.send) || sendUrl) : null;
        // Action row (2026-11-18): same horizontal .actions row as
        // the OPDS cards — email first (primary), Telegram
        // direct-send next, Convert next, then Read online. The
        // Download button sits in the download section ABOVE the
        // row (button 1), Report in its section BELOW (button 4,
        // last). Each button's own markup is unchanged; only the
        // wrapper is new.
        let actions = "";
        if (emailUrl) {
          actions += "<p><a class=\"btn\" href=\"" + emailUrl + "\">أرسل لميل قارئي</a></p>\n";
        }
        // Telegram direct-send (v4.8.49 — design B.5): SECOND after
        // the email button (email stays primary — the only zero-step
        // path into the Kindle library). The button goes to
        // /api/tg-send with the same identity as the send link
        // (lib=tg&h=&p=&f=&t=...) plus the size hint (&s=) the bot
        // uses for path selection. Gated on fp: without a
        // fingerprint the bot has no chat to send to, so an
        // anonymous visitor sees no button (the endpoint would only
        // show the identity page). Flagged books never reach this
        // branch; OPDS cards have no r.send and no Telegram
        // identity, so they get no button either.
        if (sendUrl && fp && r.send.indexOf("/api/send-to-kindle?") === 0) {
          const tgSendUrl = esc(r.send.replace("/api/send-to-kindle?", "/api/tg-send?"))
            + "&amp;s=" + encodeURIComponent(r.size || "") + fpQ;
          actions += "<p><a class=\"btn\" href=\"" + tgSendUrl + "\">أرسله لي في تيليجرام</a></p>\n";
        }
        // Convert (2026-11-18 rework): UNDER the email button, for
        // Telegram PDF books only — the same gated identity as the
        // send link (lib=tg&h=&p=&f=pdf&t=...), with the path swapped
        // to /api/convert-book. The endpoint converts server-side
        // and emails the EPUB to the linked Kindle email, so it works
        // from the Kindle itself (no Mini App). Flagged books never
        // reach this branch; OPDS cards have no r.send and no
        // Telegram identity, so they get no button either. The
        // formats array holds one uppercase ext per TG result
        // (tg-search toResult), so "PDF" is the check.
        const hasPdf = Array.isArray(r.formats)
          && r.formats.some((f) => String(f).trim().toLowerCase() === "pdf");
        if (sendUrl && hasPdf && r.send.indexOf("/api/send-to-kindle?") === 0) {
          const convertUrl = esc(r.send.replace("/api/send-to-kindle?", "/api/convert-book?")) + fpQ;
          actions += "<p><a class=\"btn\" href=\"" + convertUrl + "\">حوّل إلى EPUB</a></p>\n";
        }
        // WS1b: same gate as the OPDS cards — a download button
        // only for an e-reader family UA. A flagged book has no
        // get link at all, so it never gets one here either.
        // Download (2026-11-21): the get/download button lives in
        // its own visible section (downloadSection), rendered
        // BEFORE the actions row — same rule as the OPDS cards.
        const getUrl = r.get ? esc(r.get) + fpQ : null;
        let otherWaysBtn = "";
        let otherWaysTgOnly = false;
        if (getUrl && downloadLabel) {
          anyDownload = true;
          tgDownload = true;
          otherWaysBtn = "<p><a class=\"btn\" href=\"" + getUrl + "\">" + downloadLabel + "</a></p>\n";
        }
        // WS3b (Mini App hub): same rule as the OPDS cards — the
        // tg-only button appears only when the UA gate hid the
        // download button, so the two never duplicate. The tg-only
        // class goes on the whole download section now.
        if (getUrl && !downloadLabel) {
          otherWaysBtn = "<p><a class=\"btn\" href=\"" + getUrl + "\">احصل على الكتاب على جهازك</a></p>\n";
          otherWaysTgOnly = true;
        }
        const readerUrl = r.read ? esc(r.read) : null;
        if (readerUrl) actions += "<p><a class=\"btn\" href=\"" + readerUrl + "\">اقرأ أونلاين</a></p>\n";
        if (otherWaysBtn) body += downloadSection(otherWaysBtn, family, otherWaysTgOnly);
        if (actions) body += "<div class=\"actions\">\n" + actions + "</div>\n";
        body += reportSection();
        if (!sendUrl) {
          body += "<p class=\"note\">لا يمكن إرسال هذا الكتاب من الموقع — "
            + "اطلبه من البوت "
            + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a>.</p>\n";
        }
      }
      body += "</div>\n";
    }
    // WS1b: shown only when a Telegram card actually rendered a
    // download button — a desktop visitor is never told about a
    // button that is not on their page.
    if (tgDownload) {
      body += "<p class=\"note\">زر التنزيل على كتب تيليجرام يجلب الملف "
        + "من تيليجرام ويعطيك رابط تنزيل يعمل 10 دقائق (5 كتب في اليوم كحد أقصى).</p>\n";
    }
  }

  // Footer note whenever ANY send button is on the page (OPDS cards,
  // or a sendable non-flagged Telegram card) — a page with no send
  // button must not promise one. It explains both delivery paths in
  // one place instead of repeating them on every card: email first
  // (primary) and the download link second (5/day). No "unlimited"
  // claim: Telegram sends now go through the bot (capped), only
  // OPDS sends are still direct. WS1b: the download sentence appears
  // ONLY when a download button was actually rendered (anyDownload), and its wording follows the
  // family — Kindle keeps the phone → sendtokindle steps, Kobo /
  // PocketBook / generic get the on-device wording (no sendtokindle:
  // the file lands in the library straight from the device browser).
  // A desktop/mobile visitor gets the email-only footer.
  const anySend = hits.some(({b}) => TG_SENDABLE_FORMATS.has(fmtCode(b)))
    || tg.results.some((r) => r.send !== null || r.get !== null);
  if (anySend) {
    body += "<p class=\"note\">الإرسال بالإيميل هو الطريقة الأساسية: أرسل الكتاب إلى جهازك، وسيظهر في مكتبتك خلال دقائق. "
      + (anyDownload
        ? family === "kindle"
          ? "أما زر «احصل على الكتاب على جهازك» فيعطيك رابط تنزيل يعمل 10 دقائق "
            + "(5 كتب في اليوم كحد أقصى): نزّل الكتاب على هاتفك أو حاسوبك ثم ارفعه في "
            + "amazon.com/sendtokindle، فيظهر في مكتبتك خلال دقائق. "
          : "أما زر التنزيل فيعطيك رابط تنزيل يعمل 10 دقائق "
            + "(5 كتب في اليوم كحد أقصى): اضغطه على جهازك فينزّل الكتاب مباشرة في مكتبتك "
            + "(أو افتح الرابط من هاتفك وانقل الملف عبر USB). "
        : "")
      + "للإرسال بالإيميل يجب أن تكون قد أضفت المرسل من قبل"
      + (fp
        ? " — ميلك محفوظ في البوت، لن يُطلب منك كتابته."
        : " — سيُطلب منك كتابة بريد جهازك مرة واحدة لكل كتاب، أو أرسله للبوت "
          + "<a href=\"https://t.me/RliBook_bot\">@RliBook_bot</a> ليُحفظ.")
      + "</p>\n";
  }
  body += foot;
  return new Response(body, {headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"}});
}
