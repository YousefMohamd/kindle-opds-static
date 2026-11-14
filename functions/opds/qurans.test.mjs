// Test for the Qurans OPDS feed (functions/opds/qurans.js).
// Standalone Node script — run from the repo root:
//   node functions/opds/qurans.test.mjs
// No network, no D1/KV, no deploy. Exit 0 = all pass.
import { onRequest } from "./qurans.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

async function get(path) {
  const res = await onRequest({ request: new Request("https://rlibook.tech" + path) });
  return { status: res.status, ct: res.headers.get("content-type"), xml: await res.text() };
}

const full = await get("/opds/qurans");
check("GET /opds/qurans -> 200 OPDS acquisition feed",
  full.status === 200 && full.ct.includes("kind=acquisition"));
check("feed is well-formed XML with the OPDS namespace",
  full.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') &&
  full.xml.includes('xmlns:opds="http://opds-spec.org/2010/catalog"'));
check("totalResults = 49 qurans + 20 tafsirs",
  full.xml.includes("<opds:totalResults>69</opds:totalResults>"));
check("Arabic Hafs entry present",
  full.xml.includes("urn:rlibook:quran:ar-hafs"));
check("Warsh entry present with its narration",
  full.xml.includes("urn:rlibook:quran:ar-warsh") && full.xml.includes("ورش عن نافع"));
check("acquisition links point at the upstream release, not our server",
  full.xml.includes("https://github.com/zeeyado/quran-ebook/releases/download/v0.10.0/") &&
  !full.xml.includes("rlibook.tech/") &&
  !full.xml.includes("drive.google.com"));
check("acquisition links carry the EPUB type",
  full.xml.includes('type="application/epub+zip"'));
check("tafsir entries present with install path in content",
  full.xml.includes("urn:rlibook:tafsir:quran_tafsir_muyassar_v1.1") &&
  full.xml.includes("koreader/data/dict/"));
check("no double-escaped ampersands in links",
  !full.xml.includes("&amp;amp;"));

const ar = await get("/opds/qurans?lang=ar");
check("?lang=ar filters the feed to the 2 Arabic editions",
  ar.xml.includes("<opds:totalResults>22</opds:totalResults>") &&
  ar.xml.includes("urn:rlibook:quran:ar-hafs") &&
  !ar.xml.includes("urn:rlibook:quran:ar-en-sahih-bilingual"));

console.log(`\nqurans-opds.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
