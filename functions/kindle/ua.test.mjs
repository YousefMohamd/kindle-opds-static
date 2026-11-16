// Test for the e-reader UA matcher (functions/kindle/[[path]].js).
// Standalone Node script — run from the repo root:
//   node functions/kindle/ua.test.mjs
//
// It imports isEReaderUA from the real /kindle/* Function module and
// asserts the matcher contract (design §3):
//   1. the substring "Kindle" matches (any case), including inside a
//      longer UA string — the matcher is a substring, never an exact
//      UA, so a firmware variation cannot lock a real Kindle out;
//   2. the wider e-reader family (Kobo, eReader, EBRD, PocketBook,
//      Tolino, Boox) matches as a best-effort convenience;
//   3. a plain desktop/mobile UA and an empty/missing UA do not match;
//   4. SPOOFABILITY, documented not hidden: a desktop UA that merely
//      CONTAINS "Kindle" matches too. The test asserts this on
//      purpose — the matcher is layout-only, never a security control
//      (what stops bulk abuse is the token scheme: 10-minute
//      single-book tokens + mint caps + the flag denylist). Any
//      future change that claims the UA gate "stops" spoofing must
//      fail this test first.
//   5. the family classifier (detectEReaderFamily, Workstream E):
//      real UA fixtures per family (Kindle Paperwhite HTTP UA,
//      Kobo sync UA, PocketBook UA from a UA-parser dataset),
//      "eReader"/"EBRD" -> "generic" (unverified tokens, never a
//      named device), Fire tablets (Silk, no "Kindle/") -> null,
//      priority order, and the equivalence
//      isEReaderUA(u) === (family(u) !== null), plus the family
//      metadata table (direct download, email, USB, formats).
// Exit 0 = all pass; non-zero = failure. No network, no deploy.
//
// NOTE: no verified 10th-gen Kindle UA string exists in the evidence
// base yet. The fixtures below are plausible shapes, not captured
// strings — once real UAs are observed in the logs (§3.1), add them
// here as fixtures verbatim. The Kobo fixture is the Kobo SYNC UA
// (not a captured browser UA); the PocketBook fixture is from a
// UA-parser dataset (not observed by us). Both are labelled in the
// plan (docs/ereader-detection.md §1, S6/S11) and must be replaced
// by observed browser UAs when M9/M10 land.

import { isEReaderUA, detectEReaderFamily, EREADER_FAMILIES, EREADER_UA_SUBSTRINGS } from "./[[path]].js";

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
check("2e Tolino matches (best-effort, WS-I 2026-11-16)",
  isEReaderUA("Mozilla/5.0 (Linux) Tolino/1.0"));
check("2f Boox matches (best-effort, WS-I 2026-11-16)",
  isEReaderUA("Mozilla/5.0 (Linux; Android 11) Boox/3.0"));

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

// ================= 5. family classifier =============================
// Real UA fixtures (plan §1): S3 (Kindle Paperwhite HTTP UA), S6
// (Kobo sync UA — not a captured browser UA), S11 (PocketBook UA
// from a UA-parser dataset — not observed by us).
console.log("5. detectEReaderFamily:");
const KINDLE_PAPERWHITE = "Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+";
const KOBO_SYNC = "Kobo Touch 0390/4.45.23684";
const POCKETBOOK = "Mozilla/5.0 (Linux like Android; en_US) AppleWebKit/534.34 PocketBook/515 (screen 600x800; FW W515.4.4.540) Mobile";
const SILK_FIRE = "Mozilla/5.0 (Linux; Android 4.4.3; KFTHWI Build/KTU84M) AppleWebKit/537.36 (KHTML, like Gecko) Silk/44.1.54 like Chrome/44.0.2403.63 Safari/537.36";

check("5a real Kindle Paperwhite UA -> kindle",
  detectEReaderFamily(KINDLE_PAPERWHITE) === "kindle");
check("5b Kobo UA -> kobo", detectEReaderFamily(KOBO_SYNC) === "kobo");
check("5c Kobo lowercase matches (case-insensitive)",
  detectEReaderFamily("mozilla/5.0 (x11; linux) kobo/4.0") === "kobo");
