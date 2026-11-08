"""Tests for the slow, safe group joining (v0.4.6).

Everything here is offline: a fake Telethon client (duck-typed) stands
in for the real one, so no network and no credentials are needed — and
Telethon itself is never imported, except in the one importorskip test
that verifies the real TL request factories build.
"""

import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tbi import cli as cli_mod  # noqa: E402
from tbi import join_groups as jg  # noqa: E402
from tbi.cli import main  # noqa: E402
from tbi.config import load_config  # noqa: E402

FOLDER = "📚كتب"
NOW = datetime(2026, 11, 7, 21, 0, tzinfo=timezone.utc)

# Stand-ins for Telethon errors: only the class NAME matters (the
# joiner duck-types on it, the same seam iter_api_posts uses for
# FloodWaitError's .seconds).
UserNotParticipantError = type(
    "UserNotParticipantError", (Exception,), {}
)
UserAlreadyParticipantError = type(
    "UserAlreadyParticipantError", (Exception,), {}
)
UserEntity = type("User", (), {})


class _FloodWait(Exception):
    """Stand-in for Telethon's FloodWaitError (only `.seconds` matters)."""

    def __init__(self, seconds=0):
        super().__init__(f"flood wait {seconds}s")
        self.seconds = seconds


class FakeEntity:
    """A group entity (class name is not "User")."""

    def __init__(self, handle, entity_id):
        self.handle = handle
        self.id = entity_id
        self.access_hash = 1000 + entity_id


class FakeFilter:
    """Stand-in for a Telethon DialogFilter (title is an object with
    .text, like the real TextWithEntities)."""

    def __init__(self, folder_id, title, include_peers=None):
        self.id = folder_id
        self.title = SimpleNamespace(text=title)
        self.pinned_peers = []
        self.include_peers = list(include_peers or [])
        self.exclude_peers = []
        self.contacts = False
        self.non_contacts = False
        self.groups = False
        self.broadcasts = False
        self.bots = False
        self.exclude_muted = False
        self.exclude_read = False
        self.exclude_archived = False


class FakeClient:
    """Duck-typed stand-in for a Telethon client."""

    def __init__(
        self,
        handles,
        *,
        members=(),
        join_fails=None,
        join_already=(),
        flood_wait_on=None,
        flood_wait_on_update=None,
        participant_check_errors=(),
        filters=None,
        user_handles=(),
    ):
        self.entities = {
            h: FakeEntity(h, 100 + i) for i, h in enumerate(handles)
        }
        for h in user_handles:
            self.entities[h] = UserEntity()
            self.entities[h].handle = h
            self.entities[h].id = 900
            self.entities[h].access_hash = 1900
        self.members = set(members)
        self.join_fails = dict(join_fails or {})
        self.join_already = set(join_already)
        self.flood_wait_on = flood_wait_on
        self.flood_wait_on_update = flood_wait_on_update
        self.participant_check_errors = set(participant_check_errors)
        self.filters = list(filters) if filters is not None else []
        self.joins = []  # handles a join request was actually sent for
        self.updates = []  # (filter id, filter) folder updates
        self.started = False
        self.disconnected = False

    async def start(self):
        self.started = True

    async def disconnect(self):
        self.disconnected = True

    async def get_entity(self, handle):
        if handle not in self.entities:
            raise ValueError(
                f"Cannot find any entity corresponding to '{handle}'"
            )
        return self.entities[handle]

    async def get_input_entity(self, entity):
        return SimpleNamespace(
            channel_id=entity.id, access_hash=entity.access_hash
        )

    async def __call__(self, request):
        kind = getattr(request, "kind", None)
        if kind == "join":
            handle = request.channel.handle
            self.joins.append(handle)
            if self.flood_wait_on == handle:
                raise _FloodWait(seconds=3600)
            if handle in self.join_already:
                raise UserAlreadyParticipantError()
            if handle in self.join_fails:
                raise self.join_fails[handle]
            return self.entities[handle]
        if kind == "get_participant":
            handle = request.channel.handle
            if handle in self.participant_check_errors:
                raise RuntimeError("membership check blew up")
            if handle in self.members:
                return SimpleNamespace()
            raise UserNotParticipantError()
        if kind == "get_filters":
            return SimpleNamespace(filters=list(self.filters))
        if kind == "update_filter":
            if self.flood_wait_on_update is not None:
                raise _FloodWait(seconds=self.flood_wait_on_update)
            self.updates.append((request.id, request.filter))
            for f in self.filters:
                if f.id == request.id:
                    f.include_peers = list(request.filter.include_peers)
            return None
        raise AssertionError(f"unexpected request kind: {kind!r}")


