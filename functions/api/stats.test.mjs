// Test for the live-stats endpoint (functions/api/stats.js).
// Standalone Node script — run from the repo root:
//   node functions/api/stats.test.mjs
//
// It imports the real Function module and checks, with NO network,
// NO production D1/KV and NO deploy:
//   1. buildStats() on the REAL local files (site/telegram/index.json,
//      newest.json, newspapers.json + the five search-index.json):
//      every number equals the value computed independently from the
//      same files — the endpoint reports live data, never hardcoded
//      numbers. (Local files are the 2026-11-13 publish; the LIVE
//      site may already be one daily sync ahead — that is expected:
//      the endpoint reads whatever is published at request time.)
//   2. onRequest() over HTTP semantics with a mocked ASSETS binding
//      (serving the real local files) and no D1: 200, ok:true, the
//      Telegram book count matches the manifest, 6 libraries, the
//      newest list matches newest.json, views/downloads/bot are null
//      (honest "not measured yet", not invented zeros).
//   3. onRequest() with a mocked TG_D1 binding: books_d1.count is
//      the mocked COUNT(*) and the manifest count is unchanged.
//   4. Missing manifest -> 503, ok:false, no numbers returned.
//   5. Non-GET -> 405.
// Exit 0 = all pass; non-zero + a message = failure.

import { readFileSync } from "node:fs";
import { buildStats, onRequest } from "./stats.js";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- 1. buildStats() against the real local files ----------------------
const manifest = loadJson("site/telegram/index.json");
const newest = loadJson("site/telegram/newest.json");
const newspapers = loadJson("site/newspapers.json");
const OPDS = ["khazendar", "sahwa", "electronic", "hindawi", "doab"];
const opdsCounts = {};
for (const lib of OPDS) {
  opdsCounts[lib] = loadJson(lib + "/search-index.json").length;
}

const stats = buildStats(manifest, newest, newspapers, opdsCounts, null);
const t = manifest.totals;

check("1a telegram books == manifest totals.books",
  stats.books.telegram === t.books, String(stats.books.telegram) + " vs " + t.books);
check("1b telegram files == manifest totals.files",
  stats.files.telegram === t.files);
check("1c telegram posts == manifest totals.posts",
  stats.posts.telegram === t.posts);
check("1d telegram sources == manifest totals.sources",
  stats.sources.telegram_total === t.sources);
check("1e sources split by kind adds up",
  stats.sources.channels + stats.sources.groups === t.sources,
  JSON.stringify(stats.sources));
check("1f total books == telegram + OPDS sum",
  stats.books.total === t.books + OPDS.reduce((s, l) => s + opdsCounts[l], 0),
  String(stats.books.total));
check("1g libraries_count == 6 (5 OPDS + Telegram)",
  stats.libraries_count === 6 && stats.libraries.length === 6);
check("1h each OPDS library count == its search-index length",
  OPDS.every((l) => {
    const row = stats.libraries.find((x) => x.key === l);
    return row && row.books === opdsCounts[l];
  }));
check("1i newest count == newest.json count, first title matches",
  stats.newest.count === newest.books.length &&
    stats.newest.books[0] &&
    stats.newest.books[0].title === newest.books[0].title,
  String(stats.newest.count));
check("1j newspapers date + entries from newspapers.json",
  stats.newspapers.date === newspapers.date &&
    stats.newspapers.entries ===
      newspapers.sources.reduce((s, x) => s + (x.entries || 0), 0));
check("1k views/downloads/bot are null, not invented",
  stats.views.count === null &&
    stats.downloads.count === null &&
    stats.bot.stats === null);
check("1l D1 count null when D1 not bound",
  stats.books_d1.count === null);

// D1 present: both counts reported, manifest unchanged.
const withD1 = buildStats(manifest, newest, newspapers, opdsCounts, 99996);
check("1m D1 count reported alongside manifest count",
  withD1.books_d1.count === 99996 && withD1.books.telegram === t.books);

// One unreadable OPDS index: that library null, total null, rest intact.
const partial = { ...opdsCounts, doab: null };
const partialStats = buildStats(manifest, newest, newspapers, partial, null);
check("1n unreadable library -> null count, total null, telegram intact",
  partialStats.libraries.find((x) => x.key === "doab").books === null &&
    partialStats.books.total === null &&
    partialStats.books.telegram === t.books);

// --- 2. onRequest() with mocked ASSETS (real local files) --------------
const FILE_FOR_PATH = {
  "/site/telegram/index.json": "site/telegram/index.json",
  "/site/telegram/newest.json": "site/telegram/newest.json",
  "/site/newspapers.json": "site/newspapers.json",
};
for (const lib of OPDS) {
  FILE_FOR_PATH["/" + lib + "/search-index.json"] = lib + "/search-index.json";
}

function mockAssets(files) {
  return {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const file = files[path];
      if (!file) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file, "utf8"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function mockRequest(url, method = "GET") {
  return new Request(url, { method });
}

const res = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: { ASSETS: mockAssets(FILE_FOR_PATH) },
});
check("2a onRequest no-D1 -> 200", res.status === 200, "HTTP " + res.status);
const body = await res.json();
check("2b body ok:true", body.ok === true);
check("2c body books.telegram == manifest totals.books",
  body.books.telegram === t.books, String(body.books.telegram));
check("2d body total == telegram + OPDS",
  body.books.total === t.books + OPDS.reduce((s, l) => s + opdsCounts[l], 0),
  String(body.books.total));
check("2e body libraries_count == 6, newest 30",
  body.libraries_count === 6 && body.newest.count === 30,
  body.libraries_count + "/" + body.newest.count);
check("2f body views/downloads null (not measured yet)",
  body.views.count === null && body.downloads.count === null);
check("2g body books_d1 null without D1",
  body.books_d1.count === null);

// --- 3. onRequest() with mocked D1 --------------------------------------
const resD1 = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: {
    ASSETS: mockAssets(FILE_FOR_PATH),
    TG_D1: { prepare: () => ({ first: async () => ({ n: 99996 }) }) },
  },
});
const bodyD1 = await resD1.json();
check("3a D1 bound -> books_d1.count is the D1 COUNT(*)",
  bodyD1.books_d1.count === 99996, String(bodyD1.books_d1.count));
check("3b D1 bound -> manifest count unchanged",
  bodyD1.books.telegram === t.books);

// --- 4. Missing manifest -> 503, no numbers ----------------------------
const resNoManifest = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: { ASSETS: mockAssets({}) },
});
check("4a missing manifest -> 503", resNoManifest.status === 503,
  "HTTP " + resNoManifest.status);
const bodyNoManifest = await resNoManifest.json();
check("4b missing manifest -> ok:false, no books field",
  bodyNoManifest.ok === false && bodyNoManifest.books === undefined);

// --- 5. Non-GET -> 405 ---------------------------------------------------
const resPost = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats", "POST"),
  env: { ASSETS: mockAssets(FILE_FOR_PATH) },
});
check("5a POST -> 405", resPost.status === 405, "HTTP " + resPost.status);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
