"""Slow, safe group joining for the Telegram book index (v0.4.6).

The owner is a member of only ~5% of the 168 configured groups, and
the API (Telethon, acting as his account) can only read a group's
history once he is a member. This module closes that gap — slowly and
safely, on a schedule, with no terminal work from the owner:

* ``tbi join-groups`` picks a few ``pending`` groups per run (default
  3), checks membership first (never a redundant join request), joins
  them, and adds each joined group to the owner's Telegram chat folder
  (default title ``📚كتب``). The workflow
  (``.github/workflows/telegram-join-groups.yml``, every 12 hours)
  then indexes each newly joined group with the API backfill and
  publishes, so the catalogue fills in over ~4 weeks with zero
  intervention — the owner only checks ``join-state.json`` /
  ``join-report.md`` in the repo every few days.

**Safety model (hard conditions, same as the API backfill):**
  * Credentials live ONLY as GitHub Actions **secrets** — this module
    never reads them, never prints them, never sees them at all; the
    CLI loads them from the environment (``TELEGRAM_API_ID``,
    ``TELEGRAM_API_HASH``, ``TELEGRAM_SESSION_STRING``) exactly like
    ``tbi api-backfill``.
  * It reads **only configured groups** (``channels.yaml``) — never
    personal chats. A handle that resolves to a person (a user
    account) is refused, and a handle that is not in the config is
    never attempted (the batch is drawn from the config).
  * **Slow by design:** 3 groups per run, 2 runs a day (~6/day), with
    a long random pause (60–120 s) between join attempts inside a
    run. Joining is the most rate-limited thing a Telegram account
    can do; a bulk join would trigger a flood wait and could restrict
    the owner's account, so this module never hurries.
  * A **flood wait stops the whole run immediately** — no more groups
    are attempted, the wait (group + seconds + until-when) is recorded
    in the state file, and the next scheduled run does not attempt
    anything until the wait has expired. The state file is saved
    after every group, so a timeout kill never loses progress.
  * Per-group isolation: one group's failure (not found, private,
    needs admin approval, banned, …) is recorded with its reason and
    the run moves on to the next group.
  * The folder step is best-effort and never fails a group: when the
    folder is missing it is logged and skipped (never created
    automatically — the owner made it, the tool only adds to it).
  * **Metadata only, legal sources only, no file downloads** — this
    module only joins and organises; the indexing of a joined group
    is a separate step (the workflow's API backfill).

**State file (``join-state.json``, committed to the repo so it
persists across ephemeral GitHub runners):** one entry per group
handle — ``status`` (``pending`` / ``joined`` / ``already_member`` /
``failed`` / ``flood_wait``), ``joined_at``, ``fail_reason``,
``flood_wait_seconds``, ``attempts``, plus the folder-step outcome —
and the run settings (folder title, batch size, delay range) plus the
active flood wait, if any. A ``failed`` group is never retried
automatically; to retry one, set its ``status`` back to ``pending``
in ``join-state.json`` (see README "Slow group joining").

**Telethon is an optional dependency.** This module imports cleanly
without it installed; Telethon's TL request objects are built by the
small ``_join_request`` / ``_get_participant_request`` /
``_get_filters_request`` / ``_update_filter_request`` /
``_rebuild_filter`` factories, imported lazily, so the whole join
engine is testable offline with a fake client and no credentials
(the tests monkeypatch the factories, the same seam the API tests
use for ``create_client``).
"""

from __future__ import annotations

import asyncio
import json
import os
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from .config import Config

# The owner's chat folder (Telegram chat folder / "section") that the
# joined groups are organised into. Created by the owner in Telegram;
# the tool only adds to it, never creates it.
DEFAULT_FOLDER_TITLE = "📚كتب"
# Pace: 3 groups per run, 2 runs a day (every 12 h) = ~6 groups/day.
# ~160 groups to join => ~27 days for the full sweep (failures, which
# are marked and never retried, shorten it; flood waits lengthen it).
DEFAULT_BATCH_SIZE = 3
# Long pause between join attempts inside a run (a random value in
# this range each time, so the joins do not look metronomic).
DEFAULT_DELAY_MIN_S = 60.0
DEFAULT_DELAY_MAX_S = 120.0

