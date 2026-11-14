// Cloudflare Pages Function: OPDS feed for the Qurans (Block 13, RliBook).
// Route: GET /opds/qurans
//
// KOReader users find the Qurans in their library through this feed.
// It is an OPDS acquisition feed: one <entry> per Quran edition (title,
// language, format, narration), with an acquisition link that points
// DIRECTLY at the upstream GitHub Release EPUB — no Quran file is stored
// on our server. A second section lists the 20 tafsir dictionaries
// (KOReader Quran Helper plugin): each entry links to its StarDict zip
// on raw.githubusercontent.com, with the install path in the content.
//
// Route note: functions/opds/[[fp]].js is a catch-all under /opds/; this
// exact file route (/opds/qurans) takes precedence over the dynamic
// catch-all in Cloudflare Pages routing. Verify live after deploy that
// /opds/qurans returns THIS feed (not the fingerprint nav feed).
// Entry shape matches the existing catalog (index.xml + opds/search.js):
// same <entry> shape, same acquisition link relation, same content-type
// headers, same XML escaping (raw URLs escaped exactly once).
import { QURAN_TAG, QURAN_RELEASES_URL, QURANS, TAFSIRS } from "../api/qurans-data.js";

const ACQ_CT = "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8";
const UPDATED = "2026-11-14T00:00:00Z";
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function onRequest(context) {
  const url = new URL(context.request.url);
  const lang = (url.searchParams.get("lang") || "").trim().toLowerCase();
  let list = QURANS;
  if (lang) list = list.filter((e) => e.lang === lang);

  let out = '<?xml version="1.0" encoding="UTF-8"?>';
  out += '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">';
  out += "<title>المصاحف الإلكترونية — Qurans (RliBook)</title>";
  out += "<id>urn:rlibook:qurans</id><updated>" + UPDATED + "</updated>";
  out += '<link rel="self" href="/opds/qurans' + (lang ? "?lang=" + encodeURIComponent(lang) : "") + '" type="' + ACQ_CT + '"/>';
  out += "<opds:totalResults>" + (list.length + TAFSIRS.length) + "</opds:totalResults>";
  out += "<subtitle>Quran EPUBs (Hafs / Warsh, 10 languages) + 20 tafsir dictionaries for the KOReader Quran Helper plugin. Files come from the upstream zeeyado/quran-ebook release " + esc(QURAN_TAG) + " — nothing is hosted on our server.</subtitle>";

  for (const e of list) {
    out += "<entry><title>" + esc(e.title_ar + " — " + e.title_en) + "</title>";
    out += "<id>urn:rlibook:quran:" + esc(e.id) + "</id><updated>" + UPDATED + "</updated>";
    out += "<author><name>" + esc(e.translator || "Quran.com / King Fahd Complex") + "</name></author>";
    out += "<category term=\"" + esc(e.lang) + "\" label=\"" + esc(e.lang_en) + "\"/>";
    out += "<category term=\"" + esc(e.format) + "\" label=\"" + esc(e.format_ar) + "\"/>";
    out += "<category term=\"" + esc(e.narration) + "\" label=\"" + esc(e.narration_ar) + "\"/>";
    out += '<link rel="http://opds-spec.org/acquisition" href="' + esc(e.url) + '" type="application/epub+zip" length="' + e.size + '"/>';
    out += "<content type=\"text\">" + esc(e.lang_ar + " — " + e.format_ar + " — " + e.narration_ar + ". المصدر: " + QURAN_RELEASES_URL) + "</content>";
    out += "</entry>";
  }

  for (const t of TAFSIRS) {
    out += "<entry><title>" + esc("تفسير: " + t.name) + "</title>";
    out += "<id>urn:rlibook:tafsir:" + esc(t.url.split("/").pop().replace(".zip", "")) + "</id><updated>" + UPDATED + "</updated>";
    out += "<category term=\"tafsir\" label=\"Tafsir dictionary\"/>";
    out += "<category term=\"" + esc(t.lang) + "\" label=\"" + esc(t.lang_ar) + "\"/>";
    out += '<link rel="http://opds-spec.org/acquisition" href="' + esc(t.url) + '" type="application/zip"/>';
    out += "<content type=\"text\">" + esc("قاموس تفسير لإضافة KOReader Quran Helper — فك الضغط في koreader/data/dict/ ثم اضغط مطولاً على رقم الآية. الحجم: " + t.size + ".") + "</content>";
    out += "</entry>";
  }

  out += "</feed>";
  return new Response(out, { headers: { "content-type": ACQ_CT } });
}
