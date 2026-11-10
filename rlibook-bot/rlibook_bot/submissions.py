"""Owner submissions log: every /addchannel and /addbook submission.

Each submission is one JSON object per line in telegram/submissions.jsonl
in the repo (the owner's review sheet). The first line of the file is a
comment (starts with '#') describing the fields; readers skip it.

Fields: timestamp (UTC ISO), user_id, type (channel|book), title,
status (accepted|rejected|pending), reason.

Note on Railway: the bot runs there with only the rlibook-bot/ directory
as its service root — the repo is not checked out and there is no git, so
the repo path is usually not writable. log_submission therefore tries the
repo path first (RLIBOOK_SUBMISSIONS_PATH overrides it), then falls back
to a local submissions.jsonl next to the bot, and never raises: it returns
False (and logs a warning) if nothing could be written, so a logging
failure never breaks the user's command. The repo file is the durable
review sheet; the Railway-local fallback is ephemeral.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

log = logging.getLogger("rlibook-bot.submissions")

HEADER = (
    "# RliBook submissions log — one JSON object per line "
    "(lines starting with '#' are comments). Fields: timestamp (UTC ISO), "
    "user_id, type (channel|book), title, status "
    "(accepted|rejected|pending), reason.\n"
)


def _repo_path():
    """telegram/submissions.jsonl in the repo (two levels above this package)."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(os.path.dirname(here))
    return os.path.join(repo_root, "telegram", "submissions.jsonl")


def _local_fallback_path():
    """submissions.jsonl next to the bot (rlibook-bot/ service root)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), "submissions.jsonl")


def _append(path, line):
    exists = os.path.exists(path)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        if not exists:
            f.write(HEADER)
        f.write(line + "\n")


def log_submission(user_id, type_, title, status, reason, path=None, timestamp=None):
    """Append one submission record as a JSON line. Returns True on success.

    When path is given it is used as-is (no fallback) — callers and tests
    choose it explicitly. When path is None, the repo path is tried first
    and a local file next to the bot is the fallback. Never raises.
    """
    record = {
        "timestamp": timestamp
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "user_id": user_id,
        "type": type_,
        "title": title,
        "status": status,
        "reason": reason,
    }
    line = json.dumps(record, ensure_ascii=False)
    if path is not None:
        try:
            _append(path, line)
            return True
        except OSError as exc:
            log.warning("could not write submissions log %s: %s", path, exc)
            return False
    for candidate in (_repo_path(), _local_fallback_path()):
        try:
            _append(candidate, line)
            return True
        except OSError:
            continue
    log.warning("could not write submissions log anywhere (repo + local fallback)")
    return False