STATUS_PENDING = "pending"
STATUS_JOINED = "joined"
STATUS_ALREADY_MEMBER = "already_member"
STATUS_FAILED = "failed"
STATUS_FLOOD_WAIT = "flood_wait"
# Statuses a run picks up: pending groups, plus groups whose previous
# attempt was cut short by a flood wait (retried once the wait has
# expired — see the run-start gate in join_pending).
_RETRYABLE = (STATUS_PENDING, STATUS_FLOOD_WAIT)

# Folder-step outcomes, recorded per group in the state file.
FOLDER_ADDED = "added"
FOLDER_ALREADY_THERE = "already_there"
FOLDER_MISSING = "folder_missing"
FOLDER_ERROR = "folder_error"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(text: Optional[str]):
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# --- state file ------------------------------------------------------------

def _new_entry() -> dict:
    return {
        "status": STATUS_PENDING,
        "joined_at": None,
        "fail_reason": None,
        "flood_wait_seconds": None,
        "attempts": 0,
        "folder": None,
    }


def build_initial_state(
    cfg: Config,
    *,
    folder_title: str = DEFAULT_FOLDER_TITLE,
    batch_size: int = DEFAULT_BATCH_SIZE,
    delay_min: float = DEFAULT_DELAY_MIN_S,
    delay_max: float = DEFAULT_DELAY_MAX_S,
) -> dict:
    """Fresh state: every configured group ``pending``, in config order.

    The dead handles and private invites at the bottom of
    ``channels.yaml`` are comments, not group entries, so they never
    appear here (and are never joined).
    """
    return {
        "version": 1,
        "folder_title": folder_title,
        "batch_size": batch_size,
        "delay_seconds": [delay_min, delay_max],
        "flood_wait_until": None,
        "flood_wait_seconds": None,
        "flood_wait_group": None,
        "groups": {entry.name: _new_entry() for entry in cfg.groups},
    }


def _ensure_entries(state: dict, cfg: Config) -> None:
    """Backfill state entries for groups added to the config later,
    and fill in any missing top-level keys (forward-compatible)."""
    groups = state.setdefault("groups", {})
    for entry in cfg.groups:
        if entry.name not in groups:
            groups[entry.name] = _new_entry()
        else:
            # Fill in any per-entry key a future version adds.
            for key, value in _new_entry().items():
                groups[entry.name].setdefault(key, value)
    state.setdefault("version", 1)
    state.setdefault("folder_title", DEFAULT_FOLDER_TITLE)
    state.setdefault("batch_size", DEFAULT_BATCH_SIZE)
    state.setdefault("delay_seconds", [DEFAULT_DELAY_MIN_S, DEFAULT_DELAY_MAX_S])
    state.setdefault("flood_wait_until", None)
    state.setdefault("flood_wait_seconds", None)
    state.setdefault("flood_wait_group", None)


def load_state(path: str | Path, cfg: Config) -> dict:
    """Load ``join-state.json``; build a fresh one when it is missing.

    A corrupt state file is refused loudly (never silently reset —
    the file is the record of weeks of slow joins).
    """
    path = Path(path)
    if not path.is_file():
        return build_initial_state(cfg)
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError(f"{path}: join state is not valid JSON: {exc}")
    if not isinstance(state, dict) or not isinstance(
        state.get("groups"), dict
    ):
        raise ValueError(
            f"{path}: join state must be a JSON object with a "
            "'groups' mapping"
        )
    _ensure_entries(state, cfg)
    return state


def save_state(path: str | Path, state: dict) -> None:
    """Save the state atomically (temp file + replace), so a kill
    mid-write never leaves a half-written state file behind."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, path)


def pending_groups(state: dict) -> list[str]:
    """Group handles a run may attempt, in state-file order."""
    return [
        name
        for name, entry in state.get("groups", {}).items()
        if entry.get("status") in _RETRYABLE
    ]


def is_flood_wait_active(state: dict, now: Optional[datetime] = None) -> bool:
    """True when a recorded flood wait has not expired yet."""
    until = _parse_iso(state.get("flood_wait_until"))
    if until is None:
        return False
    return (now or datetime.now(timezone.utc)) < until


# --- Telethon request factories (lazy import = testable offline) -----------

def _join_request(entity):
    """Telethon's JoinChannelRequest, built lazily (see module docstring)."""
    from telethon.tl.functions.channels import JoinChannelRequest

    return JoinChannelRequest(channel=entity)