@pytest.fixture
def fake_requests(monkeypatch):
    """Monkeypatch the lazy Telethon factories to duck-typed stand-ins
    (the same seam the API tests use for create_client)."""
    monkeypatch.setattr(
        jg, "_join_request",
        lambda entity: SimpleNamespace(kind="join", channel=entity),
    )
    monkeypatch.setattr(
        jg, "_get_participant_request",
        lambda entity: SimpleNamespace(
            kind="get_participant", channel=entity, participant="me"
        ),
    )
    monkeypatch.setattr(
        jg, "_get_filters_request",
        lambda: SimpleNamespace(kind="get_filters"),
    )
    monkeypatch.setattr(
        jg, "_update_filter_request",
        lambda fid, f: SimpleNamespace(
            kind="update_filter", id=fid, filter=f
        ),
    )
    monkeypatch.setattr(
        jg, "_rebuild_filter",
        lambda old, include: SimpleNamespace(
            kind="dialog_filter", id=old.id, title=old.title,
            pinned_peers=old.pinned_peers,
            include_peers=list(include),
            exclude_peers=old.exclude_peers,
        ),
    )


def _cfg(tmp_path, groups=("alpha", "beta", "gamma")):
    path = tmp_path / "channels.yaml"
    lines = ["channels: []", "groups:"]
    for g in groups:
        lines.append(f'  - name: "{g}"')
    lines.append("settings:\n  db: index.db\n")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _run(client, cfg, state, **kwargs):
    kwargs.setdefault("delay_min", 0)
    kwargs.setdefault("delay_max", 0)
    kwargs.setdefault("folder_title", FOLDER)
    return asyncio.run(jg.join_pending(client, cfg, state, **kwargs))


def _folder_with_book():
    return [FakeFilter(2, FOLDER)]


# --- (a) never re-joins an already-member group ------------------------------

def test_never_rejoins_already_member_group(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path))
    state = jg.build_initial_state(cfg)
    client = FakeClient(
        ["alpha", "beta", "gamma"], members={"alpha"},
        filters=_folder_with_book(),
    )
    # Batch 3 here on purpose: the test is about the join logic (all
    # three groups must be attempted), not the default batch (2).
    result = _run(client, cfg, state, batch=3)
    # No join request was sent for the group he is already in.
    assert "alpha" not in client.joins
    assert client.joins == ["beta", "gamma"]
    assert result.already_member == ["alpha"]
    assert result.joined == ["beta", "gamma"]
    assert state["groups"]["alpha"]["status"] == "already_member"
    assert state["groups"]["beta"]["status"] == "joined"
    assert state["groups"]["beta"]["joined_at"] is not None
    # An already-member group still belongs in the folder.
    assert state["groups"]["alpha"]["folder"] == "added"
    assert result.folder["alpha"] == "added"


def test_already_participant_join_is_a_noop(tmp_path, fake_requests):
    """When the membership check itself fails, the join is attempted —
    and an already-member join is a no-op success, never a failure."""
    cfg = load_config(_cfg(tmp_path, groups=("alpha",)))
    state = jg.build_initial_state(cfg)
    client = FakeClient(
        ["alpha"], join_already={"alpha"},
        participant_check_errors={"alpha"},
        filters=_folder_with_book(),
    )
    result = _run(client, cfg, state)
    assert result.already_member == ["alpha"]
    assert result.joined == []
    assert result.failed == []
    assert state["groups"]["alpha"]["status"] == "already_member"


