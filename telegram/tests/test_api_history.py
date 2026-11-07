"""Tests for the optional, manual-only API backfill (v0.4).

Everything here is offline: a fake Telethon client (duck-typed) stands
in for the real one, so no network and no credentials are needed — and
Telethon itself is never imported (it is an optional dependency).
"""

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import cli as cli_mod  # noqa: E402
from tbi.api_history import (  # noqa: E402
    ApiCredentialsError,
    create_client,
    find_config_entry,
    iter_api_posts,
    load_api_credentials,
)
from tbi.cli import main  # noqa: E402
from tbi.config import load_config  # noqa: E402
from tbi.store import Store  # noqa: E402


class _FloodWait(Exception):
    """Stand-in for Telethon's FloodWaitError (only `.seconds` matters:
    the reader honours it duck-typed, so no Telethon import is needed)."""

    def __init__(self, seconds=0):
        super().__init__(f"flood wait {seconds}s")
        self.seconds = seconds


class FakeFile:
    def __init__(self, name, size):
        self.name = name
        self.size = size
        self.ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""


class FakeMessage:
    def __init__(self, pid, text="", file=None):
        self.id = pid
        self.message = text
        self.file = file
        self.media = None
        self.date = datetime(2026, 11, 6, 10, 0, tzinfo=timezone.utc)


class FakeEntity:
    """A channel/group entity (class name is not "User")."""


class FakeClient:
    """Duck-typed stand-in for a Telethon client."""

    def __init__(self, messages, *, flood_wait_once=False, entity=None):
        self._messages = sorted(messages, key=lambda m: m.id, reverse=True)
        self._flood_wait_once = flood_wait_once
        self._flooded = False
        self.entity = entity if entity is not None else FakeEntity()
        self.started = False
        self.disconnected = False

    async def start(self):
        self.started = True

    async def disconnect(self):
        self.disconnected = True

    async def get_entity(self, handle):
        return self.entity

    async def iter_messages(self, entity, offset_id=0, limit=None):
        if self._flood_wait_once and not self._flooded:
            self._flooded = True
            raise _FloodWait(seconds=0)
        # Faithful to real Telethon: _MessagesIter does
        # offset_id = max(offset_id, max_id) with max_id defaulting to
        # 0, so offset_id=None raises TypeError: '>' not supported
        # between instances of 'int' and 'NoneType' (the v0.4.2 bug:
        # the first api-backfill run failed on all 43 channels because
        # iter_api_posts passed offset_id=None on the first chunk).
        # offset_id=0 means "no offset" (start from the newest).
        offset_id = max(offset_id, 0)
        msgs = [m for m in self._messages if offset_id == 0 or m.id < offset_id]
        if limit is not None:
            msgs = msgs[:limit]
        for m in msgs:
            yield m


def _drain(coro_gen):
    async def _collect():
        return [p async for p in coro_gen]

    return asyncio.run(_collect())


def _cfg(tmp_path, channels="  - https://t.me/testchan\n"):
    path = tmp_path / "channels.yaml"
    path.write_text(
        "channels:\n" + channels + "settings:\n  db: index.db\n",
        encoding="utf-8",
    )
    return path


# --- the module must not need Telethon to import ------------------------

def test_api_history_imports_without_telethon():
    assert "telethon" not in sys.modules
    import tbi.api_history  # noqa: F401

    assert "telethon" not in sys.modules


def test_create_client_without_telethon_explains_install(monkeypatch):
    # Simulate "telethon not installed" even in an env where it IS
    # installed (e.g. a smoke-test venv with the [api] extra): an
    # import of a module whose sys.modules entry is None raises
    # ImportError, which is exactly what create_client handles.
    monkeypatch.setitem(sys.modules, "telethon", None)
    monkeypatch.setitem(sys.modules, "telethon.sessions", None)
    with pytest.raises(RuntimeError, match="Telethon is not installed"):
        create_client(1, "hash", "session")


# --- credentials ----------------------------------------------------------

def test_load_api_credentials_missing():
    with pytest.raises(ApiCredentialsError) as exc:
        load_api_credentials({})
    assert "TELEGRAM_API_ID" in str(exc.value)
    assert "TELEGRAM_API_HASH" in str(exc.value)
    assert "TELEGRAM_SESSION_STRING" in str(exc.value)


def test_load_api_credentials_bad_api_id():
    with pytest.raises(ApiCredentialsError, match="must be an integer"):
        load_api_credentials(
            {
                "TELEGRAM_API_ID": "not-a-number",
                "TELEGRAM_API_HASH": "h",
                "TELEGRAM_SESSION_STRING": "s",
            }
        )


def test_load_api_credentials_ok():
    assert load_api_credentials(
        {
            "TELEGRAM_API_ID": "12345",
            "TELEGRAM_API_HASH": "abcdef",
            "TELEGRAM_SESSION_STRING": "1A2B3C",
        }
    ) == (12345, "abcdef", "1A2B3C")


# --- config gate ----------------------------------------------------------

