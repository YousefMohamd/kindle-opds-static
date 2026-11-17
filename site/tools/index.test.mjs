// Test for the public tools page (site/tools/index.html).
// Standalone Node script — run from the repo root:
//   node site/tools/index.test.mjs
//
// No network, no browser, no deploy. Exit 0 = all pass.
//
// What it asserts (bot-only converter, 2026-11-16):
//   - The public tools page contains NO link to /site/convert/.
//     The converter is bot-only: it is opened only via the Telegram
//     bot's /convert command (Mini App), never linked or advertised
//     from any public website page.
//   - The converter card (its button label) is gone too, so the
//     feature is not advertised even without a link.
//   - Every other tool on the page is still intact (Turath, comic
//     converter, OCR/KOReader guide, Qurans, chess), so the removal
//     did not damage the rest of the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + " — " + e.message);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

console.log("tools page: converter must NOT be linked (bot-only)");
check("no href to /site/convert/", () => {
  assert.ok(!html.includes('href="/site/convert/"'), "found href=\"/site/convert/\"");
  assert.ok(!html.includes("href='/site/convert/'"), "found href='/site/convert/'");
  assert.ok(!html.includes("/site/convert"), "found a /site/convert reference");
});
check("no converter card / open-converter button", () => {
  assert.ok(!html.includes("افتح المحوّل"), "converter button label still present");
  assert.ok(!html.includes("من كتاب ممسوح"), "converter card heading still present");
});

console.log("tools page: every other tool is still intact");
check("Turath tool still present", () => assert.ok(html.includes("app.turath.io")));
check("comic converter still present", () => assert.ok(html.includes("go-comic-converter")));
check("OCR / KOReader guide still present", () => assert.ok(html.includes("koreader/data/tessdata")));
check("Qurans card still present", () => assert.ok(html.includes('href="/qurans/"')));
check("chess still present", () => assert.ok(html.includes("/games/chess.html")));
check("bot link still present", () => assert.ok(html.includes("https://t.me/RliBook_bot")));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
