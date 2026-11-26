// Tests for the personal OPDS feed catch-all (functions/opds/[[fp]].js),
// Area 2 review: the exact-route guards.
// Standalone Node script — run from the repo root:
//   node functions/opds/fp.test.mjs
//
// The catch-all must NEVER swallow an exact route: /opds/search and
// /opds/qurans belong to their own Function files (specific routes
// precede catch-alls in Cloudflare Pages routing). If one ever lands
// here the router misbehaved, and the answer is 404 — never a
// fingerprint nav feed for "qurans" (which would show a misleading
// "catalog link is not valid" notice for the Qurans feed).
// Also pins: an unknown fingerprint still serves the public catalog
// (with the not-valid notice, no private books), and a valid one
// shows its private section.
// No network, no production KV, no deploy. Exit 0 = all pass.

import { onRequest } from "./[[fp]].js";

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

const VALID_FP = "AbCdEfGhIjKlMnOpQrStUv"; // 22 chars, base64url shape
const kvEmpty = { get: async () => null };
const kvValid = {
  get: async (k) => {
    if (k === "fp:" + VALID_FP) return JSON.stringify({ tg_id: 7283934644 });
    if (k === "priv:7283934644") return JSON.stringify([
      { title: "My Private Book", author: "Me", source: "my drive", added_at: "2026-11-14T00:00:00Z", drive_id: "1MPnTH-P5PD3KCwkQd8Swayi2my_RD1Uq" },
    ]);
    return null;
  },
};

async function call(env, segs, method = "GET") {
  const res = await onRequest({
    request: new Request("https://rlibook.tech/opds/" + segs.join("/"), { method }),
    env,
    params: { fp: segs },
  });
  return { status: res.status, body: await res.text() };
}

// 1. Exact-route guards: never treat "search" or "qurans" as a fingerprint.
{
  const r1 = await call({}, ["search"]);
  check("1 /opds/search landing here -> 404", r1.status === 404, `status=${r1.status}`);
  const r2 = await call({}, ["qurans"]);
  check("1 /opds/qurans landing here -> 404 (not a nav feed)",
    r2.status === 404, `status=${r2.status}`);
  check("1 /opds/qurans landing here -> no misleading 'not valid' notice",
    !r2.body.includes("not valid") && !r2.body.includes("مش صحيح"));
  const r3 = await call({}, ["qurans", "extra"]);
  check("1 /opds/qurans/extra -> 404", r3.status === 404, `status=${r3.status}`);
}

// 2. Unknown fingerprint: public catalog only, with the not-valid notice.
{
  const r = await call({ RLIBOOK_KV: kvEmpty }, ["zzzzzzzzzzzzzzzzzzzzzz"]);
  check("2 unknown fp: 200", r.status === 200, `status=${r.status}`);
  check("2 unknown fp: public libraries listed",
    r.body.includes("khazendar") && r.body.includes("DOAB"));
  check("2 unknown fp: not-valid notice shown",
    r.body.includes("not valid") || r.body.includes("مش صحيح"));
  check("2 unknown fp: NO private section",
    !r.body.includes("My Private Books / كتبي الخاصة</title>")
    && !r.body.includes("/private\""));
}

// 3. Valid fingerprint: private section appears, private books listed.
{
  const r = await call({ RLIBOOK_KV: kvValid }, [VALID_FP]);
  check("3 valid fp: 200", r.status === 200, `status=${r.status}`);
  check("3 valid fp: no not-valid notice", !r.body.includes("not valid"));
  check("3 valid fp: private section listed",
    r.body.includes("/opds/" + VALID_FP + "/private"));
  const priv = await call({ RLIBOOK_KV: kvValid }, [VALID_FP, "private"]);
  check("3 valid fp: /private lists the book",
    priv.status === 200 && priv.body.includes("My Private Book"),
    `status=${priv.status}`);
}

