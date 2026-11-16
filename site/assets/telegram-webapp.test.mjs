// RliBook Telegram Mini App — tests (v4.8.44, workstream D).
// node:test, no dependencies. Run from the repo root:
//   node site/assets/telegram-webapp.test.mjs
//
// No network, no browser, no deploy. Exit 0 = all pass.
// What it asserts:
//   A. themeCssVars: Telegram theme params map to the site's CSS
//      variables; missing keys are skipped; non-#rrggbb values are
//      rejected (a bad theme can never inject CSS).
//   B. isTelegramWebApp: true ONLY with a non-empty initData — the
//      script's presence alone (WebApp defined, empty initData) is
//      NOT Telegram.
//   C. initTelegramWebApp with a stub window/document: outside
//      Telegram it is a complete no-op; inside it calls ready +
//      expand, adds the tg-webapp class, applies the theme, sets the
//      header/background colour, wires the Back button to history,
//      and survives missing/throwing Telegram APIs.
//   D. Static checks: every HTML page loads the official Telegram
//      script + this init script (in that order, once each) and has
//      viewport-fit=cover; the stylesheets carry the .tg-webapp
//      rules; the reader hides its PWA install buttons in Telegram.
//   E. Safety: the init script sends nothing anywhere (no fetch /
//      XHR / beacon, no initDataUnsafe) and stays ES5-style (no
//      arrows, no async/await) like the rest of the site.
//   F. NEW (Workstream 3b, Mini App hub): device() maps the Telegram
//      platform to phone/desktop; openExternal/openDownload exit to
//      the device browser via WebApp.openLink (location.assign
//      fallback outside Telegram); clicks on a[data-tg-download]
//      are intercepted (parent walk, no Element.closest) and opened
//      outside the webview; init exposes device + openers on the
//      result and on window.RliBookTelegram.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const tg = require("./telegram-webapp.js");

const PAGES = [
  "../../index.html",
  "../telegram/index.html",
  "../telegram/libraries.html",
  "../reader/index.html",
  "../tools/index.html",
  "../stats/index.html",
  "../newspapers/index.html",
  "../qurans/index.html",
  "../notebook/index.html",
  "../games/index.html",
  "../games/checkers.html",
  "../games/chess.html",
  "../games/connect4.html",
  "../games/nonogram.html",
  "../games/set.html",
];

const DARK = {
  bg_color: "#17212b",
  secondary_bg_color: "#232e3c",
  section_bg_color: "#232e3c",
  text_color: "#ffffff",
  hint_color: "#7f91a4",
  link_color: "#6ab3f3",
  button_color: "#5288c1",
  button_text_color: "#ffffff",
  colorScheme: "dark",
};

// ---- stubs ---------------------------------------------------------------

function fakeDoc() {
  const props = {};
  const classes = new Set();
  return {
    documentElement: {
      classList: {
        add: (c) => classes.add(c),
        contains: (c) => classes.has(c),
      },
      style: {
        setProperty: (k, v) => { props[k] = v; },
        colorScheme: "",
      },
    },
    _props: props,
    _classes: classes,
  };
}

function fakeWebApp(overrides) {
  const calls = [];
  const backButton = {
    shown: false,
    hidden: false,
    onClickCb: null,
    show() { this.shown = true; this.hidden = false; calls.push("BackButton.show"); },
    hide() { this.shown = false; this.hidden = true; calls.push("BackButton.hide"); },
    onClick(cb) { this.onClickCb = cb; calls.push("BackButton.onClick"); },
  };
  const wa = {
    initData: "query_id=AA&user=%7B%22id%22%3A1%7D&auth_date=1&hash=abc",
    version: "7.0",
    platform: "android",
    themeParams: DARK,
    ready() { calls.push("ready"); },
    expand() { calls.push("expand"); },
    setHeaderColor(c) { calls.push("setHeaderColor:" + c); },
    setBackgroundColor(c) { calls.push("setBackgroundColor:" + c); },
    disableVerticalSwipes() { calls.push("disableVerticalSwipes"); },
    onEvent(ev, cb) { calls.push("onEvent:" + ev); wa._themeCb = cb; },
    BackButton: backButton,
    ...(overrides || {}),
  };
  return { wa, calls, backButton };
}