# --- (b) a flood wait stops the run immediately ------------------------------

def test_flood_wait_stops_run_immediately(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path))
    state = jg.build_initial_state(cfg)
    saved = []
    client = FakeClient(
        ["alpha", "beta", "gamma"], flood_wait_on="alpha",
        filters=_folder_with_book(),
    )
    result = _run(
        client, cfg, state, now=NOW, on_update=lambda s: saved.append(1)
    )
    assert result.stopped_by_flood_wait is True
    assert result.flood_wait == ("alpha", 3600.0)
    assert result.attempted == ["alpha"]
    assert result.joined == []
    # Beta and gamma were never attempted (still pending, 0 attempts).
    assert state["groups"]["beta"]["status"] == "pending"
    assert state["groups"]["beta"]["attempts"] == 0
    assert state["groups"]["gamma"]["attempts"] == 0
    # The flood wait is recorded (group + duration + until-when).
    assert state["groups"]["alpha"]["status"] == "flood_wait"
    assert state["groups"]["alpha"]["flood_wait_seconds"] == 3600
    assert state["flood_wait_until"] == "2026-11-07T22:00:00+00:00"
    assert state["flood_wait_seconds"] == 3600
    assert state["flood_wait_group"] == "alpha"
    # The state was saved after the group (incremental persistence).
    assert saved == [1]


def test_active_flood_wait_skips_run_then_retries_after_expiry(
    tmp_path, fake_requests
):
    cfg = load_config(_cfg(tmp_path, groups=("alpha", "beta")))
    state = jg.build_initial_state(cfg)
    # Run 1: flood wait on alpha (3600 s from NOW).
    client = FakeClient(
        ["alpha", "beta"], flood_wait_on="alpha",
        filters=_folder_with_book(),
    )
    result = _run(client, cfg, state, now=NOW)
    assert result.stopped_by_flood_wait is True
    # Run 2, 30 minutes later: the wait is still active — nothing attempted.
    client2 = FakeClient(
        ["alpha", "beta"], filters=_folder_with_book()
    )
    result2 = _run(
        client2, cfg, state, now=NOW + timedelta(minutes=30)
    )
    assert result2.stopped_by_flood_wait is True
    assert result2.attempted == []
    assert client2.joins == []
    # Run 3, 2 hours later: the wait expired — alpha is retried and joins.
    result3 = _run(
        client2, cfg, state, now=NOW + timedelta(hours=2)
    )
    assert result3.stopped_by_flood_wait is False
    assert result3.joined == ["alpha", "beta"]
    assert state["groups"]["alpha"]["status"] == "joined"
    assert state["flood_wait_until"] is None


# --- (c) one failure does not stop the others ---------------------------------

def test_one_failure_does_not_stop_others(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path))
    state = jg.build_initial_state(cfg)
    client = FakeClient(
        ["alpha", "beta", "gamma"],
        join_fails={"alpha": ValueError("not found")},
        filters=_folder_with_book(),
    )
    # Batch 3 here on purpose: the test is about the failure logic
    # (all three groups must be attempted), not the default batch (2).
    result = _run(client, cfg, state, batch=3)
    assert result.failed == [("alpha", "join failed: not found")]
    assert result.joined == ["beta", "gamma"]
    assert state["groups"]["alpha"]["status"] == "failed"
    assert "not found" in state["groups"]["alpha"]["fail_reason"]
    assert state["groups"]["beta"]["status"] == "joined"
    assert result.attempted == ["alpha", "beta", "gamma"]


def test_unresolvable_group_is_a_per_group_failure(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path, groups=("ghost", "beta")))
    state = jg.build_initial_state(cfg)
    # The client knows only "beta" — "ghost" does not resolve.
    client = FakeClient(["beta"], filters=_folder_with_book())
    result = _run(client, cfg, state)
    assert result.joined == ["beta"]
    assert state["groups"]["ghost"]["status"] == "failed"
    assert "could not resolve" in state["groups"]["ghost"]["fail_reason"]


