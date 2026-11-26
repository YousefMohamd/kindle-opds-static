// Test for the reader-token issuer (functions/api/read-token.js).
// Standalone Node script — run from the repo root:
//   node functions/api/read-token.test.mjs
//
// It imports the real Function module and calls onRequest() over
// HTTP semantics. It asserts:
//   1. an OPDS book mints a token whose url is a /read link carrying
//      that token, with ttl 3600, and the token verifies for the
//      book (via verifyReaderToken) but not for another book;
//   2. a Telegram book mints the same shape;
//   3. a flagged Telegram book -> 403, no token;
//   4. a bad book identity -> 400; no signing key -> 503;
//      POST -> 405.
//   5. personal books + renewal (2026-11-16): fp+t proves own
//      (flag gate skipped, hide still wins); rtok renews a token
//      for the same book — an own token renews as own, a library
//      token goes through the flag/hide gates again.
//   6. Drive flag denylist (WAVE 7 follow-up A2): a KV
//      `flag:drive:<fileId>` key refuses the reader mint for
//      lib=drive AND khazendar / sahwa / electronic (same file,
//      same key); unflagged drive-kind books mint normally; a
//      library rtok renewal after flagging is refused; Hindawi /
//      DOAB are never flagged.
//   7. Drive visibility gate (WAVE 7 follow-up A4): a private
//      Drive book gets a reader token only for its submitter
//      (pending: + the owner) — 403 "private_library", no token;
//      public / legacy (no registry row) / unindexed / no-D1 mint
//      unchanged (fail open, D's helper semantics).
// Exit 0 = all pass; non-zero = failure. No network, no production
// KV, no deploy. The signing key below is FAKE test data.

import { onRequest } from "./read-token.js";
import { verifyReaderToken, readerTokenOwn, makeReaderToken, READER_TOKEN_TTL_SECONDS, driveFileUrl } from "./dl-token.js";

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

function makeKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      if (type === "json") {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
  };
}

const KEY = "test_signing_key_0123456789abcdef";

async function call(params, env, method = "GET") {
  const url = "https://rlibook.tech/api/read-token?" + new URLSearchParams(params).toString();
  const res = await onRequest({
    request: new Request(url, { method }),
    env,
  });
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; }
  return { status: res.status, body };
}

const ENV = { RLIBOOK_KV: makeKv(), PROXY_SIGNING_KEY: KEY };

console.log("1. OPDS mint:");
{
  const r = await call({ lib: "hindawi", id: "13028368", f: "epub" }, ENV);
  check("1a 200, ok, ttl 3600",
    r.status === 200 && r.body && r.body.ok === true && r.body.ttl === 3600,
    "status " + r.status + " " + JSON.stringify(r.body));
  check("1b url is a /read link carrying the token",
    typeof r.body.url === "string"
    && r.body.url.startsWith("/read?lib=hindawi&id=13028368&f=epub&rtok=v1.")
    && r.body.url.includes(encodeURIComponent(r.body.token).slice(0, 12)),
    r.body.url);
  check("1c the minted token verifies for this book",
    await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "hindawi", id: "13028368", fmt: "epub" }));
  check("1d the minted token does NOT verify for another book",
    !(await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "hindawi", id: "99999999", fmt: "epub" })));
  check("1e exp is about now + 3600",
    Math.abs(r.body.exp - (Math.floor(Date.now() / 1000) + 3600)) <= 5,
    "exp " + r.body.exp);
}

