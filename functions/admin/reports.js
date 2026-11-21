// Cloudflare Pages Function: owner-only reports / flags monitor page
// (RliBook, 2026-11-21).
// Route: GET /admin/reports
//
//   GET /admin/reports[?fp=<fingerprint>]
//     -> 200 text/html — the monitor: pending reports with
//        Approve / Reject, flagged books with Un-flag / Hide,
//        hidden books with Un-hide, and the decisions log.
//        Channel names and post links appear here ONLY because
//        the page is owner-gated (standing source-hiding rule).
//     -> 403 text/html — anyone else (unknown / revoked /
//        non-owner fingerprint, or none at all): no data, only
//        how the owner opens the page.
//
// OWNER GATE: the same fingerprint check as
// functions/api/admin-reports.js (verifyOwner — fp:<token> in the
// shared RLIBOOK_KV must belong to OWNER_TG_ID). The fingerprint
// arrives via ?fp= (the catalog file's website links carry it) or
// the rlb_fp cookie set by /api/identify; a successful ?fp= visit
// sets the cookie, so later visits need no parameter. Fail CLOSED:
// no KV -> 503, gate failure -> 403, KV list() unavailable -> 503.
//
// ACTIONS: the buttons POST to /api/admin-reports (same origin,
// fetch — the page is for the owner's modern browser, phone or
// computer, not the Kindle experimental browser) and reload on
// success. The lists themselves are server-rendered, so viewing
// needs no JavaScript. All data flows through the API module's
// readers — this file renders, it never touches KV directly
// except through the shared gate + readers.
//
// Env: RLIBOOK_KV (required) — the SAME KV namespace the bot uses.

import {
  fingerprintFromRequest,
  verifyOwner,
  readPendingReports,
  readFlaggedBooks,
  readHiddenBooks,
  readDecisions,
  canList,
} from "../api/admin-reports.js";
import { cookieHeader } from "../api/identify.js";

const REASON_LABELS = {
  commercial: "إصدار حديث ما زال يُباع",
  wronginfo: "معلومات خاطئة",
  offensive: "محتوى مسيء",
  other: "سبب آخر",
};

