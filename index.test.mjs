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

// 5: search actions (2026-11-21) — four buttons in exact order:
// Download, Send to email, Convert, Report LAST, over one
// horizontal pick list of the books found in the search.
const bar = html.slice(html.indexOf('id="bookactions"'));
check("5a action bar exists with the four buttons in exact order",
  bar.includes('id="act-download">تنزيل الكتاب<')
  && bar.includes('id="act-email">أرسل لميل قارئي<')
  && bar.includes('id="act-convert">حوّل إلى EPUB<')
  && bar.includes('id="act-report">🚩 الإبلاغ عن الكتاب<')
  && bar.indexOf("act-download") < bar.indexOf("act-email")
  && bar.indexOf("act-email") < bar.indexOf("act-convert")
  && bar.indexOf("act-convert") < bar.indexOf("act-report"));
check("5b horizontal pick list element exists (class picklist)",
  html.includes('id="picklist" class="picklist"'));
check("5c pick list CSS scrolls horizontally (overflow-x: auto)",
  html.includes(".picklist { display: flex;") && html.includes("overflow-x: auto;"));
check("5d runSearch populates lastBooks and shows the bar when a non-flagged book exists",
  runSearch.includes("lastBooks = [];")
  && runSearch.includes("bookActionUrls(tg[bi], true)")
  && runSearch.includes("bookActionUrls(opds[oi], false)")
  && runSearch.includes("actionBar.hidden = !lastBooks.some(function (b) { return !b.flagged; });"));
check("5e parseOpds captures entry id + library slug for delivery URLs",
  html.includes('rawId = text("id").replace(/^urn:(drive|hindawi|doab):/, "")')
  && html.includes("function opdsSlug(label)")
  && html.includes('"خازندار": "khazendar"'));
check("5f download/email pick URLs use the existing paths (/kindle/get, /api/send-to-kindle)",
  html.includes('u.get = "/kindle/get?" + q;')
  && html.includes('u.send = "/api/send-to-kindle?" + q'));
check("5g convert pick is TG PDF only via /api/convert-book",
  html.includes('u.convert = u.send.replace("/api/send-to-kindle?", "/api/convert-book?")')
  && html.includes('return String(f).trim().toLowerCase() === "pdf";'));
check("5h flagged books are excluded from every pick list",
  html.includes("if (b.flagged) return false;"));
check("5i email pick hands Telegram books to the bot (send_ deep link); OPDS keeps the direct link",
  html.includes("function botSendUrl(send)")
  && html.includes('pickMode === "email" ? (botSendUrl(b.urls.send) || b.urls.send)')
  && html.includes('"https://t.me/RliBook_bot?start=send_" + h + "_" + p')
  && !html.includes("سيُرسل إلى ميل قارئك (بلا حد يومي)"));

// 6: Report LAST — copyright criteria next to it, wired to the
// existing bot report entry (main-menu Report flow, no new backend).
const reportNote = html.slice(html.indexOf('id="report-note"'), html.indexOf('id="picklist"'));
check("6a criteria text sits next to the Report button",
  reportNote.includes("إصداراً حديثاً ما زال يُباع")
  && reportNote.includes("طبعة حديثة من دار نشر")
  && reportNote.includes("الكلاسيكيات القديمة")
  && reportNote.includes("المكتبات العامة"));
check("6b criteria never writes 'تجاري' / 'commercial' (standing rule)",
  !reportNote.includes("تجاري") && !reportNote.toLowerCase().includes("commercial"));
check("6c report pick opens the bot (existing main-menu Report entry)",
  html.includes('href = pickMode === "report" ? "https://t.me/RliBook_bot"')
  && reportNote.includes("اضغط «Report» من القائمة الرئيسية"));
check("6d footer policy line rephrased (2026-11-21): no 'تجاري' in the footer, new wording present",
  html.includes("لا ننشر إصدارات حديثة محمية بحقوق النشر")
  && html.includes("والكتب القديمة المتاحة مجاناً")
  && !html.slice(html.indexOf("فهرس مجاني"), html.indexOf("</p>", html.indexOf("فهرس مجاني"))).includes("تجاري"));

// 7: emojis (2026-11-21) — no decorative emoji in hand-written
// user-facing copy; only 🚩 (the flagged-book marker) survives.
// The auto-generated newspapers block is excluded: the workflow
// owns it (it carries a 🇸🇦 country flag) and regenerates it daily.
const handWritten = html.replace(/<!-- NEWSPAPERS-STATIC-BEGIN -->[\s\S]*?<!-- NEWSPAPERS-STATIC-END -->/, "");
const decorative = ["📥", "📖", "✅", "🔄", "⭐", "📚", "📧", "✨", "🔑", "🤖", "⚠️", "⬇"];
check("7a no decorative emoji in hand-written copy (🚩 flag only)",
  decorative.every((e) => !handWritten.includes(e)),
  `found: ${JSON.stringify(decorative.filter((e) => handWritten.includes(e)))}`);
check("7b 🚩 flag marker kept for flagged books",
  html.includes('🚩 اطلبه من البوت'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
