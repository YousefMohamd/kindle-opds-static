#!/usr/bin/env python3
"""Regenerate site/telegram/libraries.html from site/telegram/index.json.

The manifest (index.json) is the source of truth: 51 channels + 168
groups, with per-source post/file counts. Run from the repo root:

    python3 scripts/generate-libraries.py

Re-run whenever index.json is regenerated (the indexer export), so the
list, counts and totals stay in sync. The page is plain static HTML
(no JS at all) so it works in the Kindle browser. Each entry links to
  * /telegram/?source=<handle> — search that library's books on the site
    (the gated catalog — the ONLY link out of an entry)

There is deliberately NO link to the channel/group itself
(https://t.me/<handle>): a channel link lets a reader join the channel
and download books straight from Telegram, bypassing the download gate
(5/day cap + token). Library names and counts stay public; the channel
handles stay in the manifest (index.json) for the bot and OPDS feeds,
which still use them internally.

Options (the daily telegram-sync workflow regenerates the page from the
NEW staging manifest, before the staging directory is published):

    python3 scripts/generate-libraries.py \
        --manifest site/telegram.new/index.json \
        --out site/telegram.new/libraries.html

With no options it reads site/telegram/index.json and writes
site/telegram/libraries.html, as before. The totals line is derived
from the manifest's own totals — no number is hardcoded here.
"""
import argparse
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "site" / "telegram" / "index.json"
OUT = ROOT / "site" / "telegram" / "libraries.html"

BRAND = """  :root { color-scheme: light; }
  body { font-family: system-ui, "Segoe UI", Tahoma, sans-serif;
         max-width: 760px; margin: 0 auto; padding: 1.2rem;
         line-height: 1.7; color: #1C2826; background: #DFF1F4; }
  h1 { font-size: 1.5rem; margin-bottom: 0.2rem; }
  h2 { font-size: 1.15rem; margin: 1.4rem 0 0.4rem;
       border-bottom: 2px solid #93D4EF; padding-bottom: 0.2rem; }
  .sub { color: #44402F; font-size: 0.95rem; margin-top: 0; }
  .note { color: #44402F; font-size: 0.9rem; }
  a { color: #44667b; }
  ul { list-style: none; padding: 0; }
  li { background: #fff; border: 1px solid #C4E0EB; border-radius: 8px;
       padding: 0.7rem 1rem; margin: 0.5rem 0; }
  .name { font-weight: 700; }
  .meta { color: #44402F; font-size: 0.9rem; }
  .links a { margin-inline-end: 1rem; }
  .btn { display: inline-block; padding: 0.6rem 1.1rem; margin: 0.3rem 0;
         border-radius: 6px; background: #44667b; color: #fff;
         text-decoration: none; font-weight: 600; }
  footer { margin-top: 2rem; color: #44402F; font-size: 0.85rem;
           border-top: 1px solid #C4E0EB; padding-top: 0.8rem; }"""


def entry(s):
    name = s["name"]
    files = s.get("files", 0)
    posts = s.get("posts", 0)
    count = f"{files:,} كتاب" if files else "لا كتب مفهرسة بعد"
    return (
        f'  <li><div class="name">{html.escape(name)}</div>\n'
        f'    <div class="meta">{count} • {posts:,} منشور</div>\n'
        f'    <div class="links"><a href="/telegram/?source={html.escape(name, quote=True)}">'
        f"كتب المكتبة ←</a></div></li>\n"
    )


def section(title, sources):
    items = "\n".join(entry(s) for s in sources)
    return f"<h2>{title} ({len(sources)})</h2>\n<ul>\n{items}\n</ul>\n"



def drive_entry(lib, count):
    """One Drive library row: title, book count, browse + folder links.

    Only PUBLIC libraries are ever listed here (the caller filters);
    a private/pending library must not appear on this public page.
    The browse link goes to /telegram/?source=drive:<folderId>, which
    the Telegram search page serves from the live D1-backed API
    (static shards hold no Drive books).
    """
    fid = lib["folder_id"]
    title = lib.get("title") or fid
    count_txt = f"{count:,} كتاب" if count else "لا كتب مفهرسة بعد"
    return (
        f'  <li><div class="name">📁 {html.escape(title)}</div>\n'
        f'    <div class="meta">{count_txt} • مكتبة Drive</div>\n'
        f'    <div class="links"><a href="/telegram/?source=drive%3A{html.escape(fid, quote=True)}">'
        f"كتب المكتبة ←</a>"
        f'<a href="https://drive.google.com/drive/folders/{html.escape(fid, quote=True)}">'
        f"فتح في Drive ↗</a></div></li>\n"
    )