def _get_participant_request(entity):
    """channels.GetParticipantRequest for the owner (InputPeerSelf)."""
    from telethon.tl.functions.channels import GetParticipantRequest
    from telethon.tl.types import InputPeerSelf

    return GetParticipantRequest(channel=entity, participant=InputPeerSelf())


def _get_filters_request():
    """messages.GetDialogFiltersRequest (list the chat folders)."""
    from telethon.tl.functions.messages import GetDialogFiltersRequest

    return GetDialogFiltersRequest()


def _update_filter_request(filter_id: int, dialog_filter):
    """messages.UpdateDialogFilterRequest for one folder."""
    from telethon.tl.functions.messages import UpdateDialogFilterRequest

    return UpdateDialogFilterRequest(id=filter_id, filter=dialog_filter)


def _rebuild_filter(old, include_peers):
    """A copy of ``old`` with ``include_peers`` replaced.

    Every field is copied from the folder Telegram returned — the
    title object especially is passed back unchanged (in Telethon
    1.45 it is a TextWithEntities, and a plain string fails to
    serialise), so the update cannot clobber the folder's settings.
    """
    from telethon.tl.types import DialogFilter

    return DialogFilter(
        id=getattr(old, "id"),
        title=getattr(old, "title"),
        pinned_peers=list(getattr(old, "pinned_peers", []) or []),
        include_peers=list(include_peers),
        exclude_peers=list(getattr(old, "exclude_peers", []) or []),
        contacts=getattr(old, "contacts", None),
        non_contacts=getattr(old, "non_contacts", None),
        groups=getattr(old, "groups", None),
        broadcasts=getattr(old, "broadcasts", None),
        bots=getattr(old, "bots", None),
        exclude_muted=getattr(old, "exclude_muted", None),
        exclude_read=getattr(old, "exclude_read", None),
        exclude_archived=getattr(old, "exclude_archived", None),
        title_noanimate=getattr(old, "title_noanimate", None),
        emoticon=getattr(old, "emoticon", None),
        color=getattr(old, "color", None),
    )


# --- small duck-typed helpers (same style as tbi/api_history.py) -----------

def _is_user_entity(entity) -> bool:
    """True when the resolved entity is a person (a user account).

    Duck-typed on the class name so no Telethon import is needed: the
    joiner must never touch a personal chat, even if its handle
    somehow ended up in the config.
    """
    return type(entity).__name__ == "User"


def _flood_wait_seconds(exc) -> Optional[float]:
    """Seconds of a Telethon FloodWaitError, or None.

    Duck-typed on the ``.seconds`` attribute (the same seam
    ``iter_api_posts`` uses), so no Telethon import is needed.
    """
    seconds = getattr(exc, "seconds", None)
    if seconds is None:
        return None
    try:
        return float(seconds)
    except (TypeError, ValueError):
        return None


def _is_not_participant(exc) -> bool:
    """True for Telethon's UserNotParticipantError (duck-typed)."""
    return type(exc).__name__ == "UserNotParticipantError"


def _is_already_participant(exc) -> bool:
    """True for Telethon's UserAlreadyParticipantError (duck-typed)."""
    return type(exc).__name__ == "UserAlreadyParticipantError"


def _filter_title(dialog_filter) -> str:
    """A folder's title as plain text (TextWithEntities -> .text)."""
    title = getattr(dialog_filter, "title", "")
    text = getattr(title, "text", None)
    return text if isinstance(text, str) else str(title or "")


def _peer_channel_id(peer) -> Optional[int]:
    """An InputPeer's channel id (None for other peer kinds)."""
    channel_id = getattr(peer, "channel_id", None)
    return int(channel_id) if isinstance(channel_id, int) else None


# --- membership + folder ----------------------------------------------------

async def _is_member(client, entity) -> Optional[bool]:
    """Whether the owner is already a member of ``entity``.

    True = member, False = definitely not, None = the check itself
    failed (the join is then attempted anyway — an already-member
    join is a no-op success, see ``join_pending``).
    """
    try:
        await client(_get_participant_request(entity))
    except Exception as exc:  # noqa: BLE001 - duck-typed error kinds
        if _is_not_participant(exc):
            return False
        return None
    return True


