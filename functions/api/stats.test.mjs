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
//      the mocked MAX(id) and the manifest count is unchanged.
//   4. Missing manifest -> 503, ok:false, no numbers returned.
//   5. Non-GET -> 405.
//   6. D1 count via the shared KV coverage cache (`tg-search:coverage`,
//      same key as /api/tg-search): a KV hit is used with NO live
//      MAX(id) (the D1 mock records prepare() calls); a KV miss /
//      error / malformed value falls back to the live count once and
//      repopulates the cache; the response shape (source + note) is
//      identical to the live-count path.
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

// The D1 note must say D1 is a partial snapshot import (finishing
// Thu 2026-11-19 at 323,325 books) with the manifest still growing
// past it — not just "import still running". No manifest number is
// quoted as permanent: the manifest total is read live, above.
check("1m2 D1 note: partial snapshot import, manifest keeps growing",
  withD1.books_d1.note.includes("snapshot import") &&
    withD1.books_d1.note.includes("2026-11-19") &&
    withD1.books_d1.note.includes("323,325") &&
    withD1.books_d1.note.includes("keeps growing daily") &&
    withD1.books_d1.note.includes("headline count"),
  withD1.books_d1.note);

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
check("3a D1 bound -> books_d1.count is the D1 MAX(id)",
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

// --- 6. D1 count via the shared KV coverage cache ----------------------
// The KV mock records gets/puts; the D1 mock records prepare() calls,
// so the tests prove a KV hit runs NO live MAX(id) refresh.
function mockKvStore(initial, opts = {}) {
  const store = new Map();
  if (initial !== undefined) store.set("tg-search:coverage", initial);
  const calls = { gets: [], puts: [] };
  return {
    calls,
    kv: {
      get: async (key) => {
        calls.gets.push(key);
        if (opts.throwOnGet) throw new Error("kv down");
        return store.has(key) ? store.get(key) : null;
      },
      put: async (key, value, putOpts) => {
        calls.puts.push({ key, value, opts: putOpts });
        if (opts.throwOnPut) throw new Error("kv put down");
        store.set(key, value);
      },
    },
  };
}

function mockD1(count) {
  const calls = { prepares: 0 };
  return {
    calls,
    db: {
      prepare: () => {
        calls.prepares += 1;
        return { first: async () => ({ n: count }) };
      },
    },
  };
}

// 6a: KV hit (valid value) -> the KV count is used, D1 never touched.
const kvHit = mockKvStore(JSON.stringify({ indexed: 149996, at: Date.now() }));
const d1Hit = mockD1(1); // would return 1 if called — must not be
const resKvHit = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: { ASSETS: mockAssets(FILE_FOR_PATH), RLIBOOK_KV: kvHit.kv, TG_D1: d1Hit.db },
});
const bodyKvHit = await resKvHit.json();
check("6a KV hit -> books_d1.count is the KV indexed value",
  bodyKvHit.books_d1.count === 149996, String(bodyKvHit.books_d1.count));
check("6b KV hit -> NO live MAX(id) ran (prepare not called)",
  d1Hit.calls.prepares === 0, "prepares=" + d1Hit.calls.prepares);
check("6c KV hit -> cache not rewritten (no put)",
  kvHit.calls.puts.length === 0, "puts=" + kvHit.calls.puts.length);
check("6d KV hit -> response shape identical to live-count path",
  bodyKvHit.books_d1.source === bodyD1.books_d1.source &&
    bodyKvHit.books_d1.note === bodyD1.books_d1.note &&
    Object.keys(bodyKvHit.books_d1).sort().join(",") === "count,note,source",
  JSON.stringify(bodyKvHit.books_d1));

// 6e: KV miss -> live MAX(id) once, then the cache is repopulated.
const kvMiss = mockKvStore();
const d1Miss = mockD1(99996);
const resKvMiss = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: { ASSETS: mockAssets(FILE_FOR_PATH), RLIBOOK_KV: kvMiss.kv, TG_D1: d1Miss.db },
});
const bodyKvMiss = await resKvMiss.json();
check("6e KV miss -> falls back to live MAX(id)",
  bodyKvMiss.books_d1.count === 99996 && d1Miss.calls.prepares === 1,
  String(bodyKvMiss.books_d1.count) + " prepares=" + d1Miss.calls.prepares);
check("6f KV miss -> cache repopulated with same key + 1 h TTL",
  kvMiss.calls.puts.length === 1 &&
    kvMiss.calls.puts[0].key === "tg-search:coverage" &&
    JSON.parse(kvMiss.calls.puts[0].value).indexed === 99996 &&
    kvMiss.calls.puts[0].opts.expirationTtl === 3600,
  JSON.stringify(kvMiss.calls.puts));

// 6g: KV get throws -> falls back to the live count, response still 200.
const kvErr = mockKvStore(undefined, { throwOnGet: true });
const d1Err = mockD1(99996);
const resKvErr = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: { ASSETS: mockAssets(FILE_FOR_PATH), RLIBOOK_KV: kvErr.kv, TG_D1: d1Err.db },
});
const bodyKvErr = await resKvErr.json();
check("6g KV get throws -> live MAX(id) fallback, still 200",
  resKvErr.status === 200 && bodyKvErr.books_d1.count === 99996 &&
    d1Err.calls.prepares === 1,
  "HTTP " + resKvErr.status + " count=" + bodyKvErr.books_d1.count);

// 6h: KV malformed (bad JSON, then non-number indexed) -> live fallback.
for (const bad of ['{"indexed":', '{"indexed":"abc"}', '{"indexed":-5}']) {
  const kvBad = mockKvStore(bad);
  const d1Bad = mockD1(99996);
  const resBad = await onRequest({
    request: mockRequest("https://rlibook.tech/api/stats"),
    env: { ASSETS: mockAssets(FILE_FOR_PATH), RLIBOOK_KV: kvBad.kv, TG_D1: d1Bad.db },
  });
  const bodyBad = await resBad.json();
  check("6h KV malformed " + bad + " -> live MAX(id) fallback",
    bodyBad.books_d1.count === 99996 && d1Bad.calls.prepares === 1,
    String(bodyBad.books_d1.count));
}

// 6i: KV put throws on repopulate -> live count still returned, no failure.
const kvPutErr = mockKvStore(undefined, { throwOnPut: true });
const d1PutErr = mockD1(99996);
const resPutErr = await onRequest({
  request: mockRequest("https://rlibook.tech/api/stats"),
  env: { ASSETS: mockAssets(FILE_FOR_PATH), RLIBOOK_KV: kvPutErr.kv, TG_D1: d1PutErr.db },
});
const bodyPutErr = await resPutErr.json();
check("6i KV put throws -> live count still returned, still 200",
  resPutErr.status === 200 && bodyPutErr.books_d1.count === 99996,
  "HTTP " + resPutErr.status + " count=" + bodyPutErr.books_d1.count);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