def drive_section(libraries, counts):
    """The Drive section (public libraries only). Empty when none."""
    rows = []
    for lib in sorted(libraries, key=lambda l: (l.get("title") or l["folder_id"]).lower()):
        if (lib.get("visibility") or "public").strip().lower() != "public":
            continue
        if lib.get("status", "active") != "active":
            continue
        rows.append(drive_entry(lib, counts.get(lib["folder_id"], 0)))
    if not rows:
        return ""
    return ("<h2>مكتبات Drive (%d)</h2>\n<p class=\"note\">مكتبات Google Drive "
            "مفهرسة كميتاداتا فقط — الكتب تُرسل بالإيميل أو تُقرأ أونلاين "
            "من صفحة الكتاب، مثل كتب تيليجرام.</p>\n<ul>\n%s\n</ul>\n"
            % (len(rows), "\n".join(rows)))


def main():
    parser = argparse.ArgumentParser(
        description="Regenerate site/telegram/libraries.html from the manifest."
    )
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--drive-registry", type=Path,
                        default=ROOT / "drive-libraries.json",
                        help="Drive registry JSON (public libraries get a "
                             "section; private/pending are never listed)")
    parser.add_argument("--drive-counts", type=Path, default=None,
                        help="JSON {folder_id: book count} for Drive rows "
                             "(e.g. counted from the D1 batch)")
    args = parser.parse_args()
    manifest_path = args.manifest
    out_path = args.out
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    sources = data["sources"]
    totals = data.get("totals", {})
    drive_libs = []
    drive_counts = {}
    if args.drive_registry and args.drive_registry.exists():
        drive_libs = json.loads(
            args.drive_registry.read_text(encoding="utf-8")).get("libraries", [])
    if args.drive_counts and args.drive_counts.exists():
        drive_counts = json.loads(
            args.drive_counts.read_text(encoding="utf-8"))
    channels = sorted(
        (s for s in sources if s.get("kind") == "channel"),
        key=lambda s: s["name"].lower(),
    )
    groups = sorted(
        (s for s in sources if s.get("kind") == "group"),
        key=lambda s: s["name"].lower(),
    )
    generated = data.get("generated_at", "")[:10]
    books = totals.get("books", 0)
    files = totals.get("files", 0)

    doc = f"""<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>مكتبات تلجرام — Telegram Libraries — RliBook</title>
<style>
{BRAND}
</style>
<!-- Telegram Mini App (v4.8.44): the official Telegram WebApp script + RliBook's init
     (theme, Back button, viewport). No-ops outside Telegram. -->
<script src="https://telegram.org/js/telegram-web-app.js" defer></script>
<script src="/site/assets/telegram-webapp.js" defer></script>
</head>
<body>
<h1>مكتبات تلجرام</h1>
<p class="sub">Telegram Libraries — كل قنوات وجروبات تيليجرام المفهرسة في RliBook:
{len(sources)} مكتبة، {books:,} كتاب مميز، {files:,} ملف.</p>
<p><a class="btn" href="/telegram/">ابحث في كل المكتبات ←</a></p>
<p class="note">اضغط «كتب المكتبة» لتصفّح كتب تلك المكتبة وحدها في فهرس
RliBook. الكتب كلها روابط إلى منشورات تيليجرام — لا ملفات كتب مستضافة
هنا.</p>
{section("قنوات", channels)}
{section("جروبات", groups)}
{drive_section(drive_libs, drive_counts)}
<footer>
  <p>القائمة مولّدة من فهرس تيليجرام (آخر تحديث: {generated}). لإعادة التوليد:
  <code>python3 scripts/generate-libraries.py</code></p>
  <p><a href="/">← الصفحة الرئيسية</a> • <a href="/telegram/">بحث تيليجرام</a> •
  <a href="https://t.me/RliBook_bot">بوت RliBook @RliBook_bot</a></p>
</footer>
</body>
</html>
"""
    out_path.write_text(doc, encoding="utf-8")
    print(f"wrote {out_path} ({len(sources)} sources: {len(channels)} channels, {len(groups)} groups)")


if __name__ == "__main__":
    sys.exit(main())
