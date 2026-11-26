// Tests for the OPDS search routes (Area 2 review).
// Standalone Node scripts — run from the repo root:
//   node functions/opds/search.test.mjs
//   node functions/opds/fp.test.mjs
//
// Covers what the original build never tested:
//   - every OPDS search route refuses non-GET with 405 (a feed is a
//     read-only lookup; a POST used to return a feed);
//   - a missing or malformed search index is a 500 naming the index,
//     never an uncaught throw (a bare runtime 500) and never partial
//     results presented as complete;
//   - the combined search still finds a real book from the real
//     local indexes (no regression from the hardening).
// No network, no production D1/KV, no deploy. Exit 0 = all pass.

import { readFileSync } from "node:fs";
import { onRequest as combinedSearch, loadSearchIndex, indexTextMayContain } from "./search.js";
import { onRequest as khazendarSearch } from "../khazendar/opds/search.js";
import { onRequest as quransFeed } from "./qurans.js";
import { onRequest as quransApi } from "../api/qurans.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const idx = {};
for (const s of ["khazendar", "sahwa", "electronic", "hindawi", "doab", "drive"]) {
  idx["/" + s + "/search-index.json"] = readFileSync(
    new URL("../../" + s + "/search-index.json", import.meta.url),
    "utf8",
  );
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (idx[url.pathname]) {
    return new Response(idx[url.pathname], { headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};

async function call(fn, method, path, env = {}) {
  const res = await fn({
    request: new Request("https://rlibook.tech" + path, { method }),
    env,
    params: {},
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

// 1. Non-GET is 405 on every OPDS search route.
{
  for (const [name, fn, path] of [
    ["combined /opds/search", combinedSearch, "/opds/search?q=test"],
    ["khazendar /khazendar/opds/search", khazendarSearch, "/khazendar/opds/search?q=test"],
    ["OPDS Qurans feed", quransFeed, "/opds/qurans"],
    ["Qurans API", quransApi, "/api/qurans"],
  ]) {
    const r = await call(fn, "POST", path);
    check(`1 ${name}: POST -> 405`, r.status === 405, `status=${r.status}`);
  }
}

// 2. Combined search still works (no regression).
{
  const r = await call(combinedSearch, "GET", "/opds/search?q=" + encodeURIComponent("لؤلؤة الحب"));
  check("2 combined search: 200 + Atom feed",
    r.status === 200 && r.body.includes("<feed") && r.body.includes("لؤلؤة الحب"),
    `status=${r.status}`);
  check("2 combined search: acquisition link, no double-escaped ampersand",
    r.body.includes("hindawi.org/books/13028368.epub") && !r.body.includes("&amp;amp;"));
  const empty = await call(combinedSearch, "GET", "/opds/search?q=");
  check("2 combined search: empty query -> empty valid feed",
    empty.status === 200 && empty.body.includes("<feed"));
  const kh = await call(khazendarSearch, "GET", "/khazendar/opds/search?q=" + encodeURIComponent("الحب"));
  check("2 khazendar search: 200 + results",
    kh.status === 200 && kh.body.includes("<feed") && kh.body.includes("opds:totalResults"),
    `status=${kh.status}`);
  // WAVE 4, WS8 — the sixth index: a Drive-library book (Oriental
  // Music) appears in the combined OPDS feed with a Drive uc link.
  const rd = await call(combinedSearch, "GET", "/opds/search?q=" + encodeURIComponent("نزهة الزمان"));
  check("2b combined search: Drive book found in the OPDS feed",
    rd.status === 200 && rd.body.includes("نزهة الزمان") && rd.body.includes("drive.google.com/uc?id=1I7rOn96NuAgIUQBdCjmGcZnM3BCwH6uX"),
    `status=${rd.status}`);
}

// 3. Missing / malformed index -> 500 naming the index, never a throw.
{
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/sahwa/search-index.json") return new Response("x", { status: 404 });
    return saved(u);
  };
  const r = await call(combinedSearch, "GET", "/opds/search?q=" + encodeURIComponent("الحب"));
  check("3 missing index: 500 naming the failed index",
    r.status === 500 && r.body.includes("/sahwa/search-index.json"),
    `status=${r.status} body=${r.body.slice(0, 80)}`);
  globalThis.fetch = saved;
}
{
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname === "/khazendar/search-index.json") {
      return new Response('{"not": "an array"}', { headers: { "content-type": "application/json" } });
    }
    return saved(u);
  };
  const r = await call(khazendarSearch, "GET", "/khazendar/opds/search?q=" + encodeURIComponent("الحب"));
  check("3 malformed index (non-array JSON): 500, not a throw",
    r.status === 500 && r.body.includes("search index not found"),
    `status=${r.status} body=${r.body.slice(0, 80)}`);
  globalThis.fetch = saved;
}
{
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  const r = await call(combinedSearch, "GET", "/opds/search?q=" + encodeURIComponent("الحب"));
  check("3 fetch throw: 500 naming the index, not a runtime crash",
    r.status === 500 && r.body.includes("/khazendar/search-index.json"),
    `status=${r.status} body=${r.body.slice(0, 80)}`);
  globalThis.fetch = saved;
}

// 4. REGRESSION (1102): search-index pre-filter.
// The old code JSON.parse()d every index on every search (44–53 ms
// CPU for a no-hit query). loadSearchIndex now skips the parse when
// the needle provably cannot match. These tests FAIL on the old code
// (no loader; json() is always called) and PASS with the fix — and
// they pin that skipping never changes the results.
{
  const KH_TEXT = idx["/khazendar/search-index.json"];
  check("4 indexTextMayContain: Arabic needle present -> true",
    indexTextMayContain(KH_TEXT, "الحب") === true);
  check("4 indexTextMayContain: Arabic needle absent -> false (skip is safe)",
    indexTextMayContain(KH_TEXT, "كلمةغيرموجودة") === false);
  check("4 indexTextMayContain: Latin needle -> true (case could differ, must parse)",
    indexTextMayContain(KH_TEXT, "love") === true);
  check("4 indexTextMayContain: uppercase Greek needle -> true (must parse)",
    indexTextMayContain(KH_TEXT, "ΑΘΉΝΑ") === true);
  check("4 indexTextMayContain: needle with a quote -> true (JSON escaping could hide it)",
    indexTextMayContain(KH_TEXT, 'الحب"') === true);
  check("4 indexTextMayContain: needle with a backslash -> true",
    indexTextMayContain(KH_TEXT, "الحب\\") === true);

  // A counting JSON.parse proves the no-hit path never parses (the
  // loader parses the fetched text itself — it never calls res.json()).
  let parseCalls = 0;
  const realParse = JSON.parse;
  JSON.parse = (...a) => { parseCalls++; return realParse(...a); };
  const countingFetch = async (u) => {
    const url = new URL(u);
    const text = idx[url.pathname];
    if (!text) return new Response("not found", { status: 404 });
    return new Response(text, { headers: { "content-type": "application/json" } });
  };
  const saved = globalThis.fetch;
  globalThis.fetch = countingFetch;
  try {
    parseCalls = 0;
    const skipped = await loadSearchIndex("https://rlibook.tech", "khazendar", "كلمةغيرموجودة");
    check("4 loadSearchIndex: no-hit Arabic needle -> { skip: true }, JSON.parse never called",
      skipped.skip === true && parseCalls === 0, JSON.stringify({ skipped, parseCalls }));
    parseCalls = 0;
    const hit = await loadSearchIndex("https://rlibook.tech", "khazendar", "الحب");
    check("4 loadSearchIndex: hit Arabic needle -> { books }, JSON.parse called once",
      Array.isArray(hit.books) && hit.books.length > 0 && parseCalls === 1,
      `books=${hit.books && hit.books.length} parseCalls=${parseCalls}`);
    parseCalls = 0;
    const latin = await loadSearchIndex("https://rlibook.tech", "khazendar", "love");
    check("4 loadSearchIndex: Latin needle -> parsed (JSON.parse called, guard tripped)",
      parseCalls === 1, `parseCalls=${parseCalls}`);
    void latin;
  } finally {
    globalThis.fetch = saved;
    JSON.parse = realParse;
  }

  // Malformed indexes must still error, never read as "no hits" —
  // even when the needle is absent from the corrupt text.
  const badFetch = (body) => async () => new Response(body, { headers: { "content-type": "application/json" } });
  const saved2 = globalThis.fetch;
  try {
    globalThis.fetch = badFetch("{not json");
    const bad = await loadSearchIndex("https://rlibook.tech", "sahwa", "الحب");
    check("4 loadSearchIndex: invalid JSON -> { error: true }, not a silent skip",
      bad.error === true, JSON.stringify(bad));
    globalThis.fetch = badFetch('{"not": "an array"}');
    const nonArray = await loadSearchIndex("https://rlibook.tech", "khazendar", "الحب");
    check("4 loadSearchIndex: non-array JSON -> { error: true }",
      nonArray.error === true, JSON.stringify(nonArray));
    globalThis.fetch = badFetch('[{"t": "الحب", "a": "", "i": "x", "m": "application/epub+zip"},');
    const truncated = await loadSearchIndex("https://rlibook.tech", "khazendar", "كلمةغيرموجودة");
    check("4 loadSearchIndex: truncated array -> { error: true }",
      truncated.error === true, JSON.stringify(truncated));
    globalThis.fetch = badFetch("[]");
    const empty = await loadSearchIndex("https://rlibook.tech", "khazendar", "الحب");
    check("4 loadSearchIndex: empty array -> skip (no hits, correctly)",
      empty.skip === true, JSON.stringify(empty));
  } finally {
    globalThis.fetch = saved2;
  }

  // End to end: the combined feed with the fix returns EXACTLY the
  // same titles as a direct full-parse scan of the local indexes,
  // for hit, no-hit, Arabic and Latin queries.
  const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  const referenceTitles = (q) => {
    const needle = q.toLowerCase();
    const out = [];
    for (const s of ["khazendar", "sahwa", "electronic", "hindawi", "doab", "drive"]) {
      const books = JSON.parse(idx["/" + s + "/search-index.json"]);
      for (const b of books) {
        if (((b.t || "") + " " + (b.a || "")).toLowerCase().includes(needle)) {
          out.push(b.t);
          if (out.length >= 100) return out;
        }
      }
      if (out.length >= 100) break;
    }
    return out;
  };
  for (const q of ["لؤلؤة الحب", "الحب", "كلمةغيرموجودة", "love", "Mobi", "الصلح"]) {
    const r = await call(combinedSearch, "GET", "/opds/search?q=" + encodeURIComponent(q));
    const feedTitles = [...r.body.matchAll(/<entry><title>(.*?)<\/title>/g)].map((m) => unesc(m[1]));
    const expected = referenceTitles(q);
    check(`4 equivalence: combined search "${q}" returns the same ${expected.length} titles as a full-parse scan`,
      r.status === 200 && JSON.stringify(feedTitles) === JSON.stringify(expected),
      `status=${r.status} got=${feedTitles.length} expected=${expected.length}`);
  }
  const noHit = await call(combinedSearch, "GET", "/opds/search?q=" + encodeURIComponent("كلمةغيرموجودة"));
  check("4 no-hit Arabic query: 200 + empty feed (totalResults 0), not a 500",
    noHit.status === 200 && noHit.body.includes("<opds:totalResults>0</opds:totalResults>"),
    `status=${noHit.status}`);
  const noHitLib = await call(khazendarSearch, "GET", "/khazendar/opds/search?q=" + encodeURIComponent("كلمةغيرموجودة"));
  check("4 no-hit per-library query: 200 + empty feed",
    noHitLib.status === 200 && noHitLib.body.includes("<opds:totalResults>0</opds:totalResults>"),
    `status=${noHitLib.status}`);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