console.log("1-drive. Drive mint (WAVE 7, wave-7 child A):");
{
  const r = await call({ lib: "drive", id: "DRIVEPUBFILEID001", f: "epub" }, ENV);
  check("1-drive-a 200, ok, ttl 3600",
    r.status === 200 && r.body && r.body.ok === true && r.body.ttl === 3600,
    "status " + r.status + " " + JSON.stringify(r.body));
  check("1-drive-b url is a /read link for lib=drive carrying the token",
    typeof r.body.url === "string"
    && r.body.url.startsWith("/read?lib=drive&id=DRIVEPUBFILEID001&f=epub&rtok=v1."),
    r.body.url);
  check("1-drive-c the minted token verifies for this Drive book",
    await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "drive", id: "DRIVEPUBFILEID001", fmt: "epub" }));
  check("1-drive-d the minted token does NOT verify for another Drive file",
    !(await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "drive", id: "DRIVEPRIVFILEID01", fmt: "epub" })));
  const bad = await call({ lib: "drive", id: "short", f: "epub" }, ENV);
  check("1-drive-e bad drive id -> 400 bad_id",
    bad.status === 400 && bad.body && bad.body.error === "bad_id",
    "status " + bad.status);
}

console.log("2. Telegram mint:");
{
  const r = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "pdf" }, ENV);
  check("2a 200, url carries lib=tg + h + p + f=pdf + rtok",
    r.status === 200 && r.body && r.body.ok === true
    && typeof r.body.url === "string"
    && r.body.url.startsWith("/read?lib=tg&h=kotobkhana&p=7559&f=pdf&rtok=v1."),
    "status " + r.status + " " + JSON.stringify(r.body && r.body.url));
  check("2b the minted token verifies for this Telegram book",
    await verifyReaderToken(KEY, r.body.token,
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "pdf" }));
}

console.log("3. Refusals:");
{
  const kv = makeKv({ "flag:kotobkhana:7559": "1" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const flagged = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, env);
  check("3a flagged Telegram book -> 403, no token",
    flagged.status === 403 && flagged.body && flagged.body.error === "flagged",
    "status " + flagged.status);
  // Owner-hide (Workstream 2b): no reader token either; flag first
  // when both keys are present.
  const kvHidden = makeKv({ "hidden:kotobkhana:7559": "owner" });
  const envHidden = { RLIBOOK_KV: kvHidden, PROXY_SIGNING_KEY: KEY };
  const hidden = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, envHidden);
  check("3f hidden Telegram book -> 403 hidden, no token",
    hidden.status === 403 && hidden.body && hidden.body.error === "hidden",
    "status " + hidden.status);
  const kvBoth = makeKv({ "flag:kotobkhana:7559": "1", "hidden:kotobkhana:7559": "owner" });
  const envBoth = { RLIBOOK_KV: kvBoth, PROXY_SIGNING_KEY: KEY };
  const both = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub" }, envBoth);
  check("3g flagged + hidden -> 403 flagged (flag gate first)",
    both.status === 403 && both.body && both.body.error === "flagged",
    "status " + both.status);
  const bad = await call({ lib: "nope", id: "1234567890", f: "epub" }, ENV);
  check("3b bad lib -> 400", bad.status === 400 && bad.body && bad.body.error === "bad_lib",
    "status " + bad.status);
  const noKey = await call({ lib: "hindawi", id: "13028368", f: "epub" },
    { RLIBOOK_KV: makeKv() });
  check("3c signing key unset -> 503 not_configured",
    noKey.status === 503 && noKey.body && noKey.body.error === "not_configured",
    "status " + noKey.status);
  const post = await call({ lib: "hindawi", id: "13028368", f: "epub" }, ENV, "POST");
  check("3d POST -> 405", post.status === 405, "status " + post.status);
  const noKv = await call({ lib: "hindawi", id: "13028368", f: "epub" },
    { PROXY_SIGNING_KEY: KEY });
  check("3e no KV binding -> still mints (flag check passes open)",
    noKv.status === 200 && noKv.body && noKv.body.ok === true,
    "status " + noKv.status);
}