// 4. Method + shape guards.
{
  const r = await call({}, [VALID_FP], "POST");
  check("4 POST -> 405", r.status === 405, `status=${r.status}`);
  const empty = await call({}, []);
  check("4 bare /opds/ -> 404", empty.status === 404, `status=${empty.status}`);
  const deep = await call({}, [VALID_FP, "search", "extra"]);
  check("4 too-deep path -> 404", deep.status === 404, `status=${deep.status}`);
}

// 5. WAVE 7, C-bot — private Drive books from D1 (TG_D1).
// Mock D1: registry SELECT keyed by submitter, books SELECT by
// source (LIKE filter emulated for the search route). Records calls
// so the fail-closed tests can assert D1 was never touched.
const DRIVE_FOLDER = "PRIVFOLDER1234567890";
const DRIVE_FILE = "DRIVEFILEID1234567890";
const DRIVE_BOOK = {
  title: "نزهة الزمان",
  author: "مؤلف مجهول",
  ext: "pdf",
  url: "https://drive.google.com/file/d/" + DRIVE_FILE + "/view",
};
function makeD1({ throwOn = false } = {}) {
  const calls = [];
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({
        all: async () => {
          calls.push({ sql, args });
          if (throwOn) throw new Error("d1 down");
          if (sql.includes("FROM drive_libraries")) {
            return args[0] === 7283934644
              ? { results: [{ folder_id: DRIVE_FOLDER, title: "مكتبة خاصة" }] }
              : { results: [] };
          }
          if (sql.includes("FROM books")) {
            let rows = args[0] === "drive:" + DRIVE_FOLDER ? [DRIVE_BOOK] : [];
            if (sql.includes("LIKE")) {
              const pat = String(args[1]).replace(/^%|%$/g, "").toLowerCase();
              rows = rows.filter((b) =>
                ((b.title || "") + " " + (b.author || "")).toLowerCase().includes(pat));
            }
            return { results: rows.slice(0, args[args.length - 1]) };
          }
          return { results: [] };
        },
        first: async () => null,
      }),
    }),
  };
  return { db, calls };
}
const envD1 = (d1) => ({ RLIBOOK_KV: kvValid, TG_D1: d1.db });
// Public search fetches the static search-index.json files — stub
// the global fetch so the /search tests never touch the network.
globalThis.fetch = async () => ({ ok: true, json: async () => [] });

{
  // 5a. Valid fp + D1: /private merges the Drive book (acquisition
  // link from the file id, PDF mime from ext); root counts both.
  const d1 = makeD1();
  const priv = await call(envD1(d1), [VALID_FP, "private"]);
  check("5a /private lists the Drive book",
    priv.status === 200 && priv.body.includes("نزهة الزمان"), `status=${priv.status}`);
  check("5a Drive book has a uc acquisition link",
    priv.body.includes("drive.google.com/uc?id=" + DRIVE_FILE));
  check("5a Drive book mime follows ext (pdf)",
    priv.body.includes("application/pdf"));
  check("5a /private still lists the KV book too",
    priv.body.includes("My Private Book"));
  const root = await call(envD1(d1), [VALID_FP]);
  check("5a root counts KV + Drive books (2)",
    root.body.includes("2 books"), root.body.slice(0, 400));
  check("5a D1 was queried (registry + books)",
    d1.calls.some((c) => c.sql.includes("FROM drive_libraries")) &&
    d1.calls.some((c) => c.sql.includes("FROM books")));
}

{
  // 5b. Unknown fp: D1 is never touched, no Drive book leaks.
  const d1 = makeD1();
  const priv = await call({ RLIBOOK_KV: kvEmpty, TG_D1: d1.db }, ["zzzzzzzzzzzzzzzzzzzzzz", "private"]);
  check("5b unknown fp: /private has no Drive book",
    priv.status === 200 && !priv.body.includes("نزهة الزمان"));
  check("5b unknown fp: D1 never queried", d1.calls.length === 0, `calls=${d1.calls.length}`);
  const s = await call({ RLIBOOK_KV: kvEmpty, TG_D1: d1.db }, ["zzzzzzzzzzzzzzzzzzzzzz", "search"]);
  check("5b unknown fp: search route serves (public only)", s.status === 200, `status=${s.status}`);
  check("5b unknown fp: search never queried D1", d1.calls.length === 0, `calls=${d1.calls.length}`);
}

