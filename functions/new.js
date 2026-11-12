// Cloudflare Pages Function: newest-books page (RliBook).
// Route: GET /new
//
//   GET /new
//     -> 200 text/html — the newest 30 books added to the catalog:
//        title, author, source, format, post date, a link to the
//        Telegram source post. No JavaScript, minimal CSS, tiny page —
//        built for the Kindle experimental browser. Same style as
//        functions/book.js.
//
// Data: the static file /telegram/newest.json — newest 30 books,
// generated at publish time by telegram/tbi/newest.py (a full scan of
// the Telegram shards, sorted by post date; ~5.5 KB). The Function
// fetches ONLY that tiny file, never a shard.
//
// Why not the shards directly: each shard is ~19 MiB (64 MiB total),
// grouped by source and newest-first only WITHIN a source, so the
// global newest books are scattered through them; a Function cannot
// fetch + parse one (CDN ignores Range, ~10 ms CPU on the free tier —
// see functions/api/tg-search.js). The OPDS search indexes carry no
// date at all. The daily manifest (/telegram/index.json) has totals
// and per-source post IDs, but no titles or dates.
//
// Live additions: when the real-time sync writer is deployed it
// writes new books to the RLIBOOK_KV key "live:additions" (see
// telegram/tbi/live.py — newest first, capped at 500). If that KV
// binding exists AND the key has books, they are prepended (they are
// newer than the last daily publish). The writer is NOT deployed yet
// (2026-11-12), so today the key is empty/absent and the page is
// exactly the static file. A missing KV binding is not an error.
//
// Honesty: when newest.json is missing (not yet published) AND there
// are no live books, the page says so plainly and links to
// /telegram/ and /book instead of inventing a list.
//
// The books here are Telegram-catalog books, NOT the five OPDS
// libraries — so they do NOT link to /book?q= (that page would return
// its no-match page). Each book links to its Telegram source post,
// and the page says the bot can send it to the Kindle.
//
// Free-tier friendly: one ~5.5 KB static fetch + at most one KV get.
// No D1, no catalog fetch, no heavy work.

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const LIVE_KEY = "live:additions";

// The one line the user asked for: the dictionary updates weekly,
// and this page always holds the newest books.
const WEEKLY_NOTICE = "القاموس يتحدث أسبوعياً — هذه الصفحة فيها أحدث الكتب دائماً";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A newest.json book: {title, author, source, format, date, url}.
function normStatic(b) {
  if (!b || typeof b.title !== "string" || !b.title.trim()) return null;
  return {
    title: b.title.trim(),
    author: (b.author || "").trim(),
    source: (b.source || "").trim(),
    format: String(b.format || "").trim().toUpperCase(),
    date: String(b.date || "").slice(0, 10),
    url: (b.url || "").trim(),
  };
}

// A live:additions LiveBook: {title, author, source, format, date,
// added_at, url, ...} — same shape after normalizing the date.
function normLive(b) {
  const n = normStatic(b);
  if (!n) return null;
  if (!n.date && b.added_at) n.date = String(b.added_at).slice(0, 10);
  return n;
}