// ================= 4. Drive flag denylist (WAVE 7 follow-up A2) ===
// The reader mint shared the download mint's hole: a flagged Drive
// book got a reader token while the website showed it with no
// reader link. Same `flag:drive:<fileId>` key, same 403, covering
// all drive-kind libs (the flag is on the file, not the library).
console.log("4. Drive flag denylist:");
{
  const kv = makeKv({ "flag:drive:DRIVEFLAGFILE01": "1" });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const flagged = await call({ lib: "drive", id: "DRIVEFLAGFILE01", f: "epub" }, env);
  check("4a flagged Drive file -> 403 flagged, no token",
    flagged.status === 403 && flagged.body && flagged.body.error === "flagged" && !flagged.body.token,
    "status " + flagged.status + " " + JSON.stringify(flagged.body));
  const ok = await call({ lib: "drive", id: "DRIVEOKFILE0009", f: "epub" }, env);
  check("4b unflagged Drive file -> 200, token + /read url",
    ok.status === 200 && ok.body && ok.body.ok === true && !!ok.body.token
    && typeof ok.body.url === "string" && ok.body.url.startsWith("/read?lib=drive&id=DRIVEOKFILE0009"),
    "status " + ok.status);
  for (const lib of ["khazendar", "sahwa", "electronic"]) {
    const rr = await call({ lib, id: "DRIVEFLAGFILE01", f: "epub" }, env);
    check(`4c flagged file via lib=${lib} -> 403 flagged (same key, same file)`,
      rr.status === 403 && rr.body && rr.body.error === "flagged", "status " + rr.status);
  }
  // Hindawi / DOAB are never flagged: a flag:drive key whose id
  // happens to equal a Hindawi numeric id must not refuse it.
  const kvH = makeKv({ "flag:drive:13028368": "1" });
  const envH = { RLIBOOK_KV: kvH, PROXY_SIGNING_KEY: KEY };
  const hind = await call({ lib: "hindawi", id: "13028368", f: "epub" }, envH);
  check("4d Hindawi book mints despite a flag:drive key for the same id (kind isolation)",
    hind.status === 200 && hind.body && hind.body.ok === true, "status " + hind.status);
}
{
  // Renewal after flagging: mint a library reader token for a
  // Drive book, then flag the file — the same rtok must not renew.
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const first = await call({ lib: "drive", id: "DRIVEOKFILE0011", f: "epub" }, env);
  check("4e setup: library reader token mints for an unflagged Drive file",
    first.status === 200 && first.body && first.body.token, "status " + first.status);
  kv.map.set("flag:drive:DRIVEOKFILE0011", "1");
  const afterFlag = await call({ lib: "drive", id: "DRIVEOKFILE0011", f: "epub",
    rtok: first.body.token }, env);
  check("4e library rtok renewal after flagging -> 403 flagged",
    afterFlag.status === 403 && afterFlag.body && afterFlag.body.error === "flagged",
    "status " + afterFlag.status);
}