{
  // 5c. No TG_D1 binding: KV books still served, no crash.
  const priv = await call({ RLIBOOK_KV: kvValid }, [VALID_FP, "private"]);
  check("5c no D1: /private still lists the KV book",
    priv.status === 200 && priv.body.includes("My Private Book"));
  check("5c no D1: no Drive book", !priv.body.includes("نزهة الزمان"));
}

{
  // 5d. D1 throws: KV books still served (fail closed, no crash).
  const d1 = makeD1({ throwOn: true });
  const priv = await call(envD1(d1), [VALID_FP, "private"]);
  check("5d D1 down: /private still lists the KV book",
    priv.status === 200 && priv.body.includes("My Private Book"));
  check("5d D1 down: no Drive book", !priv.body.includes("نزهة الزمان"));
}

{
  // 5e. Search: a matching Drive book is prepended for the owner.
  const d1 = makeD1();
  // (empty q returns the empty feed — drive search needs a query;
  // call through onRequest with ?q= directly)
  const res = await onRequest({
    request: new Request("https://rlibook.tech/opds/" + VALID_FP + "/search?q=" + encodeURIComponent("نزهة")),
    env: envD1(d1),
    params: { fp: [VALID_FP, "search"] },
  });
  const body = await res.text();
  check("5e search: matching Drive book appears",
    res.status === 200 && body.includes("نزهة الزمان"), `status=${res.status}`);
  check("5e search: Drive match carries its uc link",
    body.includes("drive.google.com/uc?id=" + DRIVE_FILE));
  const resMiss = await onRequest({
    request: new Request("https://rlibook.tech/opds/" + VALID_FP + "/search?q=" + encodeURIComponent("zzzqqq")),
    env: envD1(d1),
    params: { fp: [VALID_FP, "search"] },
  });
  const bodyMiss = await resMiss.text();
  check("5e search: non-matching query has no Drive book",
    !bodyMiss.includes("نزهة الزمان"));
}

{
  // 5f. Another user's fingerprint sees none of this library.
  const OTHER_FP = "ZzZzZzZzZzZzZzZzZzZzZz";
  const kvOther = {
    get: async (k) => {
      if (k === "fp:" + OTHER_FP) return JSON.stringify({ tg_id: 555 });
      return null;
    },
  };
  const d1 = makeD1();
  const priv = await call({ RLIBOOK_KV: kvOther, TG_D1: d1.db }, [OTHER_FP, "private"]);
  check("5f other user: /private has no Drive book",
    priv.status === 200 && !priv.body.includes("نزهة الزمان"));
}

{
  // 5g. Dedupe: a Drive row whose file id is already a KV private
  // book lists once (the KV entry wins, the Drive title drops).
  const kvDup = {
    get: async (k) => {
      if (k === "fp:" + VALID_FP) return JSON.stringify({ tg_id: 7283934644 });
      if (k === "priv:7283934644") return JSON.stringify([
        { title: "My Private Book", author: "Me", source: "my drive", added_at: "2026-11-14T00:00:00Z", drive_id: DRIVE_FILE },
      ]);
      return null;
    },
  };
  const d1 = makeD1();
  const priv = await call({ RLIBOOK_KV: kvDup, TG_D1: d1.db }, [VALID_FP, "private"]);
  check("5g dedupe: KV book listed once",
    (priv.body.split("<title>My Private Book</title>").length - 1) === 1);
  check("5g dedupe: Drive duplicate title dropped",
    !priv.body.includes("نزهة الزمان"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
