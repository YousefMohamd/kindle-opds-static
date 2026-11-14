// Test for the RliBook Reader URL contract + pure logic
// (site/reader/reader-lib.js). Standalone Node script — run from the
// repo root:
//   node site/reader/reader.test.mjs
//
// No network, no browser, no deploy. Exit 0 = all pass.
// What it asserts:
//   A. resolveBookSource: every documented URL form (hindawi, drive
//      libs, doab, telegram token, direct src, sample/demo, empty)
//      resolves to the right kind + URL; bad input gives kind:"error"
//      or "unsupported", never a fetchable attacker URL.
//   B. isAllowedSrcUrl: allowlisted library hosts pass; everything
//      else (other hosts, http, javascript:, //evil) is refused.
//   C. buildReaderUrl: the /book "Read online" link round-trips
//      through resolveBookSource (hindawi / tg / drive).
//   D. warmLight: brightness/warmth stay in range, warmth moves the
//      colour from pale straw to deep amber, brightness 0 = invisible.
//   E. bookKey: stable for the same URL, different for another book.
//   F. FONTS / HIGHLIGHT_COLORS: 3 fonts, 4 Kindle-style colours.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// reader-lib.js is a UMD file (classic <script> in the browser), so the
// ESM test loads it through createRequire instead of `import`.
const require = createRequire(import.meta.url);
const Lib = require("./reader-lib.js");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + " — " + (e && e.message));
  }
}

// ---------- A. resolveBookSource ----------
check("A1 hindawi id -> direct epub url", () => {
  const s = Lib.resolveBookSource({ lib: "hindawi", id: "13028368" });
  assert.equal(s.kind, "epub");
  assert.equal(s.url, "https://www.hindawi.org/books/13028368.epub");
});
check("A2 hindawi bad id -> error", () => {
  assert.equal(Lib.resolveBookSource({ lib: "hindawi", id: "abc" }).kind, "error");
  assert.equal(Lib.resolveBookSource({ lib: "hindawi" }).kind, "error");
});
check("A3 drive libs -> google uc url + corsRisk", () => {
  for (const lib of ["khazendar", "sahwa", "electronic"]) {
    const s = Lib.resolveBookSource({ lib, id: "1AbC2" });
    assert.equal(s.kind, "epub");
    assert.equal(s.url, "https://drive.google.com/uc?id=1AbC2&export=download");
    assert.equal(s.corsRisk, true);
  }
});
check("A4 drive lib without id -> error", () => {
  assert.equal(Lib.resolveBookSource({ lib: "khazendar" }).kind, "error");
});
check("A5 doab full url -> epub", () => {
  const s = Lib.resolveBookSource({ lib: "doab", id: "https://example.org/x.epub" });
  assert.equal(s.kind, "error"); // example.org is not allowlisted
  const ok = Lib.resolveBookSource({
    lib: "doab",
    id: "https://www.gutenberg.org/cache/epub/1342/pg1342.epub",
  });
  assert.equal(ok.kind, "epub");
});
check("A6 telegram -> token url, epub only", () => {
  const s = Lib.resolveBookSource({ lib: "tg", h: "Khazendar", p: "123", f: "epub" });
  assert.equal(s.kind, "token");
  assert.equal(s.tokenUrl, "/api/dl-token?h=khazendar&p=123&f=epub");
  assert.equal(Lib.resolveBookSource({ lib: "tg", h: "x", p: "1", f: "pdf" }).kind, "unsupported");
  assert.equal(Lib.resolveBookSource({ lib: "tg", h: "x" }).kind, "error");
  assert.equal(Lib.resolveBookSource({ lib: "tg", h: "c", p: "1" }).kind, "token"); // proxy decides private groups
});
check("A7 direct src allowlisted -> epub; pdf -> unsupported", () => {
  const s = Lib.resolveBookSource({ src: "https://www.hindawi.org/books/13028368.epub" });
  assert.equal(s.kind, "epub");
  assert.equal(Lib.resolveBookSource({ src: "https://www.hindawi.org/books/1.pdf" }).kind, "unsupported");
  assert.equal(Lib.resolveBookSource({ src: "https://www.hindawi.org/books/1.pdf" }).format, "pdf");
});
check("A8 demo / sample files", () => {
  assert.equal(Lib.resolveBookSource({ demo: "1" }).url, "/files/RliBook-Home-en.epub");
  assert.equal(Lib.resolveBookSource({ file: "home-ar" }).url, "/files/RliBook-Home-ar.epub");
});
check("A9 unknown lib -> error; no params -> empty", () => {
  assert.equal(Lib.resolveBookSource({ lib: "nope", id: "1" }).kind, "error");
  assert.equal(Lib.resolveBookSource({}).kind, "empty");
});

