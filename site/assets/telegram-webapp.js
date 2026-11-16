/**
 * RliBook — Telegram Mini App init (v4.8.44, workstream D).
 *
 * The Mini App IS the website (rlibook.tech) running inside Telegram:
 * the bot opens it with a web_app button (main menu) or the chat menu
 * button. This file makes the site behave inside Telegram:
 *
 *   1. Detects the Telegram WebApp environment (window.Telegram.WebApp
 *      with a non-empty initData — present ONLY when the page was
 *      opened by Telegram as a Mini App, never in a plain browser).
 *   2. Calls WebApp.ready() + expand() so the app fills the screen.
 *   3. Applies Telegram's theme params to the site's CSS variables
 *      (--paper, --ink, --link, --muted, --sky-pale, --card, ...),
 *      so the site matches the user's Telegram theme (light/dark),
 *      and re-applies when the theme changes.
 *   4. Wires Telegram's Back button to the browser history (show it
 *      when there is somewhere to go back to, hide it on the home
 *      page) and sets the Telegram header/background colour.
 *   5. Adds class "tg-webapp" to <html> so CSS can hide browser-only
 *      chrome (elements with class "tg-hide", e.g. PWA install
 *      buttons — there is no browser chrome to install into).
 *   6. (Workstream 3b, Mini App hub) Device + download handling:
 *      device() reads the Telegram platform (phone vs desktop);
 *      links with data-tg-download (the token-gated short link on
 *      /kindle/get) are intercepted and opened with
 *      Telegram.WebApp.openLink() in the DEVICE browser — where
 *      downloads work — instead of inside the Mini App webview
 *      (which cannot be trusted with downloads, especially iOS
 *      WKWebView). Elements with class "tg-only" are revealed by
 *      the html.tg-webapp class (book.js / get.js render the
 *      Mini-App-only buttons with that class).
 *
 * OUTSIDE Telegram this file is a complete no-op: it never throws,
 * never changes the page, never phones home. It does NOT send the
 * initData anywhere and does NOT read the user's identity — the site
 * needs nothing from Telegram beyond the theme.
 *
 * Load order (in <head>, both deferred, in this order):
 *   <script src="https://telegram.org/js/telegram-web-app.js" defer></script>
 *   <script src="/site/assets/telegram-webapp.js" defer></script>
 * Deferred scripts run in order after parsing, so window.Telegram is
 * defined before this file runs. If telegram.org is unreachable the
 * first script simply fails and this file no-ops (the site still
 * works — just without Telegram theming).
 *
 * Style: plain ES5-style script on purpose (var, function — no arrow
 * functions, no async/await), like the rest of the site, so it runs
 * on the oldest WebView Telegram can open. The pure helpers are
 * exported for the Node tests (site/assets/telegram-webapp.test.mjs)
 * via the module.exports guard at the bottom.
 */
"use strict";

/** Telegram theme params → the site's CSS variables.
 *  Only #rrggbb values are accepted; anything else (missing key,
 *  wrong shape) is skipped, so a bad theme can never inject CSS.
 *  Mapping (Telegram → RliBook design system):
 *    bg_color           → --paper  (page background)
 *    secondary_bg_color → --sky-pale, --sky-light, --card-border
 *    section_bg_color   → --card   (card background; rlibook.css .card
 *                          is hardcoded white without this override)
 *    text_color         → --ink    (body text)
 *    hint_color         → --muted  (secondary text)
 *    link_color         → --link, --link-hover
 *    button_color       → --tg-button
 *    button_text_color  → --tg-button-text
 *  Returns a plain object { "--var": "#rrggbb", ... }. colorScheme
 *  ("light"/"dark") is NOT a colour — applyTheme handles it
 *  separately via the color-scheme property. */
function themeCssVars(themeParams) {
  var vars = {};
  var map = {
    bg_color: ["--paper"],
    secondary_bg_color: ["--sky-pale", "--sky-light", "--card-border"],
    section_bg_color: ["--card"],
    text_color: ["--ink"],
    hint_color: ["--muted"],
    link_color: ["--link", "--link-hover"],
    button_color: ["--tg-button"],
    button_text_color: ["--tg-button-text"],
  };
  var params = themeParams || {};
  var key;
  for (key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    var value = params[key];
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
      var targets = map[key];
      for (var i = 0; i < targets.length; i++) vars[targets[i]] = value;
    }
  }
  return vars;
}