// ================= 5. Personal books + renewal ======================
console.log("5. Personal books + renewal:");
{
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const own = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "My Book" }, env);
  check("5a own via fp+t on a flagged book -> 200",
    own.status === 200 && own.body && own.body.ok === true, "status " + own.status);
  check("5a2 the minted token is own (readerTokenOwn -> true)",
    own.body && own.body.token && (await readerTokenOwn(KEY, own.body.token)) === true);
  const wrong = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "Not Mine" }, env);
  check("5c fp + wrong title on a flagged book -> 403 flagged",
    wrong.status === 403 && wrong.body && wrong.body.error === "flagged",
    "status " + wrong.status);
}
{
  const kv = makeKv({
    "hidden:kotobkhana:7559": "owner",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const hidden = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "My Book" }, env);
  check("5b own via fp+t on a HIDDEN book -> 403 hidden (hide wins)",
    hidden.status === 403 && hidden.body && hidden.body.error === "hidden",
    "status " + hidden.status);
}
{
  // Renewal: mint a library token that is nearly expired (3500 s
  // old, 100 s left), then renew it with rtok — the renewed token
  // must be a FRESH one (different string, full hour ahead).
  const kv = makeKv();
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const now = Math.floor(Date.now() / 1000);
  const oldTok = await makeReaderToken(KEY, "kotobkhana", 7559, "epub",
    READER_TOKEN_TTL_SECONDS, now - 3500);
  check("5d setup: nearly-expired library token still verifies",
    (await verifyReaderToken(KEY, oldTok,
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" })) === true);
  const renewed = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: oldTok }, env);
  check("5d rtok renewal (library, unflagged) -> 200 with a fresh token",
    renewed.status === 200 && renewed.body && renewed.body.ok === true
    && renewed.body.token && renewed.body.token !== oldTok,
    "status " + renewed.status);
  check("5d2 renewed token verifies for the book",
    renewed.body && (await verifyReaderToken(KEY, renewed.body.token,
      { kind: "tg", handle: "kotobkhana", postId: 7559, fmt: "epub" })) === true);
  check("5d3 renewed library token is NOT own",
    renewed.body && (await readerTokenOwn(KEY, renewed.body.token)) === false);
  // Now flag the book: the same library rtok must not renew.
  kv.map.set("flag:kotobkhana:7559", "1");
  const afterFlag = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: oldTok }, env);
  check("5f library rtok renewal after flagging -> 403 flagged",
    afterFlag.status === 403 && afterFlag.body && afterFlag.body.error === "flagged",
    "status " + afterFlag.status);
}
{
  // Own renewal: mint an own token on a flagged book, then renew
  // it with rtok — the flag re-check is skipped for own tokens.
  const kv = makeKv({
    "flag:kotobkhana:7559": "1",
    "fp:abc123": JSON.stringify({ tg_id: 777 }),
    "priv:777": JSON.stringify([{ title: "My Book", source: "upload", added_at: "2026-11-01" }]),
  });
  const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
  const first = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    fp: "abc123", t: "My Book" }, env);
  check("5e setup: own token mints on a flagged book",
    first.status === 200 && first.body && first.body.token, "status " + first.status);
  const renewed = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: first.body.token }, env);
  check("5e own rtok renewal on a flagged book -> 200 (no flag re-check)",
    renewed.status === 200 && renewed.body && renewed.body.ok === true,
    "status " + renewed.status);
  check("5e2 renewed token is still own",
    renewed.body && (await readerTokenOwn(KEY, renewed.body.token)) === true);
  // An rtok minted for ANOTHER book does not renew this one — the
  // gates apply to the requested book as normal.
  const other = await call({ lib: "tg", h: "otherlib", p: "1", f: "epub" }, env);
  const cross = await call({ lib: "tg", h: "kotobkhana", p: "7559", f: "epub",
    rtok: other.body.token }, env);
  check("5g rtok from another book does not bypass the flag gate -> 403",
    cross.status === 403 && cross.body && cross.body.error === "flagged",
    "status " + cross.status);
}