def test_find_config_entry_channel_and_group(tmp_path):
    cfg = load_config(
        _cfg(
            tmp_path,
            "  - https://t.me/testchan\n",
        )
    )
    assert find_config_entry(cfg, "testchan")[0] == "channel"
    assert find_config_entry(cfg, "https://t.me/testchan")[0] == "channel"
    assert find_config_entry(cfg, "other") is None


def test_find_config_entry_group_by_name(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        "channels: []\n"
        "groups:\n"
        "  - name: EBook_Library\n"
        "    export: ~/exports/EBook_Library/result.json\n"
        "settings:\n  db: index.db\n",
        encoding="utf-8",
    )
    cfg = load_config(path)
    kind, entry = find_config_entry(cfg, "EBook_Library")
    assert kind == "group"
    assert entry.name == "EBook_Library"


def test_real_config_all_groups_active_v045():
    """v0.4.5: the real channels.yaml has ALL 168 groups active — via
    the API, with NO export line on any of them (no Desktop export
    exists for them; the API does not need one). EBook_Library was
    first (v0.4.4, proven in production); the remaining 167 were
    activated in v0.4.5. No group entry stays commented out (the dead
    handles and private invite lists at the bottom are not group
    entries and stay as-is). find_config_entry resolves groups by
    name so `tbi api-backfill --channel <name>` targets them."""
    real_cfg = Path(__file__).resolve().parent.parent / "channels.yaml"
    cfg = load_config(real_cfg)
    names = [g.name for g in cfg.groups]
    assert len(names) == 168
    assert len(set(names)) == 168  # no duplicates
    assert "EBook_Library" in names
    assert all(g.export == "" for g in cfg.groups)
    kind, found = find_config_entry(cfg, "EBook_Library")
    assert kind == "group"
    assert found.name == "EBook_Library"
    kind, found = find_config_entry(cfg, "jazz223k")
    assert kind == "group"
    assert found.name == "jazz223k"
    # A dead handle is still not a configured source.
    assert find_config_entry(cfg, "KOTOBPDFFF") is None
    # No commented-out group entry remains in the file (dead handles
    # and invite links use a different line form, so they do not
    # match this count).
    text = real_cfg.read_text(encoding="utf-8")
    assert text.count("  # - name: ") == 0
    # The 43 channels are untouched by the group activation.
    assert len(cfg.channels) == 43


# --- message -> post extraction --------------------------------------------

def test_message_files_from_file_accessor():
    from tbi.api_history import _message_files

    msg = FakeMessage(1, "", FakeFile("Dune.epub", 1200000))
    files = _message_files(msg)
    assert len(files) == 1
    assert files[0].filename == "Dune.epub"
    assert files[0].ext == "epub"
    assert files[0].size_bytes == 1200000
    assert files[0].size_text == "1.1 MB"


def test_message_files_from_document_attributes():
    from tbi.api_history import _message_files

    class Attr:
        file_name = "Book.pdf"

    class Doc:
        size = 2048
        attributes = [Attr()]

    class Media:
        document = Doc()

    msg = FakeMessage(1, "")
    msg.media = Media()
    files = _message_files(msg)
    assert len(files) == 1
    assert files[0].filename == "Book.pdf"
    assert files[0].size_bytes == 2048
    assert files[0].size_text == "2 KB"


def test_message_files_none_without_document():
    from tbi.api_history import _message_files

    assert _message_files(FakeMessage(1, "just text")) == []


# --- iter_api_posts: modes, flood wait, user refusal -----------------------

def test_iter_api_posts_yields_newest_first():
    client = FakeClient(
        [
            FakeMessage(8, "old", FakeFile("Old.epub", 100)),
            FakeMessage(10, "new", FakeFile("New.epub", 200)),
            FakeMessage(9, "mid"),
        ]
    )
    posts = _drain(iter_api_posts(client, "testchan"))
    assert [p.post_id for p in posts] == [10, 9, 8]
    assert posts[0].url == "https://t.me/testchan/10"
    assert posts[0].files[0].filename == "New.epub"
    assert posts[1].files == []


def test_iter_api_posts_never_passes_offset_id_none_to_telethon():
    """Regression (v0.4.2): iter_api_posts passed offset_id=None on
    the first chunk, and real Telethon does max(offset_id, max_id)
    with max_id defaulting to 0 — so max(None, 0) raised TypeError:
    '>' not supported between instances of 'int' and 'NoneType',
    failing every channel of the first api-backfill run. The fake
    client now mimics Telethon, so this test fails if the bug returns.
    """
    msgs = [FakeMessage(i, f"p{i}") for i in (10, 9, 8)]
    posts = _drain(iter_api_posts(FakeClient(msgs), "testchan"))
    assert [p.post_id for p in posts] == [10, 9, 8]
    # And with an explicit start_before (backfill below an oldest post).
    posts = _drain(iter_api_posts(FakeClient(msgs), "testchan", start_before=9))
    assert [p.post_id for p in posts] == [8]