/** True only when the page is running inside Telegram as a Mini App:
 *  window.Telegram.WebApp exists AND initData is a non-empty string.
 *  The telegram-web-app.js script defines window.Telegram.WebApp even
 *  in a plain browser, but with empty initData and platform
 *  "unknown" — so the script's presence alone is NOT detection.
 *  (initData is Telegram's signed launch data; it is present for a
 *  web_app button AND for the menu button.) */
function isTelegramWebApp(win) {
  if (!win || !win.Telegram || !win.Telegram.WebApp) return false;
  var initData = win.Telegram.WebApp.initData;
  return typeof initData === "string" && initData.length > 0;
}

/** Apply Telegram theme params to the document: set the CSS vars on
 *  <html> and the color-scheme (light/dark) so form controls and
 *  scrollbars follow the Telegram theme. Safe to call with missing
 *  or partial params — it only sets what is valid. */
function applyTheme(doc, themeParams) {
  if (!doc || !doc.documentElement) return;
  var root = doc.documentElement;
  var vars = themeCssVars(themeParams || {});
  var name;
  for (name in vars) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) continue;
    if (root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty(name, vars[name]);
    }
  }
  var scheme = (themeParams || {}).colorScheme;
  if ((scheme === "light" || scheme === "dark") && root.style) {
    root.style.colorScheme = scheme;
  }
}

/** Wire Telegram's Back button to the browser history: visible when
 *  there is a page to go back to, hidden on the entry page. Telegram
 *  shows its own back chevron; tapping it goes back in the Mini App
 *  instead of closing it. Every call is guarded — an old Telegram
 *  client without BackButton support just gets no back button. */
function wireBackButton(win, wa) {
  try {
    var back = wa.BackButton;
    if (!back || typeof back.show !== "function") return;
    var update = function () {
      try {
        if (win.history && win.history.length > 1) back.show();
        else back.hide();
      } catch (e) { /* never break the page for a back button */ }
    };
    if (typeof back.onClick === "function") {
      back.onClick(function () {
        try { win.history.back(); } catch (e) { /* nothing to go back to */ }
      });
    }
    update();
    if (win.addEventListener) {
      win.addEventListener("popstate", update);
      win.addEventListener("hashchange", update);
    }
  } catch (e) { /* never break the page for a back button */ }
}

/** The device the Mini App runs on, from Telegram.WebApp.platform
 *  (Workstream 3b). Telegram platform values: "android", "android_x",
 *  "ios" (phones), "macos", "tdesktop", "weba", "web", "webk",
 *  "unigram" (desktops), "unknown". Returns
 *  { platform, isPhone, isDesktop } — both flags false for "unknown"
 *  or a missing platform, so callers must not assume a family they
 *  cannot prove. Never throws. */
function device(wa) {
  var platform = "";
  try {
    platform = (wa && typeof wa.platform === "string") ? wa.platform : "";
  } catch (e) { platform = ""; }
  var isPhone = platform === "android" || platform === "android_x" || platform === "ios";
  var isDesktop = platform === "macos" || platform === "tdesktop"
    || platform === "weba" || platform === "web" || platform === "webk"
    || platform === "unigram";
  return { platform: platform, isPhone: isPhone, isDesktop: isDesktop };
}

/** Open a URL outside the Mini App webview (Workstream 3b). Inside
 *  Telegram this uses Telegram.WebApp.openLink(url) — Telegram
 *  opens it in the device browser (or its in-app browser, per the
 *  user's Telegram setting). Outside Telegram it falls back to a
 *  normal navigation. Never throws; returns true when an open was
 *  attempted. */
function openExternal(win, wa, url) {
  try {
    if (!url) return false;
    if (wa && typeof wa.openLink === "function") {
      wa.openLink(url);
      return true;
    }
    if (win && win.location && typeof win.location.assign === "function") {
      win.location.assign(url);
      return true;
    }
    if (win && win.location) {
      win.location.href = url;
      return true;
    }
  } catch (e) { /* never break the page for a link */ }
  return false;
}

/** Open a download (the token-gated short link, Workstream 3b).
 *  Same as openExternal: the short link MUST leave the Mini App
 *  webview, because the webview cannot be trusted with downloads
 *  (iOS WKWebView especially) — the device browser saves the file
 *  into the library (Kobo/PocketBook) or hands it to the phone for
 *  Send to Kindle for Web (Kindle). Kept as a separate name so the
 *  call sites say what they mean; the behaviour is identical. */
