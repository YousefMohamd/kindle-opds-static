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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