async def _add_to_folder(client, entity, folder_title: str):
    """Add ``entity`` to the chat folder titled ``folder_title``.

    Returns ``(outcome, flood_wait_seconds)`` where outcome is one of
    ``added`` / ``already_there`` / ``folder_missing`` /
    ``folder_error: <reason>``. Best-effort by design: it never raises
    (a folder problem must never fail the group it belongs to), except
    that a flood wait is reported back so the run can stop.
    """
    try:
        peer = await client.get_input_entity(entity)
    except Exception as exc:  # noqa: BLE001 - best-effort folder step
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            return (FOLDER_ERROR, seconds)
        return (f"{FOLDER_ERROR}: could not resolve the group: {exc}", None)
    try:
        result = await client(_get_filters_request())
    except Exception as exc:  # noqa: BLE001 - best-effort folder step
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            return (FOLDER_ERROR, seconds)
        return (f"{FOLDER_ERROR}: could not list the chat folders: {exc}", None)
    # GetDialogFiltersRequest returns messages.DialogFilters (.filters);
    # tolerate a bare list too (fake clients).
    filters = getattr(result, "filters", result) or []
    folder = None
    for candidate in filters:
        if _filter_title(candidate) == folder_title:
            folder = candidate
            break
    if folder is None:
        return (FOLDER_MISSING, None)
    include = list(getattr(folder, "include_peers", []) or [])
    peer_id = _peer_channel_id(peer)
    if peer_id is not None and any(
        _peer_channel_id(p) == peer_id for p in include
    ):
        return (FOLDER_ALREADY_THERE, None)
    try:
        await client(
            _update_filter_request(
                getattr(folder, "id"), _rebuild_filter(folder, include + [peer])
            )
        )
    except Exception as exc:  # noqa: BLE001 - best-effort folder step
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            return (FOLDER_ERROR, seconds)
        return (f"{FOLDER_ERROR}: could not update the folder: {exc}", None)
    return (FOLDER_ADDED, None)


# --- the join engine ----------------------------------------------------------

@dataclass
class JoinResult:
    """What one ``tbi join-groups`` run did."""

    joined: list[str] = field(default_factory=list)
    already_member: list[str] = field(default_factory=list)
    failed: list[tuple] = field(default_factory=list)  # (name, reason)
    flood_wait: Optional[tuple] = None  # (group, seconds)
    stopped_by_flood_wait: bool = False
    folder: dict = field(default_factory=dict)  # name -> folder outcome
    attempted: list[str] = field(default_factory=list)


