// Test for the homepage (index.html) — source-hiding (2026-11-21)
// + smart-search "closest matches" label.
//
// Source-hiding: the two library buttons must use neutral wording
// with no "تلجرام", the Telegram results must show no library line
// (the endpoint populates `source` only for flagged books, and the
// site never renders it), and a non-exact ladder tier must be
// labelled "أقرب النتائج".
//
// What is deliberately NOT asserted here:
//  * Descriptive "تيليجرام" copy elsewhere on the page (intro
//    paragraph, count line, newspapers note, "من تيليجرام" group
//    heading / status line) — out of the task's stated scope
//    (buttons only); listed in the handoff instead.
//
// Standalone Node script — run from the repo root:
//   node index.test.mjs
// Exit 0 = all pass; non-zero = failure. No network, no deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), "utf-8");
const html = read("index.html");

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

// 1: the two library buttons use neutral wording.
check("1a browse button renamed to 'تصفّح المكتبات'",
  html.includes("تصفّح المكتبات ←") && !html.includes("تصفّح مكتبات تلجرام"));
check("1b search button renamed to 'ابحث في الكتب'",
  html.includes("ابحث في الكتب") && !html.includes("ابحث في كتب تيليجرام"));
check("1c libraries card heading renamed to 'المكتبات'",
  html.includes("<h2>المكتبات</h2>") && !html.includes("<h2>مكتبات تلجرام</h2>"));

// 2: no "تلجرام" inside any user-visible <a class="btn"> element.
const btnTexts = [...html.matchAll(/<a class="btn"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
check("2 no 'تلجرام' in any btn link text",
  btnTexts.length > 0 && btnTexts.every((t) => !t.includes("تلجرام")),
  `buttons: ${JSON.stringify(btnTexts)}`);

// 3: renderGroup no longer references b.source for Telegram books.
const renderGroup = html.slice(html.indexOf("function renderGroup"));
check("3a renderGroup does not read b.source",
  !renderGroup.includes("b.source"));
check("3b TG library line is empty (lib = tg ? \"\" : ...)",
  renderGroup.includes('var lib = tg ? "" : (b.library || "");'));
check("3c meta div rendered only when lib is non-empty",
  renderGroup.includes('(lib ? "<div class=\\"meta\\">" + esc(lib) + "</div>" : "")'));
check("3d OPDS library names still rendered",
  renderGroup.includes("(b.library || \"\")"));

// 4: the closest-matches label path exists in runSearch.
const runSearch = html.slice(html.indexOf("function runSearch"));
check("4a runSearch reads the endpoint `match` field",
  runSearch.includes("tgMatch = out[0].value.match"));
check("4b non-exact TG tier appends 'أقرب النتائج' to the status",
  runSearch.includes('if (tg.length && tgMatch && tgMatch !== "exact") statusEl.textContent += " — أقرب النتائج.";'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