// ---------- B. isAllowedSrcUrl ----------
check("B1 allowlisted hosts pass", () => {
  for (const h of ["https://www.hindawi.org/books/1.epub", "https://www.safahat.org/books/1.epub",
    "https://drive.google.com/uc?id=1&export=download",
    "https://rlibook-download.injectcloud.space/dl?h=a&p=1&f=epub&t=v1.x.y",
    "https://rlibook.tech/files/x.epub", "/files/RliBook-Home-en.epub"]) {
    assert.equal(Lib.isAllowedSrcUrl(h), true, h);
  }
});
check("B2 everything else refused", () => {
  for (const u of ["https://evil.example.com/book.epub", "http://www.hindawi.org/books/1.epub",
    "javascript:alert(1)", "//evil.example.com/x.epub", "https://t.me/somebook/1",
    "https://www.hindawi.org.evil.example.com/x.epub", "", null]) {
    assert.equal(Lib.isAllowedSrcUrl(u), false, String(u));
  }
});

// ---------- C. buildReaderUrl round-trips ----------
check("C1 hindawi link round-trips", () => {
  const url = Lib.buildReaderUrl({ lib: "hindawi", id: "13028368", title: "لؤلؤة الحب", author: "ويلز" });
  assert.ok(url.startsWith("/site/reader/?"));
  const params = Object.fromEntries(new URLSearchParams(url.split("?")[1]));
  const s = Lib.resolveBookSource(params);
  assert.equal(s.kind, "epub");
  assert.equal(s.url, "https://www.hindawi.org/books/13028368.epub");
  assert.equal(s.title, "لؤلؤة الحب");
});
check("C2 telegram link round-trips", () => {
  const url = Lib.buildReaderUrl({ lib: "tg", h: "Khazendar", p: 42, f: "epub", title: "T" });
  const params = Object.fromEntries(new URLSearchParams(url.split("?")[1]));
  const s = Lib.resolveBookSource(params);
  assert.equal(s.kind, "token");
  assert.equal(s.tokenUrl, "/api/dl-token?h=khazendar&p=42&f=epub");
});
check("C3 drive link round-trips", () => {
  const url = Lib.buildReaderUrl({ lib: "sahwa", id: "ABC123", title: "T" });
  const params = Object.fromEntries(new URLSearchParams(url.split("?")[1]));
  const s = Lib.resolveBookSource(params);
  assert.equal(s.kind, "epub");
  assert.ok(s.url.includes("ABC123"));
});

// ---------- D. warmLight ----------
check("D1 warmth moves pale -> amber, brightness 0 = invisible", () => {
  const pale = Lib.warmLight(60, 0);
  const deep = Lib.warmLight(60, 100);
  assert.equal(pale.overlayColor, "rgb(255,239,192)");
  assert.equal(deep.overlayColor, "rgb(255,158,61)");
  assert.ok(pale.overlayOpacity > 0 && pale.overlayOpacity <= 0.55);
  assert.equal(Lib.warmLight(0, 50).overlayOpacity, 0);
  assert.equal(Lib.warmLight(100, 50).overlayOpacity, 0.55);
});
check("D2 out-of-range inputs clamp, page theme is warm", () => {
  const w = Lib.warmLight(999, -5);
  assert.equal(w.overlayOpacity, 0.55);
  assert.ok(w.pageBg.indexOf("#FFF") === 0);
  assert.equal(w.pageColor, "#1C2826");
});

// ---------- E. bookKey ----------
check("E1 stable + distinct", () => {
  const a = Lib.bookKey("https://www.hindawi.org/books/13028368.epub");
  assert.equal(a, Lib.bookKey("https://www.hindawi.org/books/13028368.epub"));
  assert.notEqual(a, Lib.bookKey("https://www.hindawi.org/books/13028369.epub"));
  assert.ok(/^b[0-9a-f]{8}$/.test(a));
});

// ---------- F. fonts + highlight colours ----------
check("F1 three fonts, four highlight colours", () => {
  assert.equal(Lib.FONTS.length, 3);
  assert.deepEqual(Lib.FONTS.map((f) => f.id), ["system", "amiri", "naskh"]);
  assert.equal(Lib.HIGHLIGHT_COLORS.length, 4);
  assert.ok(Lib.HIGHLIGHT_COLORS.every((c) => /^#[0-9A-F]{6}$/i.test(c.color)));
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