function fakeWin(wa, historyLength) {
  const listeners = {};
  const history = {
    length: historyLength,
    backCalls: 0,
    back() { this.backCalls++; },
  };
  return {
    Telegram: { WebApp: wa },
    history,
    addEventListener(ev, cb) { listeners[ev] = cb; },
    _listeners: listeners,
    _history: history,
  };
}

// ---- A. theme mapping -----------------------------------------------------

test("A. themeCssVars maps every Telegram colour to the site variables", () => {
  const vars = tg.themeCssVars(DARK);
  assert.equal(vars["--paper"], "#17212b");
  assert.equal(vars["--sky-pale"], "#232e3c");
  assert.equal(vars["--sky-light"], "#232e3c");
  assert.equal(vars["--card"], "#232e3c");
  assert.equal(vars["--ink"], "#ffffff");
  assert.equal(vars["--muted"], "#7f91a4");
  assert.equal(vars["--link"], "#6ab3f3");
  assert.equal(vars["--link-hover"], "#6ab3f3");
  assert.equal(vars["--tg-button"], "#5288c1");
  assert.equal(vars["--tg-button-text"], "#ffffff");
  assert.ok(!("--tg-button" in tg.themeCssVars({}))); // missing keys skipped
});

test("A. themeCssVars rejects anything that is not #rrggbb", () => {
  const vars = tg.themeCssVars({
    bg_color: "red",
    text_color: "#12345",
    link_color: "#1234567",
    hint_color: "javascript:alert(1)",
    button_color: "#AABBCC",
  });
  assert.deepEqual(Object.keys(vars), ["--tg-button"]);
  assert.equal(vars["--tg-button"], "#AABBCC");
  assert.deepEqual(tg.themeCssVars(undefined), {});
  assert.deepEqual(tg.themeCssVars(null), {});
});

// ---- B. detection ----------------------------------------------------------

test("B. isTelegramWebApp is true only with a non-empty initData", () => {
  assert.equal(tg.isTelegramWebApp({ Telegram: { WebApp: { initData: "x=1" } } }), true);
  // The script defines WebApp even in a plain browser — empty
  // initData means NOT Telegram.
  assert.equal(tg.isTelegramWebApp({ Telegram: { WebApp: { initData: "", platform: "unknown" } } }), false);
  assert.equal(tg.isTelegramWebApp({ Telegram: { WebApp: {} } }), false);
  assert.equal(tg.isTelegramWebApp({ Telegram: {} }), false);
  assert.equal(tg.isTelegramWebApp({}), false);
  assert.equal(tg.isTelegramWebApp(undefined), false);
  assert.equal(tg.isTelegramWebApp(null), false);
});

// ---- C. init behaviour -----------------------------------------------------

test("C. outside Telegram init is a complete no-op (never throws)", () => {
  const doc = fakeDoc();
  const win = { history: { length: 1, back() {} } }; // no Telegram at all
  const res = tg.initTelegramWebApp(win, doc);
  assert.deepEqual(res, { isTelegram: false });
  assert.equal(doc._classes.has("tg-webapp"), false);
  assert.deepEqual(doc._props, {});
  assert.equal(win.RliBookTelegram, undefined);
});

