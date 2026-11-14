"""RliBook notebook EPUB generator (Block 14).

Builds a designed notebook as an EPUB "book" the user writes notes in:

* RliBook name + bird mark on top of every page (text mark — no image
  file, so the EPUB stays small and works on any reader).
* NUMBERED lines on every page — the number is at 5% opacity
  (``opacity: 0.05`` in ``OEBPS/style.css``), very faint by design,
  so the numbers guide the eye without competing with the handwriting.
* One XHTML file per page + a title page, EPUB 3 with an EPUB 2 NCX
  for older Kindles. Pure standard library — no dependencies.

Who it is for (also stated on the notebook page, site/notebook/):

* Kindle Scribe (has a pen): the notebook is made for handwriting —
  write on the lines with the pen.
* Any other Kindle / reader (no pen): select a line and add a note
  with the reader's built-in note feature.

Delivery is the same system as the Qurans: the bot sends the EPUB by
email (Send-to-Kindle) or the user copies it by USB into ``documents/``.
The bot button for it is a v4.8.43 follow-up (see blocks-open-questions.md);
this module only builds the file.

Usage:
    python -m tbi.notebook --pages 50 --lines 24 -o rlibook-notebook.epub
"""

from __future__ import annotations

import argparse
import uuid
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

TITLE = "RliBook Notebook — دفتر الملاحظات"
LANGUAGE = "ar"
DEFAULT_PAGES = 50
DEFAULT_LINES = 24

# The line-number opacity: 5% — very faint, by the user's spec.
LINE_NUMBER_OPACITY = "0.05"

CSS = """/* RliBook notebook — brand palette, faint line numbers (5% opacity). */
body { font-family: serif; color: #1C2826; margin: 0; padding: 0; }
.masthead { text-align: center; border-bottom: 2px solid #44402F;
  padding: 0.4em 0 0.6em; margin-bottom: 0.6em; }
.masthead .bird { font-size: 1.6em; }
.masthead .brand { font-size: 1.3em; font-weight: bold; letter-spacing: 0.08em; }
.masthead .tag { font-size: 0.85em; color: #44402F; }
.pagenum { text-align: center; font-size: 0.8em; color: #44402F;
  margin-top: 0.8em; }
.line { display: flex; align-items: flex-end; height: 2.1em;
  border-bottom: 1px solid #99B6B3; }
.ln { width: 2.2em; text-align: right; font-size: 0.8em;
  color: #1C2826; opacity: 0.05; }
.rule { flex: 1; }
.title-page { text-align: center; margin-top: 25%; }
.title-page .bird { font-size: 3em; }
.title-page h1 { font-size: 1.8em; }
.title-page p { color: #44402F; }
"""

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def _xhtml_head(title: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" lang="ar" dir="rtl">\n'
        "<head><title>" + escape(title) + "</title>"
        '<link rel="stylesheet" type="text/css" href="style.css"/>'
        "</head>\n<body>\n"
    )


def title_page_xhtml() -> str:
    return (
        _xhtml_head(TITLE)
        + '<div class="title-page">\n'
        '<div class="bird">\U0001f426</div>\n'
        "<h1>RliBook</h1>\n"
        "<p>دفتر الملاحظات — Notebook</p>\n"
        "<p>Reply. Read. Fly. — رد. اقرأ. حلّق.</p>\n"
        "<p>اكتب بقلم Kindle Scribe، أو حدّد سطراً وأضف ملاحظة.</p>\n"
        "</div>\n</body>\n</html>\n"
    )


def page_xhtml(page_no: int, total_pages: int, lines: int) -> str:
    """One notebook page: masthead + ``lines`` numbered ruled lines."""
    out = [_xhtml_head(f"{TITLE} — صفحة {page_no}")]
    out.append('<div class="masthead">\n')
    out.append('<div class="bird">\U0001f426</div>\n')
    out.append('<div class="brand">RliBook</div>\n')
    out.append('<div class="tag">دفتر الملاحظات — Notebook</div>\n')
    out.append("</div>\n")
    for n in range(1, lines + 1):
        out.append(
            f'<div class="line"><span class="ln">{n}</span>'
            '<span class="rule">&#160;</span></div>\n'
        )
    out.append(f'<div class="pagenum">صفحة {page_no} من {total_pages}</div>\n')
    out.append("</body>\n</html>\n")
    return "".join(out)


