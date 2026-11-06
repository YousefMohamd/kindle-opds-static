"""Parser for Telegram Desktop chat exports (JSON format).

This is the ONLY API-free path to index a public *group*: groups have
no t.me/s/ preview, so the user exports the group from Telegram Desktop
(File > Export chat history, format JSON, with media files) and this
module indexes the export into the same store as the live channel
scrape. See README for the exact export steps.

Format (Telegram Desktop JSON export, as documented by Telegram's
export feature; verify against one real export — see
tests/fixtures/export_sample.json, which follows this shape):
  {
    "name": "Group Name",
    "type": "public_supergroup",
    "id": 123456789,
    "messages": [
      {
        "id": 123,
        "type": "message",
        "date": "2024-01-15T10:30:00",
        "date_unixtime": "1705314600",
        "from": "User Name",
        "text": "caption text",           // or a list of entities
        "media_type": "document",         // document | audio_file | photo | ...
        "mime_type": "application/pdf",
        "file": "files/Book Title.pdf",   // relative path inside the export
        "file_name": "Book Title.pdf",    // present in some exports; else basename(file)
        "thumbnail": "files/Book Title_thumb.jpg"
      },
      ...
    ]
  }

Notes / defensive choices (the format varies slightly by client version):
  * ``text`` may be a plain string or a list of ``{"type": ..., "text": ...}``
    entities — both are flattened to plain text.
  * ``file_name`` may be absent; the filename then comes from ``file``.
  * Service messages (``"type": "service"``) are skipped.
  * Messages without a file are kept as text-only posts (their captions
    may name a book someone is *asking* for — useful for the request
    use case, but they carry no file).
  * No download link is produced: the file lives in the export folder
    (``file`` path) or must be fetched in Telegram.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

from .books import BOOK_EXTS, normalize_filename

# media_type values in the export that can carry a book file.
FILE_MEDIA_TYPES = {"document", "audio_file"}


@dataclass
class ExportFile:
    filename: str
    ext: str = ""
    mime_type: Optional[str] = None
    export_path: Optional[str] = None  # relative path inside the export dir
    size_bytes: Optional[int] = None  # Telegram exports do not record size

    def __post_init__(self) -> None:
        if "." in self.filename:
            self.ext = self.filename.rsplit(".", 1)[-1].lower()


@dataclass
class ExportPost:
    chat_name: str
    post_id: int
    date: Optional[str] = None  # ISO 8601
    author: Optional[str] = None
    text: str = ""
    files: List[ExportFile] = field(default_factory=list)
    # Permalink, when the chat is public and the id is known. Group post
    # links need the numeric chat id: t.me/c/<id-without-100-prefix>/<msg>.
    url: str = ""


def flatten_text(value: Any) -> str:
    """Export ``text`` is a string or a list of entity dicts."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text", "")))
        return "".join(parts)
    return str(value)


def _iso_date(msg: dict) -> Optional[str]:
    ts = msg.get("date_unixtime")
    if ts:
        try:
            return datetime.fromtimestamp(
                int(ts), tz=timezone.utc
            ).isoformat()
        except (ValueError, TypeError, OverflowError):
            pass
    date = msg.get("date")
    if isinstance(date, str) and date:
        try:
            return datetime.fromisoformat(date).isoformat()
        except ValueError:
            return date
    return None


def _group_permalink(chat_id: Any, post_id: int) -> str:
    """Best-effort permalink for a public supergroup post.

    Telegram uses t.me/c/<internal_id>/<msg_id> where internal_id is the
    chat id without the -100 prefix. For a chat id like -1001234567890
    the link is t.me/c/1234567890/<msg_id>. When the id is unknown or
    not a supergroup id, the URL is left empty.
    """
    try:
        cid = int(chat_id)
    except (TypeError, ValueError):
        return ""
    internal = str(abs(cid))
    if internal.startswith("100"):
        internal = internal[3:]
    return f"https://t.me/c/{internal}/{post_id}"


def parse_export(path: str | Path) -> tuple[str, List[ExportPost]]:
    """Parse a Telegram Desktop JSON export.

    Returns (chat_name, posts). Raises ValueError on a malformed file.
    """
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Cannot read Telegram export {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        raise ValueError(
            f"{path} does not look like a Telegram Desktop JSON export "
            "(expected an object with a 'messages' list)"
        )
    chat_name = str(data.get("name") or path.stem)
    chat_id = data.get("id")
    posts: List[ExportPost] = []
    for msg in data["messages"]:
        if not isinstance(msg, dict):
            continue
        if msg.get("type") == "service":
            continue
        post_id = msg.get("id")
        if not isinstance(post_id, int):
            continue
        text = flatten_text(msg.get("text"))
        files: List[ExportFile] = []
        media_type = str(msg.get("media_type") or "")
        if media_type in FILE_MEDIA_TYPES or msg.get("file"):
            raw_name = msg.get("file_name") or ""
            raw_path = msg.get("file") or ""
            filename = raw_name or os.path.basename(raw_path)
            if filename:
                files.append(
                    ExportFile(
                        filename=normalize_filename(filename),
                        mime_type=msg.get("mime_type"),
                        export_path=raw_path or None,
                    )
                )
        posts.append(
            ExportPost(
                chat_name=chat_name,
                post_id=post_id,
                date=_iso_date(msg),
                author=msg.get("from"),
                text=text,
                files=files,
                url=_group_permalink(chat_id, post_id),
            )
        )
    posts.sort(key=lambda p: p.post_id)
    return chat_name, posts


def is_book_file(f: ExportFile) -> bool:
    return f.ext in BOOK_EXTS