test("C. inside Telegram init calls ready+expand, themes, sets header colour", () => {
  const { wa, calls } = fakeWebApp();
  const doc = fakeDoc();
  const win = fakeWin(wa, 1);
  const res = tg.initTelegramWebApp(win, doc);
  assert.equal(res.isTelegram, true);
  assert.equal(res.version, "7.0");
  assert.equal(res.colorScheme, "dark");
  assert.ok(calls.includes("ready"));
  assert.ok(calls.includes("expand"));
  assert.ok(calls.includes("setHeaderColor:#17212b"));
  assert.ok(calls.includes("setBackgroundColor:#17212b"));
  assert.ok(calls.includes("disableVerticalSwipes"));
  assert.ok(calls.includes("onEvent:themeChanged"));
  assert.equal(doc._classes.has("tg-webapp"), true);
  assert.equal(doc._props["--paper"], "#17212b");
  assert.equal(doc._props["--ink"], "#ffffff");
  assert.equal(doc.documentElement.style.colorScheme, "dark");
  assert.equal(win.RliBookTelegram.isTelegram, true);
});

test("C. Back button: shown when history exists, hidden on the entry page, goes back on tap", () => {
  const { wa, calls, backButton } = fakeWebApp();
  const win = fakeWin(wa, 3);
  tg.initTelegramWebApp(win, fakeDoc());
  assert.equal(backButton.shown, true);
  assert.equal(typeof backButton.onClickCb, "function");
  backButton.onClickCb();
  assert.equal(win._history.backCalls, 1);

  const second = fakeWebApp();
  const win2 = fakeWin(second.wa, 1);
  tg.initTelegramWebApp(win2, fakeDoc());
  assert.equal(second.backButton.hidden, true);
  assert.equal(second.backButton.shown, false);
  assert.ok(calls.includes("BackButton.onClick"));
});

test("C. themeChanged re-applies the new theme", () => {
  const { wa } = fakeWebApp();
  const doc = fakeDoc();
  tg.initTelegramWebApp(fakeWin(wa, 1), doc);
  assert.equal(doc._props["--paper"], "#17212b");
  wa.themeParams = { ...DARK, bg_color: "#000000", colorScheme: "light" };
  wa._themeCb();
  assert.equal(doc._props["--paper"], "#000000");
  assert.equal(doc.documentElement.style.colorScheme, "light");
});

test("C. missing or throwing Telegram APIs never break the page", () => {
  // Old client: no BackButton, no header API, no vertical-swipes API,
  // and ready() throws.
  const { wa } = fakeWebApp({
    BackButton: undefined,
    setHeaderColor: undefined,
    setBackgroundColor: undefined,
    disableVerticalSwipes: undefined,
    ready() { throw new Error("no ready"); },
    expand() { throw new Error("no expand"); },
  });
  const doc = fakeDoc();
  const res = tg.initTelegramWebApp(fakeWin(wa, 1), doc);
  assert.equal(res.isTelegram, true); // still initialised
  assert.equal(doc._classes.has("tg-webapp"), true);
  assert.equal(doc._props["--paper"], "#17212b");
});

// ---- D. static checks -------------------------------------------------------

test("D. every HTML page loads both Telegram scripts, in order, once each", () => {
  const tgScript = '<script src="https://telegram.org/js/telegram-web-app.js" defer></script>';
  const initScript = '<script src="/site/assets/telegram-webapp.js" defer></script>';
  for (const p of PAGES) {
    const html = read(p);
    assert.equal(html.split(tgScript).length - 1, 1, p + ": Telegram script once");
    assert.equal(html.split(initScript).length - 1, 1, p + ": init script once");
    assert.ok(
      html.indexOf(tgScript) < html.indexOf(initScript),
      p + ": official script before init script",
    );
    assert.ok(
      html.indexOf(initScript) < html.indexOf("</head>"),
      p + ": scripts in <head>",
    );
  }
  assert.equal(PAGES.length, 15);
});

test("D. every HTML page has viewport-fit=cover", () => {
  for (const p of PAGES) {
    assert.ok(
      read(p).includes("viewport-fit=cover"),
      p + ": viewport-fit=cover",
    );
  }
});

