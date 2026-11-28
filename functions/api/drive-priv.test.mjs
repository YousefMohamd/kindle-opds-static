// Tests for the make-private endpoint (functions/api/drive-priv.js),
// Drive UX redesign. Standalone Node script — run from the repo root:
//   node functions/api/drive-priv.test.mjs
// No network, no production KV/D1, no deploy. Exit 0 = all pass.
//
// Mirrors drive-pubreq.test.mjs exactly (same auth, same response
// shape, same mock D1/KV): only the target visibility and the
// allowed source states differ. The mock D1 answers the registry
// SELECT by folder id and records UPDATEs; the mock KV answers
// fp: lookups for the submitter (111), the owner (999) and a
// stranger (222).

import { onRequest } from "./drive-priv.js";

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

const BOT_KEY = "test-bot-key";
const SUB_FP = "SubFpSubFpSubFpSubFp12";
const OWNER_FP = "OwnFpOwnFpOwnFpOwnFp12";
const STRANGER_FP = "StrFpStrFpStrFpStrFp12";
const PUB = "PUBFOLDER12345678901";
const PEND = "PENDFOLDER12345678901";
const PRIV = "PRIVFOLDER1234567890";
const REMOVED = "REMOVEDFOLDER12345678";
const UNAVAIL = "UNAVAILFOLDER123456789";
const WEIRD = "WEIRDFOLDER1234567890";

const kv = {
  get: async (k) => {
    if (k === "fp:" + SUB_FP) return JSON.stringify({ tg_id: 111 });
    if (k === "fp:" + OWNER_FP) return JSON.stringify({ tg_id: 999 });
    if (k === "fp:" + STRANGER_FP) return JSON.stringify({ tg_id: 222 });
    return null;
  },
};

function makeD1({ updateChanges = 1, rereadVisibility = null } = {}) {
  const updates = [];
  const rows = {
    [PUB]: { folder_id: PUB, visibility: "public", submitter_tg_id: 111 },
    [PEND]: { folder_id: PEND, visibility: "pending_public", submitter_tg_id: 111 },
    [PRIV]: { folder_id: PRIV, visibility: "private", submitter_tg_id: 111 },
    [REMOVED]: { folder_id: REMOVED, visibility: "removed", submitter_tg_id: 111 },
    [UNAVAIL]: { folder_id: UNAVAIL, visibility: "unavailable", submitter_tg_id: 111 },
    [WEIRD]: { folder_id: WEIRD, visibility: "archived", submitter_tg_id: 111 },
  };
  return {
    updates,
    db: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => {
            if (sql.startsWith("SELECT folder_id, visibility")) return rows[args[0]] || null;
            if (sql.startsWith("SELECT visibility")) {
              return rereadVisibility ? { visibility: rereadVisibility } : null;
            }
            return null;
          },
          run: async () => {
            updates.push({ sql, args });
            return { meta: { changes: updateChanges } };
          },
          all: async () => ({ results: [] }),
        }),
      }),
    },
  };
}

function env(d1, extra = {}) {
  return {
    TG_D1: d1 ? d1.db : null,
    RLIBOOK_KV: kv,
    TG_SEARCH_BOT_KEY: BOT_KEY,
    RLIBOOK_OWNER_ID: "999",
    ...extra,
  };
}

