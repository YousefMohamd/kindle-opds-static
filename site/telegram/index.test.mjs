// Test for the public Telegram pages (site/telegram/index.html and
// site/telegram/libraries.html) — P1-5: no direct links to the library
// channels/groups.
//
// The download gate (5/day cap + token) only works if readers reach a
// book through our own catalog. A t.me/<handle> link lets a reader join
// the channel/group and download books straight from Telegram, bypassing
// the gate — so no public page may link to a library channel/group.
// Library NAMES and COUNTS stay public; the handles stay in the manifest
// (site/telegram/index.json) for the bot and OPDS feeds, which still use
// them internally.
//
// What is deliberately NOT asserted here:
//  * https://t.me/RliBook_bot — our own bot, not a library channel.
//  * The per-book format chips in index.html (tg://resolve?domain=...
//    &post=...): those link to individual book POSTS, not to channels,
//    and they are the index page's download mechanism. Routing them
//    through the gated book page is a separate design decision, not
//    part of P1-5 — see the task report.
//
// Standalone Node script — run from the repo root:
//   node --test site/telegram/index.test.mjs
//   node site/telegram/index.test.mjs
// Exit 0 = all pass; non-zero = failure. No network, no deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

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

// A t.me link to anything other than our own bot is a channel link.
const CHANNEL_TME = /https:\/\/t\.me\/(?!RliBook_bot\b)[A-Za-z0-9_]/;

// --- libraries.html: the library list -------------------------------
const libs = read("site/telegram/libraries.html");
const manifest = JSON.parse(read("site/telegram/index.json"));

check(
  "1a libraries.html: no t.me/ channel link",
  !CHANNEL_TME.test(libs),
  (libs.match(/https:\/\/t\.me\/[A-Za-z0-9_]+/g) || []).join(", "),
);
const tmeLinks = libs.match(/https:\/\/t\.me\/[A-Za-z0-9_]+/g) || [];
check(
  "1b libraries.html: only t.me link left is the bot (footer)",
  tmeLinks.length === 1 && tmeLinks[0] === "https://t.me/RliBook_bot",
  `t.me/ links: ${tmeLinks.join(", ")}`,
);
check(
  "1c libraries.html: no tg:// link",
  !/tg:\/\//.test(libs),
);
const entries = libs.match(/<li><div class="name">/g) || [];
check(
  "1d libraries.html: one entry per manifest source (names kept)",
  entries.length === manifest.sources.length,
  `${entries.length} entries vs ${manifest.sources.length} sources`,
);
check(
  "1e libraries.html: every source name still shown",
  manifest.sources.every((s) => libs.includes(`<div class="name">${s.name}</div>`)),
);
check(
  "1f libraries.html: every entry still shows its book/post counts",
  manifest.sources.every((s) => {
    const count = s.files
      ? `${s.files.toLocaleString("en-US")} كتاب`
      : "لا كتب مفهرسة بعد";
    return libs.includes(`${count} • ${s.posts.toLocaleString("en-US")} منشور`);
  }),
);
check(
  "1g libraries.html: every entry links to our gated catalog filter",
  manifest.sources.every((s) =>
    libs.includes(`<a href="/telegram/?source=${s.name}">كتب المكتبة ←</a>`),
  ),
);
check(
  "1h libraries.html: totals line kept",
  libs.includes(`${manifest.sources.length} مكتبة،`) &&
    libs.includes(`${manifest.totals.books.toLocaleString("en-US")} كتاب مميز`),
);

// --- index.html: the search page ------------------------------------
const index = read("site/telegram/index.html");

check(
  "2a index.html: no t.me/ channel link (banner or elsewhere)",
  !CHANNEL_TME.test(index),
  (index.match(/https:\/\/t\.me\/(?!RliBook_bot\b)[A-Za-z0-9_]+/g) || []).join(", "),
);
check(
  "2b index.html: no t.me/<handle> built from the ?source= filter",
  !index.includes('https://t.me/" + encodeURIComponent(SRC)'),
);
check(
  "2c index.html: source banner still names the library + next steps",
  index.includes("libraries.html") &&
    index.includes('href=\\"/telegram/\\"') &&
    index.includes('"مكتبة <b>" + esc(SRC)'),
);
check(
  "2d index.html: bot link kept (not a library channel)",
  index.includes("https://t.me/RliBook_bot"),
);

// --- generator: regeneration must not reintroduce the links ---------
const gen = read("scripts/generate-libraries.py");
check(
  "3a generator: emits no t.me/ channel link per entry",
  !/https:\/\/t\.me\/\{/.test(gen) && !gen.includes('https://t.me/{html.escape(name'),
  "generator still emits a t.me/<handle> entry link",
);
check(
  "3b generator: entry still emits the gated /telegram/?source= link",
  gen.includes('/telegram/?source={html.escape(name, quote=True)}'),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
