// Tests for the removed/unavailable delivery gate
// (driveLibraryAllows in functions/api/dl-token.js), bot v4.8.84
// follow-up. Standalone Node script — run from the repo root:
//   node functions/api/drive-visibility-gate.test.mjs
// No network, no production KV/D1, no deploy. Exit 0 = all pass.
//
// The gate is shared: send-to-kindle.js and read-token.js import
// driveLibraryAllows from dl-token.js, so one fix covers mint,
// send-to-Kindle and the online reader.

import { driveLibraryAllows } from "./dl-token.js";

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

const SUBMITTER = 111;
const OWNER = 999;
const STRANGER = 222;

const lib = (visibility) => ({ folderId: "SOMEFOLDER1234567890", visibility, submitter: SUBMITTER });

// 1. Removed denies EVERYONE — submitter, owner, stranger, unknown.
for (const [who, id] of [["submitter", SUBMITTER], ["owner", OWNER], ["stranger", STRANGER], ["unknown", null]]) {
  check(`1 removed denies ${who}`, driveLibraryAllows(lib("removed"), id, OWNER) === false);
}

// 2. Unavailable denies EVERYONE too.
for (const [who, id] of [["submitter", SUBMITTER], ["owner", OWNER], ["stranger", STRANGER], ["unknown", null]]) {
  check(`2 unavailable denies ${who}`, driveLibraryAllows(lib("unavailable"), id, OWNER) === false);
}

// 3. The live states are unchanged: public for all, private for the
//    submitter only, pending_public for submitter + owner.
check("3 public allows stranger", driveLibraryAllows(lib("public"), STRANGER, OWNER) === true);
check("3 public allows unknown", driveLibraryAllows(lib("public"), null, OWNER) === true);
check("3 private allows submitter", driveLibraryAllows(lib("private"), SUBMITTER, OWNER) === true);
check("3 private denies stranger", driveLibraryAllows(lib("private"), STRANGER, OWNER) === false);
check("3 private denies unknown", driveLibraryAllows(lib("private"), null, OWNER) === false);
check("3 pending allows submitter", driveLibraryAllows(lib("pending_public"), SUBMITTER, OWNER) === true);
check("3 pending allows owner", driveLibraryAllows(lib("pending_public"), OWNER, OWNER) === true);
check("3 pending denies stranger", driveLibraryAllows(lib("pending_public"), STRANGER, OWNER) === false);

// 4. Legacy fail-open is preserved for genuinely UNKNOWN values and
//    for a null lib (not an indexed Drive book / D1 hiccup).
check("4 unknown visibility still fails open (legacy)",
  driveLibraryAllows(lib("archived"), STRANGER, OWNER) === true);
check("4 null lib allows (legacy)", driveLibraryAllows(null, STRANGER, OWNER) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
