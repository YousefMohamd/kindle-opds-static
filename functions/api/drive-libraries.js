// Cloudflare Pages Function: Drive library list (RliBook, WAVE 4 WS8).
// Route: GET /api/drive-libraries?fp=...
//
//   GET /api/drive-libraries
//     -> 200 { ok: true, libraries: [
//            { folder_id, title, visibility: "public", count: 397,
//              samples: ["نزهة الزمان ...", ...], mine: false }, ... ] }
//   GET /api/drive-libraries?fp=<fingerprint>
//     -> same, plus the caller's OWN private / pending_public
//        libraries (mine: true). A pending_public library is also
//        listed for the owner (mine: false, visibility shown).
//
// This is the read side of the two-type model (user decision
// 2026-11-26): a newly submitted Drive library is PRIVATE to its
// submitter until the owner approves it public from the monitor
// page (/libraries/monitor). Private libraries NEVER appear here
// for anyone but their submitter — the filter is enforced in this
// function, not trusted to the caller. The homepage Drive card and
// the bot's /mylibraries command both read this endpoint.
//
// Data: D1 `drive_libraries` (registry; see telegram/tbi/
// drive_registry.py) + `books` counts/samples. When the registry
// table does not exist yet (not applied), the reply is an honest
// empty list — never a 500. Counts are one COUNT(*) per library;
// libraries are few (one row each), so this stays far inside the
// free-tier D1 read budget.
//
// Env (Pages dashboard -> Settings -> Functions):
//   D1 binding  TG_D1       (required) — the Telegram catalog database.
//   KV binding  RLIBOOK_KV  (optional) — fingerprint verification
//                            (fp:<token> -> { tg_id }); missing -> the
//                            caller is anonymous (public only).
//   RLIBOOK_OWNER_ID (var, optional) — the owner's Telegram id, for
//                            listing pending_public libraries to them.

const FP_RE = /^[A-Za-z0-9_-]{22}$/;

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

const FOLDER_RE = /^[A-Za-z0-9_-]{10,64}$/;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const url = new URL(request.url);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });

  const db = env && env.TG_D1;
  if (!db) {
    return json({ ok: false, error: "search unavailable (TG_D1 not bound)" }, 503);
  }
  const viewerTgId = await verifyFingerprint(env, (url.searchParams.get("fp") || "").trim());
  const ownerRaw = Number((env && (env.RLIBOOK_OWNER_ID || env.OWNER_TG_ID)) || 0);
  const ownerTgId = Number.isSafeInteger(ownerRaw) && ownerRaw > 0 ? ownerRaw : 0;
  const isOwner = !!(viewerTgId && ownerTgId && viewerTgId === ownerTgId);

  let rows;
  try {
    const res = await db
      .prepare(
        "SELECT folder_id, title, added_by, added_at, status, submitter_tg_id, visibility"
        + " FROM drive_libraries ORDER BY title",
      )
      .bind().all();
    rows = res.results || [];
  } catch (e) {
    // Registry table not applied yet: honest empty list, never a 500.
    return json({ ok: true, libraries: [], registry: false });
  }

  const libraries = [];
  for (const r of rows) {
    const folderId = String(r.folder_id || "");
    if (!FOLDER_RE.test(folderId)) continue;
    const visibility = String(r.visibility || "public").toLowerCase();
    const submitter = Number(r.submitter_tg_id) || 0;
    const mine = !!(viewerTgId && submitter && viewerTgId === submitter);
    // Visibility gate (same rule as tg-search.js): public for
    // everyone; private/pending only for the submitter; pending also
    // for the owner (who reviews it). Anything else is invisible.
    if (visibility !== "public" && !mine && !(visibility === "pending_public" && isOwner)) {
      continue;
    }
    const source = "drive:" + folderId;
    let count = 0;
    let samples = [];
    try {
      const c = await db.prepare("SELECT COUNT(*) AS n FROM books WHERE source = ?")
        .bind(source).first();
      count = c ? Number(c.n) || 0 : 0;
      const s = await db.prepare("SELECT title FROM books WHERE source = ? ORDER BY id LIMIT 5")
        .bind(source).all();
      samples = (s.results || []).map((x) => x.title).filter(Boolean);
    } catch (e) {
      // A count failure must not drop the library row itself.
      count = 0;
      samples = [];
    }
    libraries.push({
      folder_id: folderId,
      title: r.title || folderId,
      visibility,
      status: r.status || "active",
      count,
      samples,
      mine,
    });
  }
  return json({ ok: true, libraries, registry: true });
}
