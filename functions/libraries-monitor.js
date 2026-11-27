// Cloudflare Pages Function: owner-only Drive library monitor (WAVE 4 WS8).
// Route: /libraries/monitor?fp=... (or ?key=...)
//
//   GET  /libraries/monitor?fp=<owner fingerprint>
//     -> 200 text/html — every Drive library: title, folder, visibility,
//        submitter, book count, unavailable count (drive_health),
//        5 sample titles. pending_public first, each with
//        Approve / Reject buttons.
//   POST /libraries/monitor (form: action=approve|reject,
//        folder_id=..., fp=... / key=...)
//     -> 303 back to the GET view. Approve sets visibility='public';
//        Reject sets visibility='private' — the library STAYS private
//        to its submitter (never deleted, never hidden from them).
//        The submitter sees the new status in the bot (/mylibraries,
//        which reads /api/drive-libraries live).
//        Build 2 (approve -> visible EVERYWHERE): the D1-backed
//        surfaces (search, /api/drive-libraries, /mylibraries) update
//        the moment this POST lands. The COMMITTED static surfaces
//        (libraries page, OPDS feeds, drive/search-index.json) cannot
//        be written from this Function, so the POST also writes a
//        `drive:surfaces-stale` KV marker {folder_id, title,
//        visibility, submitter_tg_id, at} — the telegram-drive sweep
//        consumes it (re-syncs drive-libraries.json from D1, or
//        applies this payload when the D1 read fails), regenerates
//        the public surfaces and commits them. Best-effort: a KV
//        failure never fails the approve itself — D1 is the truth.
//
// Auth (either — the owner already has both):
//   * ?fp= — the owner's catalog fingerprint, verified against KV
//     (fp:<token> -> { tg_id }) and compared to RLIBOOK_OWNER_ID.
//     Same mechanism as the private OPDS feed ([[fp]].js).
//   * ?key= — env LIBRARY_MONITOR_KEY (a shared secret set in the
//     Pages dashboard; fallback when the fingerprint is not at hand).
// Anyone else gets a 403 page that says only "for the owner" — the
// library list itself never leaks to a non-owner.
//
// Env (Pages dashboard -> Settings -> Functions):
//   D1 binding  TG_D1       (required).
//   KV binding  RLIBOOK_KV  (optional — needed for ?fp= auth).
//   RLIBOOK_OWNER_ID (var) — the owner's Telegram id.
//   LIBRARY_MONITOR_KEY (secret, optional) — fallback shared key.

const FP_RE = /^[A-Za-z0-9_-]{22}$/;
const FOLDER_RE = /^[A-Za-z0-9_-]{10,64}$/;

