// Test for the e-reader UA matcher (functions/kindle/[[path]].js).
// Standalone Node script — run from the repo root:
//   node functions/kindle/ua.test.mjs
//
// It imports isEReaderUA from the real /kindle/* Function module and
// asserts the matcher contract (design §3):
//   1. the substring "Kindle" matches (any case), including inside a
//      longer UA string — the matcher is a substring, never an exact
//      UA, so a firmware variation cannot lock a real Kindle out;
//   2. the wider e-reader family (Kobo, eReader, EBRD, PocketBook)
//      matches as a best-effort convenience;
//   3. a plain desktop/mobile UA and an empty/missing UA do not match;
//   4. SPOOFABILITY, documented not hidden: a desktop UA that merely
//      CONTAINS "Kindle" matches too. The test asserts this on
//      purpose — the matcher is layout-only, never a security control
//      (what stops bulk abuse is the token scheme: 10-minute
//      single-book tokens + mint caps + the flag denylist). Any
//      future change that claims the UA gate "stops" spoofing must
//      fail this test first.
// Exit 0 = all pass; non-zero = failure. No network, no deploy.
//
// NOTE: no verified 10th-gen Kindle UA string exists in the evidence
// base yet. The fixtures below are plausible shapes, not captured
// strings — once real UAs are observed in the logs (§3.1), add them
// here as fixtures verbatim.

import { isEReaderUA, EREADER_UA_SUBSTRINGS } from "./[[path]].js";

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

check("1a 'Kindle' substring matches",
  isEReaderUA("Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/534.24 (KHTML, like Gecko) Version/4.0 Safari/534.24 Kindle/3.0"));
check("1b lowercase 'kindle' matches (case-insensitive)",
  isEReaderUA("mozilla/5.0 kindle/3.0"));
check("1c mixed-case 'KiNdLe' matches",
  isEReaderUA("SomeBrowser/1.0 (KiNdLe; U; en-us)"));
check("1d bare 'Kindle' matches",
  isEReaderUA("Kindle"));
check("1e 'Kindle' required substring is exported",
  EREADER_UA_SUBSTRINGS.includes("Kindle"));

check("2a Kobo matches (best-effort)",
  isEReaderUA("Mozilla/5.0 (X11; Linux) Kobo/4.0"));
check("2b eReader matches (best-effort)",
  isEReaderUA("eReader/2.0 (compatible)"));
check("2c EBRD matches (best-effort)",
  isEReaderUA("Mozilla/5.0 EBRD/1.0"));
check("2d PocketBook matches (best-effort)",
  isEReaderUA("Mozilla/5.0 (Linux) PocketBook/6.0"));

check("3a desktop Chrome UA does not match",
  !isEReaderUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"));
check("3b Firefox UA does not match",
  !isEReaderUA("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"));
check("3c iPhone Safari UA does not match",
  !isEReaderUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"));
check("3d empty UA does not match", !isEReaderUA(""));
check("3e missing UA does not match", !isEReaderUA(undefined) && !isEReaderUA(null));
check("3f a UA that merely mentions books does not match",
  !isEReaderUA("Mozilla/5.0 (compatible; BookReader/1.0)"));

check("4a SPOOFED desktop UA containing 'Kindle' matches — the matcher is spoofable by design",
  isEReaderUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Kindle/3.0"));
check("4b curl with a Kindle UA matches — curl -A '...Kindle...' reaches the entry page",
  isEReaderUA("curl/8.0 Kindle"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
