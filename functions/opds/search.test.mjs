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
import { onRequest as combinedSearch } from "./search.js";
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
for (const s of ["khazendar", "sahwa", "electronic", "hindawi", "doab"]) {
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

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