async function verifyFingerprint(env, fp) {
  if (!FP_RE.test(fp || "")) return null;
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get("fp:" + fp);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const id = v && Number(v.tg_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (e) {
    return null;
  }
}

// True when the request carries owner auth (fp or key). `params` is a
// URLSearchParams (GET) or a FormData-like getter (POST).
async function isOwnerAuth(env, get) {
  const fp = (get("fp") || "").trim();
  if (fp) {
    const tgId = await verifyFingerprint(env, fp);
    const ownerRaw = Number((env && (env.RLIBOOK_OWNER_ID || env.OWNER_TG_ID)) || 0);
    if (tgId && Number.isSafeInteger(ownerRaw) && ownerRaw > 0 && tgId === ownerRaw) {
      return true;
    }
  }
  const key = (get("key") || "").trim();
  const want = (env && env.LIBRARY_MONITOR_KEY) || "";
  if (key && want && key === want) return true;
  return false;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function forbidden() {
  const body = "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n<title>مكتبات Drive — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1C2826;background:#DFF1F4}"
    + "a{color:#0b5cad}</style>\n</head>\n<body>\n"
    + "<h1>مكتبات Drive</h1>\n"
    + "<p>هذه الصفحة للمالك فقط — افتحها من رابط البوت (ببصمتك)، أو أضف مفتاح المراقبة.</p>\n"
    + "<p><a href=\"/\">← الرئيسية</a></p>\n</body></html>";
  return new Response(body, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const db = env && env.TG_D1;
  if (!db) {
    return new Response("search unavailable (TG_D1 not bound)", { status: 503 });
  }

  const head = (title) => "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1C2826;background:#DFF1F4}"
    + "h1{font-size:1.4rem}a{color:#0b5cad}.btn{display:inline-block;padding:.4rem .9rem;margin:.2rem;"
    + "border-radius:6px;background:#44667b;color:#fff;text-decoration:none;font-weight:600;border:0;cursor:pointer;font-size:1rem}"
    + ".btn.danger{background:#8a3b00}.card{border:1px solid #C4E0EB;border-radius:8px;background:#fff;padding:.8rem 1rem;margin:.8rem 0}"
    + ".meta{color:#555;font-size:.9rem}.note{color:#555;font-size:.9rem}ul{margin:.3rem 0}</style>\n"
    + "</head>\n<body>\n<h1>مكتبات Drive — المراقبة</h1>\n";

  const foot = "<p class=\"note\"><a href=\"/\">← الرئيسية</a> • "
    + "<a href=\"/telegram/libraries.html\">كل المكتبات</a></p>\n</body></html>";

  if (request.method === "POST") {
    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return new Response("bad form", { status: 400 });
    }
    const get = (k) => { const v = form.get(k); return typeof v === "string" ? v : ""; };
    if (!(await isOwnerAuth(env, get))) return forbidden();
    const action = (get("action") || "").trim();
    const folderId = (get("folder_id") || "").trim();
    if ((action !== "approve" && action !== "reject") || !FOLDER_RE.test(folderId)) {
      return new Response("bad action or folder_id", { status: 400 });
    }
    const visibility = action === "approve" ? "public" : "private";
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    // The UPDATE affects 0 rows for an unknown folder — check first so
    // a typo does not silently "succeed" (WAVE 4, WS8 monitor test 6c).
    const existing = await db.prepare(
      "SELECT folder_id, title, submitter_tg_id FROM drive_libraries WHERE folder_id = ?",
    ).bind(folderId).first();
    if (!existing) return new Response("unknown folder_id", { status: 400 });
    try {
      await db.prepare(
        "UPDATE drive_libraries SET visibility = ?, reviewed_at = ? WHERE folder_id = ?",
      ).bind(visibility, now, folderId).run();
    } catch (e) {
      return new Response("registry update failed — is the drive_libraries table applied?", { status: 500 });
    }
    // Build 2: tell the telegram-drive sweep the static surfaces
    // are stale. Best-effort — the D1 update above already landed,
    // and the sweep re-syncs from D1 anyway; a KV failure here must
    // never turn a successful approve into an error.
    try {
      const kv = env && env.RLIBOOK_KV;
      if (kv && typeof kv.put === "function") {
        await kv.put("drive:surfaces-stale", JSON.stringify({
          folder_id: folderId,
          title: existing.title || "",
          visibility,
          submitter_tg_id: existing.submitter_tg_id ?? null,
          at: now,
        }));
      }
    } catch (e) { /* marker is best-effort; D1 is the truth */ }
    // POST-redirect-GET: back to the list, keeping the same auth.
    const back = new URL("/libraries/monitor", url.origin);
    if (get("fp")) back.searchParams.set("fp", get("fp"));
    if (get("key")) back.searchParams.set("key", get("key"));
    return new Response(null, { status: 303, headers: { location: back.toString() } });
  }

  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  const get = (k) => url.searchParams.get(k) || "";
  if (!(await isOwnerAuth(env, get))) return forbidden();

  let rows;
  try {
    const res = await db.prepare(
      "SELECT folder_id, title, added_by, added_at, status, submitter_tg_id, visibility, requested_at, reviewed_at"
      + " FROM drive_libraries ORDER BY"
      + " CASE visibility WHEN 'pending_public' THEN 0 WHEN 'private' THEN 1 WHEN 'public' THEN 2 WHEN 'unavailable' THEN 3 ELSE 4 END, title",
    ).bind().all();
    rows = res.results || [];
  } catch (e) {
    const body = head("مكتبات Drive")
      + "<p>جدول drive_libraries غير موجود بعد — طبّق ملف التسجيل (registry SQL) على D1 أولاً.</p>\n"
      + foot;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const fp = (get("fp") || "").trim();
  const key = (get("key") || "").trim();
  const authHidden = (fp ? "<input type=\"hidden\" name=\"fp\" value=\"" + esc(fp) + "\">" : "")
    + (key ? "<input type=\"hidden\" name=\"key\" value=\"" + esc(key) + "\">" : "");

  let body = head("مكتبات Drive — المراقبة");
  body += "<p class=\"note\">الموافقة تجعل المكتبة عامة للجميع. الرفض يُبقيها خاصة "
    + "بصاحبها (لا تُحذف أبداً، ولا تُخفى عنه). الكتب الميتة الرابط تظهر "
    + "«غير متاح» ولا تُحذف ميتاداتاها.</p>\n";
  if (rows.length === 0) {
    body += "<p>لا مكتبات Drive مسجلة بعد.</p>\n" + foot;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  for (const r of rows) {
    const folderId = String(r.folder_id || "");
    const visibility = String(r.visibility || "public");
    const source = "drive:" + folderId;
    let count = 0;
    let unavailable = 0;
    let samples = [];
    try {
      const c = await db.prepare("SELECT COUNT(*) AS n FROM books WHERE source = ?")
        .bind(source).first();
      count = c ? Number(c.n) || 0 : 0;
      const s = await db.prepare("SELECT title FROM books WHERE source = ? ORDER BY id LIMIT 5")
        .bind(source).all();
      samples = (s.results || []).map((x) => x.title).filter(Boolean);
    } catch (e) { /* counts degrade to 0, the row still shows */ }
    try {
      const u = await db.prepare(
        "SELECT COUNT(*) AS n FROM books b JOIN drive_health h ON h.url = b.url AND h.available = 0 WHERE b.source = ?",
      ).bind(source).first();
      unavailable = u ? Number(u.n) || 0 : 0;
    } catch (e) { unavailable = 0; }
    const visAr = visibility === "public" ? "عامة" : visibility === "private" ? "خاصة"
      : visibility === "pending_public" ? "بانتظار النشر"
      : visibility === "removed" ? "أُزيلت — مخفية، الميتاداتا محفوظة"
      : visibility === "unavailable" ? "غير متاحة — المجلد ميت/مش متشارك"
      : "بانتظار النشر";
    body += "<div class=\"card\"><h2>" + esc(r.title || folderId) + "</h2>\n"
      + "<p class=\"meta\">الحالة: <b>" + esc(visAr) + "</b> • " + count + " كتاب"
      + (unavailable ? " • " + unavailable + " غير متاح" : "")
      + " • أضافها: " + esc(String(r.submitter_tg_id || r.added_by || "؟"))
      + (r.added_at ? " • " + esc(String(r.added_at).slice(0, 10)) : "")
      + (r.requested_at ? " • طُلب النشر: " + esc(String(r.requested_at).slice(0, 10)) : "")
      + "</p>\n"
      + "<p class=\"meta\">المجلد: <a href=\"https://drive.google.com/drive/folders/" + esc(folderId) + "\">"
      + esc(folderId) + "</a> • "
      + "<a href=\"/telegram/?source=" + esc(encodeURIComponent(source)) + "\">تصفّح الكتب</a></p>\n";
    if (samples.length) {
      body += "<ul>\n" + samples.map((t) => "<li>" + esc(t) + "</li>").join("\n") + "\n</ul>\n";
    }
    if (visibility === "pending_public") {
      body += "<form method=\"post\" action=\"/libraries/monitor\">" + authHidden
        + "<input type=\"hidden\" name=\"folder_id\" value=\"" + esc(folderId) + "\">"
        + "<button class=\"btn\" type=\"submit\" name=\"action\" value=\"approve\">✅ موافقة — اجعلها عامة</button> "
        + "<button class=\"btn danger\" type=\"submit\" name=\"action\" value=\"reject\">✖️ رفض — تبقى خاصة</button></form>\n";
    }
    body += "</div>\n";
  }
  body += foot;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