async def _attempt_one(client, state: dict, name: str, folder_title: str,
                     result: JoinResult, moment: datetime) -> bool:
    """Attempt one group: resolve, membership check, join, folder.

    Returns True when the run must stop immediately (a flood wait) —
    False otherwise (success, already a member, or a per-group
    failure that is recorded and moved past). Never raises: every
    failure is recorded on the group's state entry.
    """
    entry = state["groups"][name]

    def _record_flood_wait(seconds: float) -> None:
        until = moment + timedelta(seconds=seconds)
        state["flood_wait_until"] = until.isoformat()
        state["flood_wait_seconds"] = seconds
        state["flood_wait_group"] = name
        entry["status"] = STATUS_FLOOD_WAIT
        entry["flood_wait_seconds"] = seconds
        result.flood_wait = (name, seconds)
        result.stopped_by_flood_wait = True
        print(
            f"[flood-wait] Telegram rate-limited the account on @{name} "
            f"({seconds:g}s) — stopping the run now; the next scheduled "
            f"run retries after {until.isoformat()}.",
            flush=True,
        )

    try:
        entity = await client.get_entity(name)
    except Exception as exc:  # noqa: BLE001 - per-group isolation
        seconds = _flood_wait_seconds(exc)
        if seconds is not None:
            _record_flood_wait(seconds)
            return True
        entry["status"] = STATUS_FAILED
        entry["fail_reason"] = f"could not resolve the group: {exc}"
        result.failed.append((name, entry["fail_reason"]))
        print(f"[failed] @{name}: {entry['fail_reason']}", flush=True)
        return False
    if _is_user_entity(entity):
        entry["status"] = STATUS_FAILED
        entry["fail_reason"] = (
            "resolved to a personal chat — refused (the joiner "
            "only reads configured groups)"
        )
        result.failed.append((name, entry["fail_reason"]))
        print(f"[failed] @{name}: {entry['fail_reason']}", flush=True)
        return False
    member = await _is_member(client, entity)
    if member is None:
        print(
            f"[note] @{name}: membership check failed — trying "
            "the join; an already-member join is a no-op.",
            flush=True,
        )
    if member is True:
        entry["status"] = STATUS_ALREADY_MEMBER
        result.already_member.append(name)
        print(f"[already] @{name}: already a member — no join sent",
              flush=True)
    else:
        try:
            await client(_join_request(entity))
        except Exception as exc:  # noqa: BLE001 - per-group isolation
            seconds = _flood_wait_seconds(exc)
            if seconds is not None:
                _record_flood_wait(seconds)
                return True
            if _is_already_participant(exc):
                entry["status"] = STATUS_ALREADY_MEMBER
                result.already_member.append(name)
                print(
                    f"[already] @{name}: already a member (join "
                    "was a no-op)",
                    flush=True,
                )
            else:
                entry["status"] = STATUS_FAILED
                entry["fail_reason"] = f"join failed: {exc}"
                result.failed.append((name, entry["fail_reason"]))
                print(f"[failed] @{name}: {entry['fail_reason']}",
                      flush=True)
                return False
        else:
            entry["status"] = STATUS_JOINED
            entry["joined_at"] = _now_iso()
            entry["fail_reason"] = None
            result.joined.append(name)
            print(f"[joined] @{name}", flush=True)
    # Folder step (best-effort): for a newly joined group and for a
    # group he was already a member of — both belong in the owner's
    # folder.
    outcome, flood_seconds = await _add_to_folder(client, entity, folder_title)
    entry["folder"] = outcome
    result.folder[name] = outcome
    if outcome == FOLDER_ADDED:
        print(f"[folder] @{name}: added to “{folder_title}”", flush=True)
    elif outcome == FOLDER_ALREADY_THERE:
        print(f"[folder] @{name}: already in “{folder_title}”", flush=True)
    elif outcome == FOLDER_MISSING:
        print(
            f"[folder] @{name}: folder “{folder_title}” not "
            "found — skipped (the folder is never created "
            "automatically)",
            flush=True,
        )
    else:
        print(f"[folder] @{name}: {outcome}", flush=True)
    if flood_seconds is not None:
        _record_flood_wait(flood_seconds)
        return True
    return False


async def join_pending(
    client,
    cfg: Config,
    state: dict,
    *,
    batch: int = DEFAULT_BATCH_SIZE,
    delay_min: float = DEFAULT_DELAY_MIN_S,
    delay_max: float = DEFAULT_DELAY_MAX_S,
    folder_title: str = DEFAULT_FOLDER_TITLE,
    sleep=asyncio.sleep,
    on_update=None,
    now: Optional[datetime] = None,
) -> JoinResult:
    """Join up to ``batch`` pending groups, slowly and safely.

    ``on_update`` (called with the state after every group) is how the
    caller persists progress incrementally — the workflow's CLI passes
    a saver, so a timeout kill never loses a join. ``sleep`` is
    injectable for tests (defaults to ``asyncio.sleep``).
    """
    result = JoinResult()
    moment = now or datetime.now(timezone.utc)
    _ensure_entries(state, cfg)

    # Gate: a flood wait recorded by an earlier run is still active —
    # attempt nothing; the next scheduled run retries after it expires.
    if is_flood_wait_active(state, moment):
        until = state.get("flood_wait_until")
        result.stopped_by_flood_wait = True
        seconds = state.get("flood_wait_seconds")
        if seconds is not None:
            result.flood_wait = (state.get("flood_wait_group") or "", float(seconds))
        print(
            f"[flood-wait] skipping this run — the last run was flood-"
            f"limited until {until}; the next scheduled run retries.",
            flush=True,
        )
        return result

    # The wait has expired: clear it, and let groups cut short by it
    # be attempted again (their status returns to pending).
    if state.get("flood_wait_until") is not None:
        state["flood_wait_until"] = None
        state["flood_wait_seconds"] = None
        state["flood_wait_group"] = None
        for entry in state.get("groups", {}).values():
            if entry.get("status") == STATUS_FLOOD_WAIT:
                entry["status"] = STATUS_PENDING

    names = pending_groups(state)[: max(batch, 0)]
    if not names:
        print("[join-groups] no pending groups — the sweep is done.",
              flush=True)
        return result

    for index, name in enumerate(names):
        entry = state["groups"][name]
        entry["attempts"] = int(entry.get("attempts") or 0) + 1
        result.attempted.append(name)
        try:
            stopped = await _attempt_one(
                client, state, name, folder_title, result, moment
            )
        finally:
            if on_update is not None:
                on_update(state)
        if stopped:
            break
        # Long pause before the next attempt — never after the last one.
        if index < len(names) - 1:
            pause = random.uniform(delay_min, delay_max)
            print(
                f"[pause] waiting {pause:.0f}s before the next group "
                "(slow by design)",
                flush=True,
            )
            await sleep(pause)
    return result


