// Test for the Qurans catalogue endpoint (functions/api/qurans.js).
// Standalone Node script — run from the repo root:
//   node functions/api/qurans.test.mjs
// No network, no D1/KV, no deploy. Exit 0 = all pass.
import { onRequest } from "./qurans.js";
import { QURANS, TAFSIRS } from "./qurans-data.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

async function get(path) {
  const res = await onRequest({ request: new Request("https://rlibook.tech" + path) });
  return { status: res.status, ct: res.headers.get("content-type"), body: await res.json() };
}

// --- data integrity (the generated catalogue) ---------------------------
check("49 Quran editions", QURANS.length === 49, "got " + QURANS.length);
check("20 tafsirs in 6 languages",
  TAFSIRS.length === 20 && new Set(TAFSIRS.map((t) => t.lang)).size === 6,
  "got " + TAFSIRS.length);
check("every Quran URL is an upstream GitHub release download",
  QURANS.every((e) => e.url.startsWith("https://github.com/zeeyado/quran-ebook/releases/download/v0.10.0/")));
check("no Quran file hosted on our server",
  QURANS.every((e) => !e.url.includes("rlibook.tech") && !e.url.includes("pages.dev")));
check("every tafsir URL is an upstream raw file",
  TAFSIRS.every((t) => t.url.startsWith("https://raw.githubusercontent.com/zeeyado/quran-ebook/main/release/quran_tafsir_")));
check("unique Quran ids", new Set(QURANS.map((e) => e.id)).size === QURANS.length);
check("Hafs + Warsh Arabic-only editions exist",
  QURANS.some((e) => e.id === "ar-hafs") && QURANS.some((e) => e.id === "ar-warsh"));
check("all 3 formats exist for English Sahih",
  ["bilingual", "interactive", "wbw"].every((f) => QURANS.some((e) => e.id === "ar-en-sahih-" + f)));

// --- endpoint ------------------------------------------------------------
const all = await get("/api/qurans");
check("GET /api/qurans -> 200 JSON", all.status === 200 && all.ct.includes("application/json"));
check("full list count matches data", all.body.ok === true && all.body.count === QURANS.length);
check("tafsirs included in full response", all.body.tafsirs.length === 20);
check("releases URL is the real one",
  all.body.releases_url === "https://github.com/zeeyado/quran-ebook/releases/latest");

const ar = await get("/api/qurans?lang=ar");
check("?lang=ar returns only the 2 Arabic editions",
  ar.body.count === 2 && ar.body.qurans.every((e) => e.lang === "ar"), "got " + ar.body.count);
const wbw = await get("/api/qurans?lang=en&format=wbw");
check("?lang=en&format=wbw returns 5 English WBW editions",
  wbw.body.count === 5 && wbw.body.qurans.every((e) => e.format === "wbw"), "got " + wbw.body.count);
const warsh = await get("/api/qurans?narration=warsh");
check("?narration=warsh returns only Warsh",
  warsh.body.count === 1 && warsh.body.qurans[0].id === "ar-warsh", "got " + warsh.body.count);
const taf = await get("/api/qurans?tafsir=ar");
check("?tafsir=ar returns 7 Arabic tafsirs only",
  taf.body.count === 7 && taf.body.tafsirs.every((t) => t.lang === "ar") && !("qurans" in taf.body),
  "got " + taf.body.count);
check("combined_tag is the RliBook release tag",
  all.body.combined_tag === "quran-tafsir-v1" && taf.body.combined_tag === "quran-tafsir-v1");
check("every tafsir with a combined build links its combined EPUB",
  all.body.tafsirs.filter((t) => t.combined).length === 19 &&
  all.body.tafsirs.every((t) =>
    t.combined === null ||
    (t.combined.url === "https://github.com/YousefMohamd/kindle-opds-static/releases/download/quran-tafsir-v1/" + t.combined.file &&
     t.combined.file.endsWith(`--tafsir-${t.combined.id}.epub`))),
  "got " + all.body.tafsirs.filter((t) => t.combined).length + " combined");
check("Muyassar combined file is the Hafs Arabic edition + tafsir",
  all.body.tafsirs.find((t) => t.name === "التفسير الميسر")?.combined?.file ===
    "quran_hafs_kfgqpc_inline_ar--tafsir-muyassar.epub");
check("Kurdish tafsir has no combined build (no Kurdish Quran edition)",
  all.body.tafsirs.find((t) => t.lang === "ku")?.combined === null);
check("?tafsir=ar tafsirs carry their combined files",
  taf.body.tafsirs.length === 7 && taf.body.tafsirs.every((t) => t.combined && t.combined.id));
const none = await get("/api/qurans?lang=xx");
check("unknown lang returns empty list, still 200",
  none.status === 200 && none.body.count === 0);

console.log(`\nqurans.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