def test_personal_chat_is_refused(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path, groups=("someone", "beta")))
    state = jg.build_initial_state(cfg)
    client = FakeClient(
        ["beta"], user_handles={"someone"}, filters=_folder_with_book()
    )
    result = _run(client, cfg, state)
    assert "someone" not in client.joins
    assert result.joined == ["beta"]
    assert state["groups"]["someone"]["status"] == "failed"
    assert "personal chat" in state["groups"]["someone"]["fail_reason"]


# --- (d) the folder step -------------------------------------------------------

def test_folder_update_adds_peer(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path, groups=("alpha",)))
    state = jg.build_initial_state(cfg)
    folder = FakeFilter(2, FOLDER)
    client = FakeClient(["alpha"], filters=[folder])
    result = _run(client, cfg, state)
    assert result.joined == ["alpha"]
    assert result.folder["alpha"] == "added"
    assert len(client.updates) == 1
    filter_id, new_filter = client.updates[0]
    assert filter_id == 2
    peer_ids = [p.channel_id for p in new_filter.include_peers]
    assert peer_ids == [100]  # the alpha entity's channel id
    assert state["groups"]["alpha"]["folder"] == "added"


def test_folder_already_there_sends_no_update(tmp_path, fake_requests):
    cfg = load_config(_cfg(tmp_path, groups=("alpha",)))
    state = jg.build_initial_state(cfg)
    peer = SimpleNamespace(channel_id=100, access_hash=1100)
    folder = FakeFilter(2, FOLDER, include_peers=[peer])
    client = FakeClient(["alpha"], filters=[folder])
    result = _run(client, cfg, state)
    assert result.joined == ["alpha"]
    assert result.folder["alpha"] == "already_there"
    assert client.updates == []


def test_folder_missing_skips_cleanly(tmp_path, fake_requests, capsys):
    cfg = load_config(_cfg(tmp_path, groups=("alpha", "beta")))
    state = jg.build_initial_state(cfg)
    # No folders at all, plus a folder with a different title.
    client = FakeClient(
        ["alpha", "beta"], filters=[FakeFilter(7, "Other stuff")]
    )
    result = _run(client, cfg, state)
    assert result.joined == ["alpha", "beta"]  # the run still completes
    assert result.folder == {
        "alpha": "folder_missing", "beta": "folder_missing"
    }
    assert client.updates == []
    assert "not found" in capsys.readouterr().out


def test_folder_flood_wait_stops_run_but_keeps_join(tmp_path, fake_requests):
    """A flood wait on the folder update stops the run — the join itself
    is kept (joined_at is set), the group is marked flood_wait so the
    next run retries it, and the retry (already a member) finishes the
    folder step."""
    cfg = load_config(_cfg(tmp_path, groups=("alpha", "beta")))
    state = jg.build_initial_state(cfg)
    # The folder update for alpha raises a flood wait.
    client = FakeClient(
        ["alpha", "beta"], filters=_folder_with_book(),
        flood_wait_on_update=600,
    )
    result = _run(client, cfg, state, now=NOW)
    assert result.joined == ["alpha"]
    assert result.stopped_by_flood_wait is True
    assert result.flood_wait == ("alpha", 600.0)
    assert result.attempted == ["alpha"]  # beta never attempted
    # The join is kept (joined_at set), but the group needs another
    # attempt for the folder step — hence flood_wait, not joined.
    assert state["groups"]["alpha"]["joined_at"] is not None
    assert state["groups"]["alpha"]["status"] == "flood_wait"
    assert state["groups"]["alpha"]["folder"] == "folder_error"
    assert state["groups"]["beta"]["status"] == "pending"
    # Next run, after the wait expires: alpha is already a member, and
    # the folder step completes; beta joins normally.
    client2 = FakeClient(
        ["alpha", "beta"], members={"alpha"}, filters=_folder_with_book()
    )
    result2 = _run(client2, cfg, state, now=NOW + timedelta(minutes=30))
    assert result2.already_member == ["alpha"]
    assert result2.joined == ["beta"]
    assert state["groups"]["alpha"]["folder"] == "added"
    assert state["groups"]["alpha"]["joined_at"] is not None


