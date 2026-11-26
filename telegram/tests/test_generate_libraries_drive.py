"""Tests for the Drive section of the libraries page (WAVE 4 WS8).

scripts/generate-libraries.py: only PUBLIC, active libraries are
listed on the public page — a private or pending library must not
leak there, whatever its book count.
"""
import importlib.util
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
