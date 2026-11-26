"""Tests for the Drive section of the libraries page (WAVE 4 WS8).

scripts/generate-libraries.py: only PUBLIC, active libraries are
listed on the public page — a private or pending library must not
leak there, whatever its book count.
"""
import importlib.util
import json
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "generate_libraries",
    Path(__file__).resolve().parent.parent.parent / "scripts" / "generate-libraries.py",
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
drive_entry = _mod.drive_entry
drive_section = _mod.drive_section

FOLDER = "1EFegWouzH4CXHzX2N-NfD18mJbtDLQAP"
PUB = {"folder_id": FOLDER, "title": "Oriental Music", "visibility": "public", "status": "active"}
PRIV = {"folder_id": "PRIVFOLDER1234567890", "title": "مكتبة خاصة", "visibility": "private", "status": "active"}
PEND = {"folder_id": "PENDFOLDER1234567890", "title": "مكتبة بانتظار", "visibility": "pending_public", "status": "active"}
DEAD = {"folder_id": "DEADFOLDER1234567890", "title": "مكتبة مغلقة", "visibility": "public", "status": "closed"}


def test_drive_section_lists_public_only():
    html = drive_section([PUB, PRIV, PEND, DEAD], {FOLDER: 397})
    assert "Oriental Music" in html
    assert "397 كتاب" in html
    assert "مكتبة خاصة" not in html
    assert "مكتبة بانتظار" not in html
    assert "مكتبة مغلقة" not in html  # non-active is skipped too


def test_drive_section_empty_when_no_public():
    assert drive_section([PRIV, PEND], {}) == ""
    assert drive_section([], {}) == ""


def test_drive_entry_links():
    row = drive_entry(PUB, 397)
    assert "/telegram/?source=drive%3A" + FOLDER in row
    assert "https://drive.google.com/drive/folders/" + FOLDER in row
    assert "مكتبة Drive" in row


def test_drive_entry_escapes_title():
    row = drive_entry({"folder_id": FOLDER, "title": "<script>x</script>"}, 0)
    assert "<script>" not in row
    assert "لا كتب مفهرسة بعد" in row


def test_mylibs_block_has_fp_fetch_only():
    """WAVE 7: the "my libraries" block fetches /api/drive-libraries
    with ?fp= — and does nothing at all without fp (no fetch, the
    static public list is the whole page). Only the viewer's own
    (mine:true) non-public rows are rendered; the browse links carry
    fp forward so /telegram/ can identify the viewer too."""
    html = _mod.MYLIBS_HTML
    script = _mod.MYLIBS_SCRIPT
    assert 'id="mylibs"' in html
    assert 'id="mylibs-list"' in html
    assert "/api/drive-libraries?fp=" in script
    assert "if (!fp) return;" in script
    assert "lib.mine" in script
    assert '(lib.visibility || "public") === "public"' in script
    assert "&amp;fp=" in script  # browse links carry fp forward


def test_generate_full_page(tmp_path, monkeypatch):
    """End-to-end: main() with --manifest/--out still works (CLI
    behavior intact), the static list stays public-only, and the
    mylibs block + script are in the emitted page."""
    manifest = {
        "sources": [{"name": "chan1", "kind": "channel", "files": 5, "posts": 10}],
        "totals": {"books": 5, "files": 5},
        "generated_at": "2026-11-26T00:00:00",
    }
    man = tmp_path / "index.json"
    man.write_text(json.dumps(manifest), encoding="utf-8")
    reg = tmp_path / "drive-libraries.json"
    reg.write_text(json.dumps({"libraries": [
        PUB,
        {"folder_id": "PRIVFOLDER1234567890", "title": "PrivateLibXYZ",
         "visibility": "private", "status": "active"},
    ]}), encoding="utf-8")
    cnt = tmp_path / "counts.json"
    cnt.write_text(json.dumps({FOLDER: 397}), encoding="utf-8")
    out = tmp_path / "libraries.html"
    monkeypatch.setattr(sys, "argv", [
        "generate-libraries.py",
        "--manifest", str(man),
        "--out", str(out),
        "--drive-registry", str(reg),
        "--drive-counts", str(cnt),
    ])
    _mod.main()
    page = out.read_text(encoding="utf-8")
    assert "Oriental Music" in page
    assert "397 كتاب" in page
    assert "PrivateLibXYZ" not in page  # private title never leaks
    assert 'id="mylibs"' in page
    assert "/api/drive-libraries?fp=" in page