// Read live additions from KV (optional binding). Empty when the
// binding is missing, the key is absent, or the value is malformed.
async function readLive(env) {
  const kv = env && env.RLIBOOK_KV;
  if (!kv || typeof kv.get !== "function") return [];
  try {
    const raw = await kv.get(LIVE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    const list = data && Array.isArray(data.books) ? data.books : [];
    const out = [];
    for (const b of list) {
      const n = normLive(b);
      if (n) out.push(n);
    }
    return out;
  } catch (e) {
    return [];
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, limitRaw))
    : DEFAULT_LIMIT;

  const head = (title) => "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n"
    + "<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<title>" + esc(title) + " — RliBook</title>\n"
    + "<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;"
    + "margin:0 auto;padding:1rem;line-height:1.7;color:#1c1c1c;background:#fdfdf8}"
    + "h1{font-size:1.4rem;margin-bottom:.2rem}h2{font-size:1.1rem;margin:.6rem 0 .2rem}"
    + "a{color:#0b5cad}.btn{display:inline-block;padding:.5rem 1rem;margin:.3rem 0;"
    + "border-radius:6px;background:#0b5cad;color:#fff;text-decoration:none;font-weight:600}"
    + ".card{border:1px solid #ccc;border-radius:8px;background:#fff;padding:.8rem 1rem;margin:.8rem 0}"
    + ".note{color:#555;font-size:.9rem}</style>\n</head>\n<body>\n"
    + "<h1>📚 RliBook</h1>\n";

  const foot = "<p class=\"note\"><a href=\"/\">الرئيسية</a> · "
    + "<a href=\"/book\">بحث</a> · "
    + "<a href=\"/telegram/\">فهرس تيليجرام</a> · "
    + "<a href=\"https://t.me/RliBook_bot\">البوت @RliBook_bot</a></p>\n"
    + "</body></html>";

  // 1. Static newest file (the real source today).
  let books = [];
  let generatedAt = "";
  try {
    const res = await fetch(new URL("/telegram/newest.json", url.origin).toString(),
      { headers: { accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.books)) {
        for (const b of data.books) {
          const n = normStatic(b);
          if (n) books.push(n);
        }
      }
      if (data && typeof data.generated_at === "string") generatedAt = data.generated_at;
    }
  } catch (e) {
    // Fetch failure -> fall through to the live list / honest fallback.
    books = [];
  }

  // 2. Live additions (empty until the real-time writer is deployed).
  const live = await readLive(env);
  if (live.length > 0) {
    const seen = new Set(books.map((b) => b.url).filter(Boolean));
    const merged = [];
    for (const b of live) {
      if (b.url && seen.has(b.url)) continue;
      seen.add(b.url);
      merged.push(b);
    }
    books = merged.concat(books);
  }
  books = books.slice(0, limit);

  const headers = {
    "content-type": "text/html; charset=utf-8",
    // Regenerated daily; live additions (when they exist) are at most
    // a few minutes stale behind this cache.
    "cache-control": "public, max-age=300, must-revalidate",
  };

  if (books.length === 0) {
    const body = head("أحدث الكتب")
      + "<h2>🆕 أحدث الكتب</h2>\n"
      + "<p>" + esc(WEEKLY_NOTICE) + "</p>\n"
      + "<p>قائمة أحدث الكتب لم تُنشر بعد — تُبنى مع كل تحديث أسبوعي "
      + "للقاموس، وستظهر هنا فور نشرها.</p>\n"
      + "<p>إلى ذلك الحين: <a href=\"/telegram/\">فهرس تيليجرام</a> "
      + "فيه كل الكتب، و<a href=\"/book\">البحث</a> يبحث في المكتبات الخمس.</p>\n"
      + foot;
    return new Response(body, { headers });
  }

  let body = head("أحدث الكتب")
    + "<h2>🆕 أحدث الكتب</h2>\n"
    + "<p>" + esc(WEEKLY_NOTICE) + "</p>\n"
    + "<p>أحدث " + books.length + " كتاب أُضيفت إلى الكتالوج"
    + (generatedAt ? " — آخر تحديث " + esc(generatedAt.slice(0, 10)) : "")
    + ":</p>\n";
  for (const b of books) {
    body += "<div class=\"card\"><h2>" + esc(b.title) + "</h2>\n";
    if (b.author) body += "<p>المؤلف: " + esc(b.author) + "</p>\n";
    const meta = [b.source, b.format, b.date].filter(Boolean).join(" · ");
    if (meta) body += "<p>" + esc(meta) + "</p>\n";
    if (b.url) {
      body += "<p><a class=\"btn\" href=\"" + esc(b.url) + "\">المصدر في تليجرام</a></p>\n";
    }
    body += "</div>\n";
  }
  body += "<p class=\"note\">هذه كتب من فهرس تيليجرام — لتصلك على كيندلك، "
    + "اطلب الكتاب من <a href=\"https://t.me/RliBook_bot\">البوت @RliBook_bot</a>.</p>\n"
    + foot;
  return new Response(body, { headers });
}
