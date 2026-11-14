"""Thin re-export of the canonical notebook generator.

The real generator lives in telegram/tbi/notebook.py (pure stdlib);
this file just makes it runnable from site/notebook/ too:

    python3 notebook.py --pages 50 --lines 24 -o rlibook-notebook.epub
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "telegram"))

from tbi.notebook import (  # noqa: E402
    build_notebook_epub,
    content_opf,
    nav_xhtml,
    page_xhtml,
    title_page_xhtml,
    toc_ncx,
    CSS,
    DEFAULT_LINES,
    DEFAULT_PAGES,
    LINE_NUMBER_OPACITY,
    TITLE,
    main,
)

__all__ = [
    "build_notebook_epub",
    "content_opf",
    "nav_xhtml",
    "page_xhtml",
    "title_page_xhtml",
    "toc_ncx",
    "CSS",
    "DEFAULT_LINES",
    "DEFAULT_PAGES",
    "LINE_NUMBER_OPACITY",
    "TITLE",
    "main",
]

if __name__ == "__main__":
    raise SystemExit(main())