test("D. stylesheets carry the Telegram overrides", () => {
  assert.ok(read("../assets/rlibook.css").includes(".tg-webapp .tg-hide"));
  assert.ok(read("../assets/rlibook.css").includes(".tg-webapp .card"));
  assert.ok(read("../reader/reader.css").includes(".tg-webapp .tg-hide"));
});

test("D. the reader hides its PWA install buttons inside Telegram", () => {
  const html = read("../reader/index.html");
  assert.ok(html.includes('class="btn tg-hide" id="install-btn"'));
  assert.ok(html.includes('class="status tg-hide" id="ios-install-hint"'));
});

test("D. the init script file exists and is the one the pages load", () => {
  const src = read("./telegram-webapp.js");
  assert.ok(src.includes("initTelegramWebApp"));
  assert.ok(src.includes("themeCssVars"));
});

// ---- E. safety ---------------------------------------------------------------

test("E. the init script sends nothing anywhere and reads no identity", () => {
  const src = read("./telegram-webapp.js");
  for (const banned of ["fetch(", "XMLHttpRequest", "sendBeacon", "initDataUnsafe", "WebAppUser", "localStorage", "sessionStorage"]) {
    assert.ok(!src.includes(banned), "must not contain " + banned);
  }
  // It may READ initData (presence check only) but must never send it.
  assert.ok(src.includes("initData"));
});

test("E. the init script stays ES5-style like the rest of the site", () => {
  const src = read("./telegram-webapp.js");
  assert.ok(!src.includes("=>"), "no arrow functions");
  assert.ok(!src.includes("async "), "no async");
  assert.ok(!src.includes("await "), "no await");
  assert.ok(src.includes('"use strict"'));
});

// ---- F. Mini App hub: device + download interception (WS3b) ------------

function fakeDocWithClick() {
  const doc = fakeDoc();
  const handlers = {};
  doc.addEventListener = (ev, cb) => { handlers[ev] = cb; };
  doc._handlers = handlers;
  return doc;
}

function fakeAnchor(href, withDownloadAttr) {
  return {
    tagName: "A",
    parentNode: null,
    getAttribute: (k) => {
      if (k === "href") return href;
      if (k === "data-tg-download") return withDownloadAttr ? "" : null;
      return null;
    },
  };
}

test("F. device() maps the Telegram platform to phone/desktop", () => {
  assert.deepEqual(tg.device({ platform: "android" }), { platform: "android", isPhone: true, isDesktop: false });
  assert.deepEqual(tg.device({ platform: "android_x" }), { platform: "android_x", isPhone: true, isDesktop: false });
  assert.deepEqual(tg.device({ platform: "ios" }), { platform: "ios", isPhone: true, isDesktop: false });
  assert.deepEqual(tg.device({ platform: "macos" }), { platform: "macos", isPhone: false, isDesktop: true });
  assert.deepEqual(tg.device({ platform: "tdesktop" }), { platform: "tdesktop", isPhone: false, isDesktop: true });
  assert.deepEqual(tg.device({ platform: "weba" }), { platform: "weba", isPhone: false, isDesktop: true });
  assert.deepEqual(tg.device({ platform: "web" }), { platform: "web", isPhone: false, isDesktop: true });
  assert.deepEqual(tg.device({ platform: "webk" }), { platform: "webk", isPhone: false, isDesktop: true });
  assert.deepEqual(tg.device({ platform: "unigram" }), { platform: "unigram", isPhone: false, isDesktop: true });
  assert.deepEqual(tg.device({ platform: "unknown" }), { platform: "unknown", isPhone: false, isDesktop: false });
  assert.deepEqual(tg.device({}), { platform: "", isPhone: false, isDesktop: false });
  assert.deepEqual(tg.device(undefined), { platform: "", isPhone: false, isDesktop: false });
  assert.deepEqual(tg.device(null), { platform: "", isPhone: false, isDesktop: false });
});