check("5d real PocketBook UA -> pocketbook",
  detectEReaderFamily(POCKETBOOK) === "pocketbook");
check("5e PocketBook lowercase matches",
  detectEReaderFamily("mozilla/5.0 pocketbook/6.0") === "pocketbook");
check("5f 'eReader' token -> generic, never a named device",
  detectEReaderFamily("eReader/2.0 (compatible)") === "generic");
check("5g 'EBRD' token -> generic, never a named device",
  detectEReaderFamily("Mozilla/5.0 EBRD/1.0") === "generic");
check("5h desktop Chrome -> null", detectEReaderFamily(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36") === null);
check("5i Fire tablet (Silk, no 'Kindle/') -> null",
  detectEReaderFamily(SILK_FIRE) === null);
check("5j empty/missing UA -> null",
  detectEReaderFamily("") === null && detectEReaderFamily(undefined) === null
  && detectEReaderFamily(null) === null);
check("5k priority: UA with both Kindle and Kobo -> kindle",
  detectEReaderFamily("Mozilla/5.0 Kindle/3.0 Kobo/4.0") === "kindle");
check("5l priority: UA with both Kobo and PocketBook -> kobo",
  detectEReaderFamily("Mozilla/5.0 Kobo/4.0 PocketBook/6.0") === "kobo");
check("5m equivalence: isEReaderUA(u) === (family(u) !== null) for every fixture",
  [KINDLE_PAPERWHITE, KOBO_SYNC, POCKETBOOK, SILK_FIRE,
   "eReader/2.0", "Mozilla/5.0 EBRD/1.0", "", "Mozilla/5.0 Chrome/120.0",
   "curl/8.0 Kindle"].every((u) => isEReaderUA(u) === (detectEReaderFamily(u) !== null)));
check("5n family table: Kindle is phone-delivery, no direct download, email works, no USB",
  EREADER_FAMILIES.kindle.delivery === "phone" && EREADER_FAMILIES.kindle.directDownload === false
  && EREADER_FAMILIES.kindle.ourEmailLinkWorks === true && EREADER_FAMILIES.kindle.usb === false);
check("5o family table: Kobo is direct-download, no email service, USB, EPUB/MOBI native, AZW3/DOC not",
  EREADER_FAMILIES.kobo.delivery === "direct" && EREADER_FAMILIES.kobo.directDownload === true
  && EREADER_FAMILIES.kobo.hasOwnEmailService === false && EREADER_FAMILIES.kobo.usb === true
  && EREADER_FAMILIES.kobo.nativeFormats.includes("epub") && EREADER_FAMILIES.kobo.nativeFormats.includes("mobi")
  && !EREADER_FAMILIES.kobo.nativeFormats.includes("azw3") && !EREADER_FAMILIES.kobo.nativeFormats.includes("doc"));
check("5p family table: PocketBook is direct-download, has its own email service (not ours), AZW3/DOC native",
  EREADER_FAMILIES.pocketbook.delivery === "direct" && EREADER_FAMILIES.pocketbook.directDownload === true
  && EREADER_FAMILIES.pocketbook.hasOwnEmailService === true && EREADER_FAMILIES.pocketbook.ourEmailLinkWorks === false
  && EREADER_FAMILIES.pocketbook.nativeFormats.includes("azw3") && EREADER_FAMILIES.pocketbook.nativeFormats.includes("doc"));
check("5q family table: generic is direct-try, no email, format unknown",
  EREADER_FAMILIES.generic.delivery === "direct-try" && EREADER_FAMILIES.generic.directDownload === "try"
  && EREADER_FAMILIES.generic.ourEmailLinkWorks === false && EREADER_FAMILIES.generic.nativeFormats === null);
check("5r KOReader: Kindle jailbreak-only, Kobo/PocketBook native, generic unknown",
  EREADER_FAMILIES.kindle.koreader === "jailbreak-only" && EREADER_FAMILIES.kobo.koreader === "native"
  && EREADER_FAMILIES.pocketbook.koreader === "native" && EREADER_FAMILIES.generic.koreader === "unknown");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
