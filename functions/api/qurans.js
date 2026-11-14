// Cloudflare Pages Function: Qurans catalogue (Block 13, RliBook).
// Route: GET /api/qurans[?lang=..&format=..&narration=..]
//
//   GET /api/qurans
//     -> 200 { ok: true, tag, releases_url, repo_url, license,
//              count, qurans: [ { id, title_ar, title_en, lang, lang_ar,
//              lang_en, translator, format, format_ar, narration,
//              narration_ar, file, url, size }, ... ],
//              tafsirs: [ { name, lang, lang_ar, size, url }, ... ] }
//   GET /api/qurans?lang=ar            — Arabic-only editions (Hafs/Warsh)
//   GET /api/qurans?lang=en&format=wbw — English word-by-word editions
//   GET /api/qurans?narration=warsh    — the experimental Warsh edition
//   GET /api/qurans?tafsir=ar          — (tafsirs only) Arabic tafsirs
//     With ?tafsir=<lang> the response has { ok, tafsirs, count } only.
//
// No Quran file is stored on our server: every entry links to the
// upstream zeeyado/quran-ebook GitHub Release (v0.10.0, GPL-3.0) or to a
// raw file in that repo (tafsir dictionaries). The data lives in
// qurans-data.js (generated from the verified release asset list).
import {
  QURAN_TAG,
  QURAN_RELEASES_URL,
  QURAN_REPO_URL,
  QURAN_LICENSE,
  QURAN_BOT,
  QURANS,
  TAFSIRS,
} from "./qurans-data.js";

export function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const url = new URL(context.request.url);
  const q = url.searchParams;
  const lang = (q.get("lang") || "").trim().toLowerCase();
  const format = (q.get("format") || "").trim().toLowerCase();
  const narration = (q.get("narration") || "").trim().toLowerCase();
  const tafsirLang = (q.get("tafsir") || "").trim().toLowerCase();

  if (tafsirLang) {
    const tafsirs = TAFSIRS.filter((t) => t.lang === tafsirLang);
    return json({ ok: true, tag: QURAN_TAG, releases_url: QURAN_RELEASES_URL, count: tafsirs.length, tafsirs });
  }

  let list = QURANS;
  if (lang) list = list.filter((e) => e.lang === lang);
  if (format) list = list.filter((e) => e.format === format);
  if (narration) list = list.filter((e) => e.narration === narration);

  return json({
    ok: true,
    tag: QURAN_TAG,
    releases_url: QURAN_RELEASES_URL,
    repo_url: QURAN_REPO_URL,
    license: QURAN_LICENSE,
    bot: QURAN_BOT,
    count: list.length,
    qurans: list,
    tafsirs: TAFSIRS,
  });
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