# --- (e) state round-trip -------------------------------------------------------

def test_state_round_trips(tmp_path):
    cfg = load_config(_cfg(tmp_path, groups=("alpha", "beta")))
    path = tmp_path / "join-state.json"
    state = jg.build_initial_state(cfg)
    jg.save_state(path, state)
    loaded = jg.load_state(path, cfg)
    assert loaded == state
    loaded["groups"]["alpha"]["status"] = "joined"
    loaded["groups"]["alpha"]["joined_at"] = "2026-11-07T21:00:00+00:00"
    loaded["groups"]["alpha"]["attempts"] = 1
    jg.save_state(path, loaded)
    assert jg.load_state(path, cfg)["groups"]["alpha"]["status"] == "joined"
    assert (
        jg.load_state(path, cfg)["groups"]["alpha"]["joined_at"]
        == "2026-11-07T21:00:00+00:00"
    )


def test_state_missing_file_builds_fresh_and_backfills_new_groups(tmp_path):
    cfg = load_config(_cfg(tmp_path, groups=("alpha", "beta")))
    path = tmp_path / "join-state.json"
    state = jg.load_state(path, cfg)  # missing file -> fresh
    assert list(state["groups"]) == ["alpha", "beta"]
    assert state["folder_title"] == FOLDER
    assert state["batch_size"] == 2
    assert state["delay_seconds"] == [120.0, 180.0]
    jg.save_state(path, state)
    # A group added to the config later appears as pending on load.
    cfg2 = load_config(_cfg(tmp_path, groups=("alpha", "beta", "gamma")))
    loaded = jg.load_state(path, cfg2)
    assert loaded["groups"]["gamma"]["status"] == "pending"
    assert loaded["groups"]["alpha"]["status"] == "pending"


def test_state_corrupt_file_is_refused(tmp_path):
    cfg = load_config(_cfg(tmp_path, groups=("alpha",)))
    path = tmp_path / "join-state.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        jg.load_state(path, cfg)


def test_real_join_state_file_v049():
    """The committed join-state.json: all 168 groups, with the owner's
    folder title and the batch size — and no dead handle. One group
    (All_kinds_Books_Lib) is flood_wait from the first scheduled run
    (2026-11-08), the other 167 are pending."""
    root = Path(__file__).resolve().parent.parent
    state = json.loads((root / "join-state.json").read_text(encoding="utf-8"))
    cfg = load_config(root / "channels.yaml")
    assert list(state["groups"]) == [g.name for g in cfg.groups]
    assert len(state["groups"]) == 168
    assert state["groups"]["All_kinds_Books_Lib"]["status"] == "flood_wait"
    assert sum(
        1 for v in state["groups"].values() if v["status"] == "pending"
    ) == 167
    assert state["folder_title"] == FOLDER
    assert state["batch_size"] == 2
    assert state["delay_seconds"] == [120.0, 180.0]
    assert "KOTOBPDFFF" not in state["groups"]
    assert "mystery_books_ar" not in state["groups"]


# --- the real Telethon factories (importorskip: optional dependency) -----------

def test_real_telethon_factories_build():
    """The lazy factories build real TL objects — and rebuilding a
    folder copies the title object unchanged (a plain string title
    fails to serialise in Telethon 1.45)."""
    telethon = pytest.importorskip("telethon")
    from telethon.tl.types import (
        DialogFilter,
        InputPeerChannel,
        TextWithEntities,
    )

    entity = SimpleNamespace(id=100, access_hash=1100)
    join_req = jg._join_request(entity)
    assert type(join_req).__name__ == "JoinChannelRequest"
    assert join_req.channel is entity
    part_req = jg._get_participant_request(entity)
    assert type(part_req).__name__ == "GetParticipantRequest"
    assert type(part_req.participant).__name__ == "InputPeerSelf"
    assert type(jg._get_filters_request()).__name__ == "GetDialogFiltersRequest"
    old = DialogFilter(
        id=2, title=TextWithEntities(text=FOLDER, entities=[]),
        pinned_peers=[], include_peers=[], exclude_peers=[],
    )
    peer = InputPeerChannel(channel_id=100, access_hash=1100)
    new = jg._rebuild_filter(old, [peer])
    assert new.title is old.title  # the title object is passed back unchanged
    assert jg._filter_title(new) == FOLDER
    assert new.include_peers == [peer]
    bytes(new)  # serialises (a str title would raise TypeError here)
    update = jg._update_filter_request(2, new)
    assert type(update).__name__ == "UpdateDialogFilterRequest"
    assert update.id == 2