// ================= 7. Drive visibility gate (mint side) =============
// Mock D1: books {url: source}, registry {folderId: {visibility,
// submitter_tg_id}}. Same shape as send-to-kindle.test.mjs §48 and
// dl-token.test.mjs §12.
function makeDb({ books = {}, registry = {}, throwOn = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (throwOn) throw new Error("d1 down");
              if (String(sql).includes("FROM books")) {
                const source = books[args[0]];
                return source ? { source } : null;
              }
              if (String(sql).includes("FROM drive_libraries")) {
                return registry[args[0]] || null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

const PRIV_FOLDER = "PRIVFOLDER1234567890";
const PRIV_FILE = "1PRIVFILE1234567890AB";
const PRIV_URL = driveFileUrl(PRIV_FILE);
// Fingerprints are 22 chars (drive-libraries.js FP_RE).
const SUB_FP = "SUBMITTERFP00000000001";
const OTHER_FP = "OTHERUSERFP00000000002";
const OWNER_FP = "OWNERUSERFP00000000003";
const SUB_ID = 777001;
const OTHER_ID = 888002;
const OWNER_ID = 111222333;

function privDb(visibility = "private", submitter = SUB_ID) {
  return makeDb({
    books: { [PRIV_URL]: "drive:" + PRIV_FOLDER },
    registry: { [PRIV_FOLDER]: { visibility, submitter_tg_id: submitter } },
  });
}

function privKv(fp, tgId) {
  return makeKv({ ["fp:" + fp]: JSON.stringify({ tg_id: tgId }) });
}

console.log("7. Drive visibility gate (reader mint):");
{
  async function mintRead({ db, kv, fp, ownerId, lib = "drive", id = PRIV_FILE } = {}) {
    const env = { RLIBOOK_KV: kv, PROXY_SIGNING_KEY: KEY };
    if (db !== undefined) env.TG_D1 = db;
    if (ownerId !== undefined) env.RLIBOOK_OWNER_ID = String(ownerId);
    const params = { lib, id, f: "epub" };
    if (fp !== undefined) params.fp = fp;
    return call(params, env);
  }

  let r = await mintRead({ db: privDb(), kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP });
  check("7a private + non-submitter fp -> 403 private_library, no token",
    r.status === 403 && r.body && r.body.error === "private_library" && !r.body.token,
    "status " + r.status + " " + JSON.stringify(r.body));
  r = await mintRead({ db: privDb(), kv: privKv(SUB_FP, SUB_ID) });
  check("7b private + no fp (anonymous) -> 403 private_library",
    r.status === 403 && r.body && r.body.error === "private_library",
    "status " + r.status);
  r = await mintRead({ db: privDb(), kv: privKv(SUB_FP, SUB_ID), fp: SUB_FP });
  check("7c private + submitter fp -> 200, token verifies for the book",
    r.status === 200 && r.body && r.body.ok === true
    && r.body.token && (await verifyReaderToken(KEY, r.body.token,
      { kind: "opds", lib: "drive", id: PRIV_FILE, fmt: "epub" })) === true,
    "status " + r.status);
  r = await mintRead({ db: privDb(), kv: privKv(OWNER_FP, OWNER_ID), fp: OWNER_FP, ownerId: OWNER_ID });
  check("7d private + owner (not submitter) -> 403 private_library (submitter-only, D's rule)",
    r.status === 403 && r.body && r.body.error === "private_library",
    "status " + r.status);
  r = await mintRead({ db: privDb("pending_public"), kv: privKv(OWNER_FP, OWNER_ID), fp: OWNER_FP, ownerId: OWNER_ID });
  check("7e pending_public + owner -> 200 mints",
    r.status === 200 && r.body && r.body.ok === true, "status " + r.status);
  r = await mintRead({ db: privDb("pending_public"), kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP, ownerId: OWNER_ID });
  check("7e pending_public + other -> 403 private_library",
    r.status === 403 && r.body && r.body.error === "private_library",
    "status " + r.status);
  r = await mintRead({ db: privDb("public"), kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP });
  check("7f public + other user -> 200 mints",
    r.status === 200 && r.body && r.body.ok === true, "status " + r.status);
  r = await mintRead({ db: makeDb({ books: { [PRIV_URL]: "drive:" + PRIV_FOLDER }, registry: {} }),
    kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP });
  check("7g legacy (no registry row) + other user -> 200 mints",
    r.status === 200 && r.body && r.body.ok === true, "status " + r.status);
  r = await mintRead({ db: privDb(), kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP, id: "1NOTINDEXED123456789" });
  check("7h unindexed file id + other user -> 200 (fail open, D's rule)",
    r.status === 200 && r.body && r.body.ok === true, "status " + r.status);
  r = await mintRead({ kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP });
  check("7i no TG_D1 binding + other user -> 200 (fail open)",
    r.status === 200 && r.body && r.body.ok === true, "status " + r.status);
  r = await mintRead({ db: makeDb({ throwOn: true }), kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP });
  check("7j D1 error + other user -> 200 (fail open, documented)",
    r.status === 200 && r.body && r.body.ok === true, "status " + r.status);
  r = await mintRead({ db: privDb(), kv: privKv(OTHER_FP, OTHER_ID), fp: OTHER_FP, lib: "khazendar" });
  check("7k khazendar (drive-kind) private file + other -> 403 private_library",
    r.status === 403 && r.body && r.body.error === "private_library",
    "status " + r.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