test("F. openExternal uses WebApp.openLink inside Telegram, location.assign outside", () => {
  const opened = [];
  const wa = { openLink(url) { opened.push(url); } };
  assert.equal(tg.openExternal({}, wa, "https://rlibook.tech/k/abcdefghijklmnop"), true);
  assert.deepEqual(opened, ["https://rlibook.tech/k/abcdefghijklmnop"]);
  // No openLink (old client): falls back to location.assign.
  const assigned = [];
  const win = { location: { assign(url) { assigned.push(url); } } };
  assert.equal(tg.openExternal(win, {}, "https://example.test/x"), true);
  assert.deepEqual(assigned, ["https://example.test/x"]);
  // Nothing to open with: false, never throws.
  assert.equal(tg.openExternal({}, {}, ""), false);
  assert.equal(tg.openExternal(undefined, undefined, "https://example.test/x"), false);
  assert.equal(tg.openExternal({}, { openLink() { throw new Error("boom"); } }, "https://example.test/x"), false);
});

test("F. openDownload opens the short link outside the webview", () => {
  const opened = [];
  const wa = { openLink(url) { opened.push(url); } };
  assert.equal(tg.openDownload({}, wa, "https://rlibook.tech/k/abcdefghijklmnop"), true);
  assert.deepEqual(opened, ["https://rlibook.tech/k/abcdefghijklmnop"]);
});

test("F. wireDownloadLinks intercepts a[data-tg-download] taps (parent walk), leaves other links alone", () => {
  const opened = [];
  const wa = { openLink(url) { opened.push(url); } };
  const doc = fakeDocWithClick();
  const win = {};
  tg.wireDownloadLinks(win, doc, wa);
  assert.equal(typeof doc._handlers.click, "function");

  // Tap on a CHILD of the download anchor (a span inside it): the
  // parent walk must still find the anchor and intercept.
  const anchor = fakeAnchor("https://rlibook.tech/k/abcdefghijklmnop", true);
  const child = { tagName: "SPAN", parentNode: anchor };
  let prevented = false;
  doc._handlers.click({ target: child, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://rlibook.tech/k/abcdefghijklmnop"]);

  // Tap on a plain link (no data-tg-download): untouched.
  const plain = fakeAnchor("https://rlibook.tech/book?q=x", false);
  prevented = false;
  doc._handlers.click({ target: plain, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(opened, ["https://rlibook.tech/k/abcdefghijklmnop"]);

  // Tap on the download anchor itself: intercepted too.
  prevented = false;
  doc._handlers.click({ target: anchor, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(opened.length, 2);

  // A download anchor with no href: never intercepted, never throws.
  const noHref = fakeAnchor("", true);
  prevented = false;
  doc._handlers.click({ target: noHref, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(opened.length, 2);
});

test("F. init exposes device + openers on the result and on window.RliBookTelegram", () => {
  const opened = [];
  const { wa } = fakeWebApp({
    platform: "ios",
    openLink(url) { opened.push(url); },
  });
  const doc = fakeDocWithClick();
  const win = fakeWin(wa, 1);
  const res = tg.initTelegramWebApp(win, doc);
  assert.equal(res.isTelegram, true);
  assert.deepEqual(res.device, { platform: "ios", isPhone: true, isDesktop: false });
  assert.equal(typeof res.openExternal, "function");
  assert.equal(typeof res.openDownload, "function");
  assert.equal(win.RliBookTelegram.device.isPhone, true);
  res.openDownload("https://rlibook.tech/k/abcdefghijklmnop");
  assert.deepEqual(opened, ["https://rlibook.tech/k/abcdefghijklmnop"]);
  // The click interception is wired by init too.
  assert.equal(typeof doc._handlers.click, "function");
  // Outside Telegram the result has no device and no openers.
  const out = tg.initTelegramWebApp({ history: { length: 1, back() {} } }, fakeDoc());
  assert.deepEqual(out, { isTelegram: false });
});