async function post(envObj, body, headers = {}) {
  const res = await onRequest({
    request: new Request("https://rlibook.tech/api/drive-priv", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env: envObj,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 1. Happy path: public library -> private, one guarded UPDATE.
{
  const d1 = makeD1();
  const r = await post(env(d1), { folder_id: PUB, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("1 public -> applied", r.status === 200 && r.body.ok === true && r.body.applied === true,
    `status=${r.status} body=${JSON.stringify(r.body)}`);
  check("1 exactly one UPDATE, guarded to public/pending_public",
    d1.updates.length === 1 && d1.updates[0].sql.includes("visibility IN ('public', 'pending_public')"));
  check("1 UPDATE sets visibility = 'private'",
    d1.updates[0].sql.includes("SET visibility = 'private'"));
  check("1 UPDATE binds the folder", d1.updates[0].args.includes(PUB));
}

// 1b. Pending_public library -> private (the other allowed state).
{
  const d1 = makeD1();
  const r = await post(env(d1), { folder_id: PEND, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("1b pending_public -> applied", r.status === 200 && r.body.ok === true && r.body.applied === true,
    `status=${r.status} body=${JSON.stringify(r.body)}`);
  check("1b exactly one UPDATE", d1.updates.length === 1);
}

// 2. Auth: wrong key / missing key / missing server secret -> fail closed.
{
  const d1 = makeD1();
  const wrong = await post(env(d1), { folder_id: PUB, fp: SUB_FP }, { "x-rlibook-bot-key": "nope" });
  check("2 wrong bot key -> 401", wrong.status === 401, `status=${wrong.status}`);
  const missing = await post(env(d1), { folder_id: PUB, fp: SUB_FP });
  check("2 missing bot key -> 401", missing.status === 401, `status=${missing.status}`);
  const unconfigured = await post(env(d1, { TG_SEARCH_BOT_KEY: "" }), { folder_id: PUB, fp: SUB_FP },
    { "x-rlibook-bot-key": BOT_KEY });
  check("2 server secret unset -> 503 (never open)", unconfigured.status === 503, `status=${unconfigured.status}`);
  check("2 no UPDATE on any auth failure", d1.updates.length === 0);
}

// 3. Fingerprint + input validation.
{
  const d1 = makeD1();
  const unknown = await post(env(d1), { folder_id: PUB, fp: "zzzzzzzzzzzzzzzzzzzzzz" },
    { "x-rlibook-bot-key": BOT_KEY });
  check("3 unknown fp -> 401", unknown.status === 401, `status=${unknown.status}`);
  const badFolder = await post(env(d1), { folder_id: "x", fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("3 bad folder_id -> 400", badFolder.status === 400, `status=${badFolder.status}`);
  check("3 no UPDATE on validation failure", d1.updates.length === 0);
  const get = await onRequest({
    request: new Request("https://rlibook.tech/api/drive-priv", { method: "GET" }),
    env: env(d1),
  });
  check("3 GET -> 405", get.status === 405, `status=${get.status}`);
}

// 4. Ownership: a stranger may not demote someone else's library;
//    the owner may (their own submission or on another's behalf).
{
  const d1 = makeD1();
  const stranger = await post(env(d1), { folder_id: PUB, fp: STRANGER_FP },
    { "x-rlibook-bot-key": BOT_KEY });
  check("4 stranger -> 403", stranger.status === 403, `status=${stranger.status}`);
  check("4 stranger triggers no UPDATE", d1.updates.length === 0);
  const owner = await post(env(d1), { folder_id: PUB, fp: OWNER_FP },
    { "x-rlibook-bot-key": BOT_KEY });
  check("4 owner -> applied", owner.status === 200 && owner.body.applied === true,
    `status=${owner.status}`);
}

// 5. States: not indexed / already private / removed / unavailable / weird.
{
  const d1 = makeD1();
  const missing = await post(env(d1), { folder_id: "N0TF0UND123456789012", fp: SUB_FP },
    { "x-rlibook-bot-key": BOT_KEY });
  check("5 not indexed -> applied:false + not_indexed",
    missing.status === 200 && missing.body.applied === false && missing.body.reason === "not_indexed",
    JSON.stringify(missing.body));
  const priv = await post(env(d1), { folder_id: PRIV, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("5 already private -> applied:true + already:true (idempotent)",
    priv.body.applied === true && priv.body.already === true, JSON.stringify(priv.body));
  const removed = await post(env(d1), { folder_id: REMOVED, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("5 removed -> applied:false + unexpected_visibility",
    removed.body.applied === false && removed.body.reason === "unexpected_visibility",
    JSON.stringify(removed.body));
  const unavail = await post(env(d1), { folder_id: UNAVAIL, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("5 unavailable -> applied:false + unexpected_visibility",
    unavail.body.applied === false && unavail.body.reason === "unexpected_visibility",
    JSON.stringify(unavail.body));
  const weird = await post(env(d1), { folder_id: WEIRD, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("5 unexpected visibility -> applied:false, no UPDATE",
    weird.body.applied === false && weird.body.reason === "unexpected_visibility",
    JSON.stringify(weird.body));
  check("5 no UPDATE for any refused state",
    d1.updates.length === 0, `updates=${d1.updates.length}`);
}

// 6. No D1 binding -> 503, never an open door.
{
  const r = await post(env(null), { folder_id: PUB, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("6 no TG_D1 -> 503", r.status === 503, `status=${r.status}`);
}

// 7. Lost UPDATE race: 0 rows changed + re-read says private ->
//    already (not a silent success, not a 500).
{
  const d1 = makeD1({ updateChanges: 0, rereadVisibility: "private" });
  const r = await post(env(d1), { folder_id: PUB, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("7 raced demote -> applied:true + already:true",
    r.status === 200 && r.body.applied === true && r.body.already === true,
    `status=${r.status} body=${JSON.stringify(r.body)}`);
}

// 7b. Lost UPDATE race, re-read says removed -> 409 concurrent update
//     (the library was removed between the SELECT and the UPDATE;
//     the demotion must not silently claim success).
{
  const d1 = makeD1({ updateChanges: 0, rereadVisibility: "removed" });
  const r = await post(env(d1), { folder_id: PUB, fp: SUB_FP }, { "x-rlibook-bot-key": BOT_KEY });
  check("7b raced remove -> 409", r.status === 409, `status=${r.status} body=${JSON.stringify(r.body)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
