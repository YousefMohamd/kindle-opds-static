"""Tests for tbi.notebook — the RliBook notebook EPUB generator (Block 14).

The notebook is a designed EPUB "book" with RliBook on top of every
page and NUMBERED lines at 5% opacity (opacity: 0.05 in the CSS).
"""

import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import notebook  # noqa: E402


def _build(tmp_path, pages=3, lines=5):
    out = tmp_path / "nb.epub"
    notebook.build_notebook_epub(out, pages=pages, lines=lines)
    return out


def test_css_line_numbers_are_5_percent_opacity():
    assert "opacity: 0.05" in notebook.CSS
    assert notebook.LINE_NUMBER_OPACITY == "0.05"


def test_page_has_numbered_lines_and_brand(tmp_path):
    out = _build(tmp_path)
    z = zipfile.ZipFile(out)
    page = z.read("OEBPS/page-001.xhtml").decode()
    assert "RliBook" in page
    assert page.count('class="line"') == 5
    for n in range(1, 6):
        assert f">{n}<" in page


def test_epub_structure_is_valid(tmp_path):
    out = _build(tmp_path, pages=50, lines=24)
    z = zipfile.ZipFile(out)
    names = z.namelist()
    # EPUB rule: mimetype first, stored (not compressed).
    assert names[0] == "mimetype"
    assert z.getinfo("mimetype").compress_type == zipfile.ZIP_STORED
    assert z.read("mimetype") == b"application/epub+zip"
    assert z.testzip() is None
    assert "META-INF/container.xml" in names
    assert b"OEBPS/content.opf" in z.read("META-INF/container.xml")
    assert "OEBPS/content.opf" in names
    assert "OEBPS/nav.xhtml" in names
    assert "OEBPS/toc.ncx" in names
    assert "OEBPS/style.css" in names
    assert "OEBPS/title.xhtml" in names
    page_files = [n for n in names if n.startswith("OEBPS/page-")]
    assert len(page_files) == 50
    # Every content file parses as XML.
    import xml.etree.ElementTree as ET

    for n in names:
        if n.endswith((".xhtml", ".opf", ".ncx", ".xml")):
            ET.fromstring(z.read(n))


def test_sample_epub_is_small():
    sample = Path(__file__).resolve().parent.parent.parent / "site" / "notebook" / "rlibook-notebook-sample.epub"
    assert sample.exists()
    assert sample.stat().st_size < 100_000


def test_invalid_args_raise(tmp_path):
    with pytest.raises(ValueError):
        notebook.build_notebook_epub(tmp_path / "x.epub", pages=0)
    with pytest.raises(ValueError):
        notebook.build_notebook_epub(tmp_path / "x.epub", lines=0)