def test_iter_api_posts_min_id_limit_start_before():
    msgs = [FakeMessage(i, f"p{i}") for i in (10, 9, 8, 7)]
    assert [p.post_id for p in _drain(
        iter_api_posts(FakeClient(msgs), "testchan", min_id=9))] == [10]
    assert [p.post_id for p in _drain(
        iter_api_posts(FakeClient(msgs), "testchan", limit=2))] == [10, 9]
    assert [p.post_id for p in _drain(
        iter_api_posts(FakeClient(msgs), "testchan", start_before=9))] == [8, 7]
    # Pagination: chunk=2 walks the whole history in two chunks.
    assert [p.post_id for p in _drain(
        iter_api_posts(FakeClient(msgs), "testchan", chunk=2))] == [10, 9, 8, 7]


def test_iter_api_posts_flood_wait_retries_same_chunk():
    msgs = [FakeMessage(10, "a", FakeFile("A.epub", 100)),
            FakeMessage(9, "b")]
    posts = _drain(
        iter_api_posts(FakeClient(msgs, flood_wait_once=True), "testchan")
    )
    assert [p.post_id for p in posts] == [10, 9]


def test_iter_api_posts_refuses_personal_chat():
    user_entity = type("User", (), {})()
    client = FakeClient([FakeMessage(1, "hi")], entity=user_entity)
    with pytest.raises(ValueError, match="personal chat"):
        _drain(iter_api_posts(client, "someone"))


# --- cmd api-backfill (end to end, fake client) ----------------------------

def _env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_API_ID", "12345")
    monkeypatch.setenv("TELEGRAM_API_HASH", "abcdef")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "1A2B3C")


def test_api_backfill_cli_indexes_books(tmp_path, monkeypatch, capsys):
    db = tmp_path / "index.db"
    cfg = _cfg(tmp_path)
    _env(monkeypatch)
    msgs = [
        FakeMessage(10, "Dune", FakeFile("Dune.epub", 1200000)),
        FakeMessage(9, "hello"),
    ]
    fake = FakeClient(msgs)
    monkeypatch.setattr(cli_mod, "create_client", lambda *a: fake)
    assert main([
        "api-backfill", "--config", str(cfg), "--db", str(db),
        "--channel", "testchan",
    ]) == 0
    out = capsys.readouterr().out
    assert "[ok] @testchan: 2 posts, 1 book files (API)" in out
    assert fake.started and fake.disconnected
    assert main(["search", "Dune", "--db", str(db)]) == 0
    assert "Dune.epub" in capsys.readouterr().out
    store = Store(db)
    try:
        assert store.counts()["posts"] == 2
        assert store.counts()["files"] == 1
    finally:
        store.close()


def test_api_backfill_cli_channel_not_in_config(tmp_path, monkeypatch, capsys):
    db = tmp_path / "index.db"
    cfg = _cfg(tmp_path)
    _env(monkeypatch)
    called = []
    monkeypatch.setattr(
        cli_mod, "create_client", lambda *a: called.append(True) or FakeClient([])
    )
    assert main([
        "api-backfill", "--config", str(cfg), "--db", str(db),
        "--channel", "notconfigured",
    ]) == 2
    assert "not in" in capsys.readouterr().err
    assert called == []  # the client is never built for an unconfigured handle


def test_api_backfill_cli_missing_credentials(tmp_path, monkeypatch, capsys):
    db = tmp_path / "index.db"
    cfg = _cfg(tmp_path)
    for var in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION_STRING"):
        monkeypatch.delenv(var, raising=False)
    assert main([
        "api-backfill", "--config", str(cfg), "--db", str(db),
        "--channel", "testchan",
    ]) == 2
    assert "missing" in capsys.readouterr().err.lower()


def test_api_backfill_cli_backfill_block(tmp_path, monkeypatch, capsys):
    db = tmp_path / "index.db"
    cfg = _cfg(tmp_path)
    _env(monkeypatch)
    # Pre-seed the DB: posts 10..8 already indexed (oldest 8).
    store = Store(db)
    try:
        sid = store.upsert_source("channel", "testchan")
        for pid in (10, 9, 8):
            store.upsert_post(sid, pid, "2026-11-06T10:00:00+00:00", "", "")
        store.set_source_status(sid, "ok", oldest=8, newest=10)
        store.commit()
    finally:
        store.close()
    # The API has older posts 7..5 plus a newer post 11.
    msgs = [FakeMessage(11, "new", FakeFile("New.epub", 100))]
    msgs += [FakeMessage(i, f"old{i}", FakeFile(f"Old{i}.epub", 100))
             for i in (7, 6, 5)]
    fake = FakeClient(msgs)
    monkeypatch.setattr(cli_mod, "create_client", lambda *a: fake)
    assert main([
        "api-backfill", "--config", str(cfg), "--db", str(db),
        "--channel", "testchan", "--backfill", "--backfill-block", "2",
    ]) == 0
    out = capsys.readouterr().out
    # Phase 1 picked up post 11; phase 2 walked one block of 2 below 8 (7, 6).
    assert "[ok] @testchan: 3 posts, 3 book files (API)" in out
    store = Store(db)
    try:
        assert store.counts()["posts"] == 6  # 3 seeded + 1 new + 2 backfilled
        assert store.counts()["files"] == 3
        src = store.get_source("testchan")
        assert src["oldest_post_id"] == 6
        assert src["newest_post_id"] == 11
    finally:
        store.close()