# --- report -------------------------------------------------------------------

def build_join_report(result: JoinResult, state: dict) -> str:
    """Markdown record of one join run (``join-report.md``)."""
    lines = [
        "# Telegram group-join report (slow join, v0.4.6)",
        "",
        f"Run at {_now_iso()} — batch: up to "
        f"{state.get('batch_size', DEFAULT_BATCH_SIZE)} groups per run, "
        "every 12 h (~6 groups/day).",
        "",
    ]
    if result.stopped_by_flood_wait and not result.attempted:
        lines.append(
            "Skipped: a flood wait from an earlier run is still active "
            f"(until {state.get('flood_wait_until')}). No group was "
            "attempted; the next scheduled run retries."
        )
        lines.append("")
    else:
        lines.append(
            f"Joined: {len(result.joined)} | already a member: "
            f"{len(result.already_member)} | failed: "
            f"{len(result.failed)}"
            + (
                f" | stopped by a flood wait on "
                f"@{result.flood_wait[0]} ({result.flood_wait[1]:g}s)"
                if result.stopped_by_flood_wait and result.flood_wait
                else ""
            )
        )
        lines.append("")
    if result.joined:
        lines.append("## Newly joined")
        lines.append("")
        for name in result.joined:
            folder = result.folder.get(name, "")
            lines.append(
                f"- @{name}"
                + (f" — folder: {folder}" if folder else "")
            )
        lines.append("")
    if result.already_member:
        lines.append("## Already a member (no join sent)")
        lines.append("")
        for name in result.already_member:
            folder = result.folder.get(name, "")
            lines.append(
                f"- @{name}"
                + (f" — folder: {folder}" if folder else "")
            )
        lines.append("")
    if result.failed:
        lines.append("## Failed (recorded, never retried automatically)")
        lines.append("")
        for name, reason in result.failed:
            lines.append(f"- @{name}: {reason}")
        lines.append("")
        lines.append(
            "To retry one, set its `status` back to `pending` in "
            "`join-state.json`."
        )
        lines.append("")
    if result.stopped_by_flood_wait and result.flood_wait:
        lines.append(
            "## Flood wait"
        )
        lines.append("")
        lines.append(
            f"Telegram rate-limited the account on "
            f"@{result.flood_wait[0]} ({result.flood_wait[1]:g}s). The "
            "run stopped immediately; the wait is recorded in "
            f"`join-state.json` (until {state.get('flood_wait_until')}) "
            "and the next scheduled run retries after it expires."
        )
        lines.append("")
    groups = state.get("groups", {})
    counts = {}
    for entry in groups.values():
        status = entry.get("status", STATUS_PENDING)
        counts[status] = counts.get(status, 0) + 1
    lines.append("## Overall progress")
    lines.append("")
    for status in (
        STATUS_JOINED,
        STATUS_ALREADY_MEMBER,
        STATUS_PENDING,
        STATUS_FAILED,
        STATUS_FLOOD_WAIT,
    ):
        lines.append(f"- {status}: {counts.get(status, 0)}")
    lines.append(f"- total groups: {len(groups)}")
    lines.append("")
    lines.append(
        "The newly joined groups are indexed by the same run's API "
        "backfill step (`tbi api-backfill --channel <name> --backfill "
        "--backfill-block 3000`) and published with the catalogue; "
        "see `index-report.md` for the indexed posts."
    )
    lines.append("")
    return "\n".join(lines)