const ACTION_LABELS = {
  flag: "تعليم 🚩",
  unflag: "إلغاء العلامة",
  hide: "إخفاء",
  unhide: "إظهار",
  approved: "موافقة (تعليم 🚩)",
  rejected: "رفض",
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function fmtAt(iso) {
  if (!iso) return "—";
  return String(iso).slice(0, 16).replace("T", " ");
}

function postLink(handle, postId) {
  return `https://t.me/${handle}/${postId}`;
}

function head(title) {
  return "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
    + "h1{font-size:1.4rem;margin-bottom:.2rem}h2{font-size:1.15rem;margin:1.2rem 0 .3rem}"
    + "a{color:#0b5cad}.btn{display:inline-block;padding:.4rem .9rem;margin:.2rem .2rem .2rem 0;"
    + "border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;font-weight:600;border:0;cursor:pointer;font-size:1rem}"
    + ".btn.danger{background:#a11}.btn:disabled{opacity:.5;cursor:default}"
    + ".card{border:1px solid #ccc;border-radius:8px;background:#fff;padding:.8rem 1rem;margin:.8rem 0}"
    + ".note{color:#555;font-size:.9rem}.meta{color:#555;font-size:.9rem}"
    + "#status{font-weight:700}</style>\n</head>\n<body>\n"
    + "<h1>مراقبة البلاغات والعلامات</h1>\n";
}

const foot = "<p class=\"note\"><a href=\"/\">الرئيسية</a></p>\n"
  + "</body></html>";

function deniedPage() {
  return head("للمالك فقط")
    + "<p>هذه الصفحة للمالك فقط — لا تعرض أي بيانات دون بصمة المالك.</p>\n"
    + "<p>للدخول: افتح الصفحة من ملف الكتالوج (الرابط يحمل بصمتك)، "
    + "أو خذ كوداً من البوت بأمر /link ثم افتح "
    + "<a href=\"/api/identify\">/api/identify?code=XXXXXX</a> "
    + "مرة واحدة، ثم عُد إلى هنا.</p>\n"
    + foot;
}

function pendingCard(r) {
  const reason = REASON_LABELS[r.reason] || esc(r.reason || "");
  const detail = r.reasonText ? " — “" + esc(r.reasonText) + "”" : "";
  return "<div class=\"card\"><h2>" + esc(r.title || "بدون عنوان") + "</h2>\n"
    + (r.author ? "<p>المؤلف: " + esc(r.author) + "</p>\n" : "")
    + "<p class=\"meta\">المصدر: " + esc(r.source || r.handle || "")
    + " · <a href=\"" + esc(postLink(r.handle, r.postId)) + "\">"
    + esc(r.handle + "/" + r.postId) + "</a>"
    + " · المُبلِّغ: " + esc(r.reporterId)
    + " · " + esc(fmtDate(r.createdAt)) + "</p>\n"
    + "<p>السبب: " + reason + detail + "</p>\n"
    + "<p><button class=\"btn\" data-action=\"approve\" data-rid=\"" + esc(r.rid) + "\">✅ موافقة — علّم الكتاب 🚩</button>"
    + "<button class=\"btn danger\" data-action=\"reject\" data-rid=\"" + esc(r.rid) + "\">❌ رفض</button></p>\n"
    + "<p class=\"note\">الموافقة تعلّم الكتاب (🚩) وتلغي حظر الـ 72 ساعة؛ الرفض يغلق البلاغ دون تعليم. القرار يُبلَّغ للمُبلِّغ من البوت.</p>\n"
    + "</div>\n";
}

function flaggedCard(b) {
  const l = b.ledger;
  const ledgerLine = l
    ? "<p class=\"meta\">آخر قرار: " + esc(ACTION_LABELS[l.action] || l.action)
      + (l.reason ? " — " + esc(l.reason) : "")
      + (l.source ? " (" + esc(l.source) + ")" : "")
      + " · " + esc(fmtAt(l.at)) + "</p>\n"
    : "";
  return "<div class=\"card\"><h2>" + esc(b.handle + "/" + b.postId) + "</h2>\n"
    + "<p><a href=\"" + esc(postLink(b.handle, b.postId)) + "\">" + esc(postLink(b.handle, b.postId)) + "</a></p>\n"
    + ledgerLine
    + "<p><button class=\"btn\" data-action=\"unflag\" data-handle=\"" + esc(b.handle) + "\" data-post=\"" + esc(b.postId) + "\">إلغاء العلامة</button>"
    + "<button class=\"btn danger\" data-action=\"hide\" data-handle=\"" + esc(b.handle) + "\" data-post=\"" + esc(b.postId) + "\">إخفاء الكتاب</button></p>\n"
    + "</div>\n";
}

function hiddenCard(b) {
  const l = b.ledger;
  const kind = b.manual ? "إخفاء يدوي" : "إخفاء من بلاغ";
  const ledgerLine = l
    ? "<p class=\"meta\">آخر قرار: " + esc(ACTION_LABELS[l.action] || l.action)
      + (l.reason ? " — " + esc(l.reason) : "")
      + " · " + esc(fmtAt(l.at)) + "</p>\n"
    : "";
  return "<div class=\"card\"><h2>" + esc(b.handle + "/" + b.postId) + "</h2>\n"
    + "<p><a href=\"" + esc(postLink(b.handle, b.postId)) + "\">" + esc(postLink(b.handle, b.postId)) + "</a></p>\n"
    + "<p class=\"meta\">" + esc(kind) + "</p>\n"
    + ledgerLine
    + "<p><button class=\"btn\" data-action=\"unhide\" data-handle=\"" + esc(b.handle) + "\" data-post=\"" + esc(b.postId) + "\">إظهار الكتاب</button></p>\n"
    + "</div>\n";
}

function decisionRow(d) {
  const label = ACTION_LABELS[d.action] || esc(d.action);
  const what = d.title ? "«" + esc(d.title) + "»" : esc(d.handle + "/" + d.postId);
  const extra = d.kind === "ledger" && d.source ? " (" + esc(d.source) + ")" : "";
  return "<li>" + esc(fmtAt(d.at)) + " — <b>" + label + "</b> — " + what
    + (d.reason ? " — " + esc(d.reason) : "") + extra
    + (d.by ? " · بواسطة " + esc(d.by) : "") + "</li>\n";
}

const PAGE_SCRIPT = "<script>\n"
  + "(function(){\n"
  + "  var fp = new URLSearchParams(location.search).get('fp') || '';\n"
  + "  var statusEl = document.getElementById('status');\n"
  + "  function say(t){ if(statusEl) statusEl.textContent = t; }\n"
  + "  document.querySelectorAll('button[data-action]').forEach(function(btn){\n"
  + "    btn.addEventListener('click', function(){\n"
  + "      var action = btn.getAttribute('data-action');\n"
  + "      var body = { action: action };\n"
  + "      if (btn.getAttribute('data-rid')) body.rid = btn.getAttribute('data-rid');\n"
  + "      if (btn.getAttribute('data-handle')) body.handle = btn.getAttribute('data-handle');\n"
  + "      if (btn.getAttribute('data-post')) body.postId = btn.getAttribute('data-post');\n"
  + "      btn.disabled = true;\n"
  + "      say('جارٍ التنفيذ…');\n"
  + "      var url = '/api/admin-reports' + (fp ? '?fp=' + encodeURIComponent(fp) : '');\n"
  + "      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })\n"
  + "        .then(function(res){ return res.json().then(function(d){ return { res: res, d: d }; }); })\n"
  + "        .then(function(out){\n"
  + "          if (out.res.ok && out.d.ok) { location.reload(); return; }\n"
  + "          say('تعذّر التنفيذ: ' + (out.d.error || out.res.status) + (out.d.partial ? ' — القرار تم لكن flags:all لم يُحدَّث، جرّب مجدداً' : ''));\n"
  + "          btn.disabled = false;\n"
  + "        })\n"
  + "        .catch(function(){ say('تعذّر الاتصال — تحقق من الإنترنت وحاول مجدداً.'); btn.disabled = false; });\n"
  + "    });\n"
  + "  });\n"
  + "})();\n"
  + "</script>\n";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!env.RLIBOOK_KV) {
    return new Response(
      head("الخدمة غير جاهزة")
      + "<p>المراقبة غير مهيأة بعد على الخادم (لا يوجد ربط KV).</p>\n" + foot,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  const kv = env.RLIBOOK_KV;
  const fp = fingerprintFromRequest(request);
  const gate = await verifyOwner(env, fp);
  if (!gate.ok) {
    const status = gate.error === "E_KV" ? 503 : 403;
    const body = gate.error === "E_KV"
      ? head("تعذّر التحقق")
        + "<p>تعذّر التحقق من البصمة — حاول مجدداً بعد قليل.</p>\n" + foot
      : deniedPage();
    return new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!canList(kv)) {
    return new Response(
      head("القائمة غير متاحة")
      + "<p>قوائم KV غير متاحة الآن — حاول مجدداً بعد قليل.</p>\n" + foot,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  let pending, flagged, hidden, decisions;
  try {
    ({ reports: pending } = await readPendingReports(kv, true));
    flagged = await readFlaggedBooks(kv);
    hidden = await readHiddenBooks(kv);
    decisions = await readDecisions(kv);
  } catch (e) {
    return new Response(
      head("تعذّر القراءة")
      + "<p>تعذّرت قراءة قوائم المراقبة — حاول مجدداً بعد قليل.</p>\n" + foot,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  if (flagged === null || hidden === null || decisions === null) {
    return new Response(
      head("القائمة غير متاحة")
      + "<p>قوائم KV غير متاحة الآن — حاول مجدداً بعد قليل.</p>\n" + foot,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  // A successful ?fp= visit sets the rlb_fp cookie (like
  // /api/identify), so later visits need no parameter.
  const url = new URL(request.url);
  if ((url.searchParams.get("fp") || "").trim()) {
    headers["set-cookie"] = cookieHeader(fp);
  }

  let body = head("مراقبة البلاغات والعلامات")
    + "<p id=\"status\" role=\"status\"></p>\n"
    + "<p class=\"note\">صفحة المالك فقط — البلاغات المعلّقة، والكتب المعلَّمة 🚩، والكتب المخفية، وسجل القرارات. القرارات هنا هي نفس قرارات أوامر البوت /reports و /flags و /hide و /unhide.</p>\n";

  body += "<h2>بلاغات معلّقة (" + pending.length + ")</h2>\n";
  if (pending.length === 0) {
    body += "<p class=\"note\">لا توجد بلاغات معلّقة — كل البلاغات محسومة.</p>\n";
  } else {
    for (const r of pending) body += pendingCard(r);
  }

  body += "<h2>كتب معلَّمة 🚩 (" + flagged.length + ")</h2>\n";
  if (flagged.length === 0) {
    body += "<p class=\"note\">لا توجد كتب معلَّمة.</p>\n";
  } else {
    for (const b of flagged) body += flaggedCard(b);
  }

  body += "<h2>كتب مخفية (" + hidden.length + ")</h2>\n";
  if (hidden.length === 0) {
    body += "<p class=\"note\">لا توجد كتب مخفية.</p>\n";
  } else {
    for (const b of hidden) body += hiddenCard(b);
  }

  body += "<h2>سجل القرارات (أحدث " + decisions.length + ")</h2>\n";
  if (decisions.length === 0) {
    body += "<p class=\"note\">لا توجد قرارات بعد.</p>\n";
  } else {
    body += "<ul>\n";
    for (const d of decisions) body += decisionRow(d);
    body += "</ul>\n";
  }

  body += PAGE_SCRIPT + foot;
  return new Response(body, { status: 200, headers });
}