def content_opf(book_id: str, pages: int) -> str:
    items = ['<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>']
    items.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    items.append('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    items.append('<item id="css" href="style.css" media-type="text/css"/>')
    for p in range(1, pages + 1):
        items.append(
            f'<item id="page{p:03d}" href="page-{p:03d}.xhtml" '
            'media-type="application/xhtml+xml"/>'
        )
    spine = ['<itemref idref="title"/>']
    spine += [f'<itemref idref="page{p:03d}"/>' for p in range(1, pages + 1)]
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">\n'
        "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n"
        f'<dc:identifier id="bookid">urn:uuid:{book_id}</dc:identifier>\n'
        f"<dc:title>{escape(TITLE)}</dc:title>\n"
        f"<dc:language>{LANGUAGE}</dc:language>\n"
        "<dc:creator>RliBook</dc:creator>\n"
        '<meta property="dcterms:modified">2026-11-14T00:00:00Z</meta>\n'
        "</metadata>\n<manifest>\n" + "\n".join(items) + "\n</manifest>\n"
        "<spine toc=\"ncx\">\n" + "\n".join(spine) + "\n</spine>\n</package>\n"
    )


def nav_xhtml(pages: int) -> str:
    items = ['<li><a href="title.xhtml">الغلاف — دفتر الملاحظات</a></li>']
    for p in range(1, pages + 1):
        items.append(f'<li><a href="page-{p:03d}.xhtml">صفحة {p}</a></li>')
    return (
        _xhtml_head(TITLE)
        + '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">\n'
        "<h1>المحتويات</h1>\n<ol>\n" + "\n".join(items) + "\n</ol>\n</nav>\n"
        "</body>\n</html>\n"
    )


def toc_ncx(book_id: str, pages: int) -> str:
    points = [
        '<navPoint id="np-title" playOrder="1">'
        "<navLabel><text>الغلاف — دفتر الملاحظات</text></navLabel>"
        '<content src="title.xhtml"/></navPoint>'
    ]
    for p in range(1, pages + 1):
        points.append(
            f'<navPoint id="np-{p:03d}" playOrder="{p + 1}">'
            f"<navLabel><text>صفحة {p}</text></navLabel>"
            f'<content src="page-{p:03d}.xhtml"/></navPoint>'
        )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        "<head>"
        f'<meta name="dtb:uid" content="urn:uuid:{book_id}"/>'
        '<meta name="dtb:depth" content="1"/>'
        '<meta name="dtb:totalPageCount" content="0"/>'
        '<meta name="dtb:maxPageNumber" content="0"/>'
        "</head>\n"
        f"<docTitle><text>{escape(TITLE)}</text></docTitle>\n"
        "<navMap>\n" + "\n".join(points) + "\n</navMap>\n</ncx>\n"
    )


def build_notebook_epub(
    output: str | Path,
    pages: int = DEFAULT_PAGES,
    lines: int = DEFAULT_LINES,
) -> Path:
    """Generate the notebook EPUB and return its path."""
    if pages < 1:
        raise ValueError("pages must be >= 1")
    if lines < 1:
        raise ValueError("lines must be >= 1")
    out = Path(output)
    book_id = str(uuid.uuid4())
    files: list[tuple[str, str]] = [
        ("META-INF/container.xml", CONTAINER_XML),
        ("OEBPS/content.opf", content_opf(book_id, pages)),
        ("OEBPS/nav.xhtml", nav_xhtml(pages)),
        ("OEBPS/toc.ncx", toc_ncx(book_id, pages)),
        ("OEBPS/style.css", CSS),
        ("OEBPS/title.xhtml", title_page_xhtml()),
    ]
    for p in range(1, pages + 1):
        files.append((f"OEBPS/page-{p:03d}.xhtml", page_xhtml(p, pages, lines)))
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w") as zf:
        # EPUB rule: mimetype first, stored (not compressed).
        zf.writestr(
            "mimetype", "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        for name, data in files:
            zf.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build the RliBook notebook EPUB.")
    ap.add_argument("--pages", type=int, default=DEFAULT_PAGES)
    ap.add_argument("--lines", type=int, default=DEFAULT_LINES)
    ap.add_argument("-o", "--output", default="rlibook-notebook.epub")
    args = ap.parse_args(argv)
    path = build_notebook_epub(args.output, pages=args.pages, lines=args.lines)
    print(f"Wrote {path} ({path.stat().st_size} bytes, "
          f"{args.pages} pages x {args.lines} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
