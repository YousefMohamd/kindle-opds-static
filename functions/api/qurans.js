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
//   Every tafsir entry carries `combined` (WS1 2026-11-16): the
//   Quran EPUB with that tafsir embedded as endnotes — tap an ayah
//   number, read its tafsir — or null when no combined build exists
//   for its language (Kurdish: no Kurdish Quran edition). The top
//   level also carries `combined_tag` (the RliBook release tag).
//   Warsh has no combined build: its ayah numbering differs from
//   the Hafs numbering the tafsir keys use.
//
// No Quran file is stored on our server: every entry links to the
// upstream zeeyado/quran-ebook GitHub Release (v0.10.0, GPL-3.0) or to a
// raw file in that repo (tafsir dictionaries). The combined EPUBs
// are prebuilt by tools/build-quran-tafsir.py and published as
// GitHub Release assets on the RliBook repo — also not on our
// server. The data lives in
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

/** Combined Quran + tafsir EPUBs (WS1 2026-11-16): each tafsir
 *  embedded as endnotes in the Quran EPUB (one note per commentary
 *  chunk, 6,236 ayah-number links, EPUB3 noteref/footnote). The
 *  files are prebuilt by tools/build-quran-tafsir.py and published
 *  as GitHub Release assets on the RliBook repo under tag
 *  `quran-tafsir-v1` — nothing is hosted on our server. One
 *  combined file per (default Hafs edition x tafsir); the bot
 *  builds the same filename for every edition x tafsir pair. */
export const QURAN_COMBINED_TAG = "quran-tafsir-v1";
export const QURAN_COMBINED_BASE =
  "https://github.com/YousefMohamd/kindle-opds-static/releases/download/" +
  QURAN_COMBINED_TAG;

/** Default (Hafs) edition file per tafsir language — the edition
 *  the combined file is built from. */
const COMBINED_EDITION_FILE = {
  ar: "quran_hafs_kfgqpc_inline_ar.epub",
  en: "quran_hafs_kfgqpc_bilin_ar-en-sahih.epub",
  ur: "quran_hafs_kfgqpc_bilin_ar-ur-jalandhari.epub",
  bn: "quran_hafs_kfgqpc_bilin_ar-bn-taisirul.epub",
  ru: "quran_hafs_kfgqpc_bilin_ar-ru-kuliev.epub",
};

/** The combined EPUB for one tafsir entry, or null when there is
 *  no combined build for its language (Kurdish — no Kurdish Quran
 *  edition in the catalogue). The tafsir id comes from its ZIP
 *  filename: quran_tafsir_<id>_v1.1.zip. Exported so the OPDS feed
 *  reuses the same file + URL instead of hardcoding a second copy. */
export function combinedForTafsir(t) {
  const m = /quran_tafsir_(.+)_v1\.1\.zip$/.exec(t.url || "");
  const editionFile = COMBINED_EDITION_FILE[t.lang];
  if (!m || !editionFile) return null;
  const file = editionFile.replace(/\.epub$/, `--tafsir-${m[1]}.epub`);
  return { id: m[1], file, url: QURAN_COMBINED_BASE + "/" + file, edition_file: editionFile };
}

function withCombined(tafsirs) {
  return tafsirs.map((t) => ({ ...t, combined: combinedForTafsir(t) }));
}

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
    return json({ ok: true, tag: QURAN_TAG, releases_url: QURAN_RELEASES_URL, combined_tag: QURAN_COMBINED_TAG, count: tafsirs.length, tafsirs: withCombined(tafsirs) });
  }

  let list = QURANS;
  if (lang) list = list.filter((e) => e.lang === lang);
  if (format) list = list.filter((e) => e.format === format);
  if (narration) list = list.filter((e) => e.narration === narration);

  return json({
    ok: true,
    tag: QURAN_TAG,
    releases_url: QURAN_RELEASES_URL,
    combined_tag: QURAN_COMBINED_TAG,
    repo_url: QURAN_REPO_URL,
    license: QURAN_LICENSE,
    bot: QURAN_BOT,
    count: list.length,
    qurans: list,
    tafsirs: withCombined(TAFSIRS),
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