# --- CLI end to end --------------------------------------------------------------

def _env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_API_ID", "12345")
    monkeypatch.setenv("TELEGRAM_API_HASH", "abcdef")
    monkeypatch.setenv("TELEGRAM_SESSION_STRING", "1A2B3C")


def test_join_groups_cli_writes_files(tmp_path, monkeypatch, fake_requests):
    cfg_path = _cfg(tmp_path, groups=("alpha", "beta", "gamma"))
    state_path = tmp_path / "join-state.json"
    newly = tmp_path / "newly-joined.txt"
    report = tmp_path / "join-report.md"
    _env(monkeypatch)
    fake = FakeClient(
        ["alpha", "beta", "gamma"], members={"beta"},
        filters=_folder_with_book(),
    )
    monkeypatch.setattr(cli_mod, "create_client", lambda *a: fake)
    assert main([
        "join-groups", "--config", str(cfg_path),
        "--state", str(state_path),
        "--newly-joined", str(newly), "--report", str(report),
        "--batch", "2", "--delay-min", "0", "--delay-max", "0",
        "--entity-cache", str(tmp_path / "entity-cache.json"),
    ]) == 0
    assert fake.started and fake.disconnected
    # Batch 2: alpha (joined) + beta (already a member). Gamma untouched.
    assert newly.read_text(encoding="utf-8") == "alpha\n"
    report_text = report.read_text(encoding="utf-8")
    assert "alpha" in report_text
    assert "already a member" in report_text
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["groups"]["alpha"]["status"] == "joined"
    assert state["groups"]["beta"]["status"] == "already_member"
    assert state["groups"]["gamma"]["status"] == "pending"
    assert state["groups"]["gamma"]["attempts"] == 0


def test_join_groups_cli_zero_joined_still_writes_files(
    tmp_path, monkeypatch, fake_requests, capsys
):
    """A run that joins nothing (flood wait on the first group) still
    exits 0 and still writes the (empty) newly-joined file + report +
    state — the workflow commits them instead of failing."""
    cfg_path = _cfg(tmp_path, groups=("alpha", "beta"))
    state_path = tmp_path / "join-state.json"
    newly = tmp_path / "newly-joined.txt"
    report = tmp_path / "join-report.md"
    _env(monkeypatch)
    fake = FakeClient(
        ["alpha", "beta"], flood_wait_on="alpha",
        filters=_folder_with_book(),
    )
    monkeypatch.setattr(cli_mod, "create_client", lambda *a: fake)
    assert main([
        "join-groups", "--config", str(cfg_path),
        "--state", str(state_path),
        "--newly-joined", str(newly), "--report", str(report),
        "--batch", "2", "--delay-min", "0", "--delay-max", "0",
        "--entity-cache", str(tmp_path / "entity-cache.json"),
    ]) == 0
    assert newly.read_text(encoding="utf-8") == ""
    assert "Flood wait" in report.read_text(encoding="utf-8")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["groups"]["alpha"]["status"] == "flood_wait"
    assert state["flood_wait_seconds"] == 3600


def test_join_groups_cli_missing_credentials(tmp_path, monkeypatch, capsys):
    cfg_path = _cfg(tmp_path)
    for var in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION_STRING"):
        monkeypatch.delenv(var, raising=False)
    assert main([
        "join-groups", "--config", str(cfg_path),
        "--state", str(tmp_path / "join-state.json"),
        "--entity-cache", str(tmp_path / "entity-cache.json"),
    ]) == 2
    assert "missing" in capsys.readouterr().err.lower()