function openDownload(win, wa, url) {
  return openExternal(win, wa, url);
}

/** Intercept taps on a[data-tg-download] inside the Mini App and
 *  open them with openDownload() instead of following the link in
 *  the webview (Workstream 3b). A manual parent walk is used (no
 *  Element.closest — old WebViews may lack it). Only attached
 *  inside Telegram; outside, the links behave normally. Never
 *  throws. */
function wireDownloadLinks(win, doc, wa) {
  try {
    if (!doc || typeof doc.addEventListener !== "function") return;
    doc.addEventListener("click", function (ev) {
      try {
        var el = ev && ev.target;
        while (el && el !== doc) {
          if (el.tagName && String(el.tagName).toLowerCase() === "a"
            && el.getAttribute && el.getAttribute("data-tg-download") !== null) {
            var href = el.getAttribute("href") || "";
            if (!href) return;
            if (ev.preventDefault) ev.preventDefault();
            openDownload(win, wa, href);
            return;
          }
          el = el.parentNode;
        }
      } catch (e) { /* never break the page for a link */ }
    }, false);
  } catch (e) { /* never break the page for a link */ }
}

/** Main entry: init the Mini App when inside Telegram, no-op outside.
 *  Returns { isTelegram: boolean, colorScheme?: string, version?: string,
 *  device?: { platform, isPhone, isDesktop }, openExternal?: fn,
 *  openDownload?: fn } (device + openers only inside Telegram).
 *  Also sets window.RliBookTelegram so other scripts can check
 *  `window.RliBookTelegram.isTelegram` without touching window.Telegram.
 *  Never throws, never sends anything anywhere. */
function initTelegramWebApp(win, doc) {
  var result = { isTelegram: false };
  try {
    if (!isTelegramWebApp(win)) return result;
    var wa = win.Telegram.WebApp;
    result.isTelegram = true;
    result.version = typeof wa.version === "string" ? wa.version : "";
    try { wa.ready(); } catch (e) { /* older clients: ready is a no-op */ }
    try { wa.expand(); } catch (e) { /* older clients: already expanded */ }
    if (doc && doc.documentElement && doc.documentElement.classList) {
      doc.documentElement.classList.add("tg-webapp");
    }
    var params = wa.themeParams || {};
    applyTheme(doc, params);
    result.colorScheme = params.colorScheme || "";
    if (typeof wa.onEvent === "function") {
      wa.onEvent("themeChanged", function () {
        applyTheme(doc, wa.themeParams || {});
      });
    }
    // Match Telegram's own chrome to the page: header + background.
    try {
      if (typeof wa.setHeaderColor === "function") {
        wa.setHeaderColor(params.bg_color || "bg_color");
      }
      if (typeof wa.setBackgroundColor === "function") {
        wa.setBackgroundColor(params.bg_color || "bg_color");
      }
    } catch (e) { /* older clients: no header/background API */ }
    // Let the page scroll naturally; swiping down no longer closes
    // the app (Telegram 7.7+ only — guarded, older clients ignore it).
    try {
      if (typeof wa.disableVerticalSwipes === "function") wa.disableVerticalSwipes();
    } catch (e) { /* older clients: no such API */ }
    wireBackButton(win, wa);
    // Workstream 3b: device info + download-link interception.
    result.device = device(wa);
    result.openExternal = function (url) { return openExternal(win, wa, url); };
    result.openDownload = function (url) { return openDownload(win, wa, url); };
    wireDownloadLinks(win, doc, wa);
    if (win) win.RliBookTelegram = result;
  } catch (e) {
    // A Mini App init failure must never break the website itself.
    result.isTelegram = false;
  }
  return result;
}

// Auto-run in the browser (the script is loaded with defer, so the
// DOM is parsed already). In Node (tests) window/document are
// undefined and nothing runs.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  initTelegramWebApp(window, document);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    themeCssVars: themeCssVars,
    isTelegramWebApp: isTelegramWebApp,
    applyTheme: applyTheme,
    wireBackButton: wireBackButton,
    initTelegramWebApp: initTelegramWebApp,
    device: device,
    openExternal: openExternal,
    openDownload: openDownload,
    wireDownloadLinks: wireDownloadLinks,
  };
}
