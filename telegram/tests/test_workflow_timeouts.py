"""Tests for the workflow timeouts + failure-save (v0.4.2).

The first manual telegram-sync run (2026-11-07) failed after 1h 40m:
the Index step hit its old 100-minute limit mid-channel (@twinkling4,
~540 posts into its block) and nothing was committed, so ~33,900
posts / ~9,100 book files of progress were lost — the DB is only
committed at the end (Publish step) and the timeout kill skips the
tool's finally-block report, so the old failure step (report-only)
had nothing to commit either. The fix: the Index step allows 300
minutes, the job 360 (GitHub's per-job maximum), the backfill block
stays 3000, and the failure step saves the run's progress (WAL
checkpoint + validate + compressed seed) instead of only trying to
commit a report the timeout kill never wrote.
"""

import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SYNC = REPO_ROOT / ".github" / "workflows" / "telegram-sync.yml"
API = REPO_ROOT / ".github" / "workflows" / "telegram-api-backfill.yml"
JOIN = REPO_ROOT / ".github" / "workflows" / "telegram-join-groups.yml"


def _load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _step(doc, job: str, name_fragment: str):
    for step in doc["jobs"][job]["steps"]:
        if name_fragment in step.get("name", ""):
            return step
    raise AssertionError(f"no step matching {name_fragment!r} in {job}")


def test_sync_timeouts():
    """Sync job 360, Index step 300, backfill block still 3000."""
    doc = _load(SYNC)
    assert doc["jobs"]["sync"]["timeout-minutes"] == 360
    index = _step(doc, "sync", "Index (backfill in blocks)")
    assert index["timeout-minutes"] == 300
    assert "--backfill-block 3000" in index["run"]


def test_sync_failure_step_saves_progress():
    """The failure step checkpoints the WAL, validates, and commits
    the compressed seed + report — it must not be report-only."""
    doc = _load(SYNC)
    failure = _step(doc, "sync", "Save progress")
    assert failure.get("if") == "failure()"
    run = failure["run"]
    assert "wal_checkpoint" in run  # WAL must merge before gzip
    assert "tbi validate" in run  # only a clean DB is saved
    assert "index.db.gz" in run  # the compressed seed is committed
    assert "progress + report saved" in run


def test_api_backfill_timeouts():
    """API job 360, Index step 300, backfill block input still 3000."""
    doc = _load(API)
    assert doc["jobs"]["api-backfill"]["timeout-minutes"] == 360
    index = _step(doc, "api-backfill", "Index (API backfill)")
    assert index["timeout-minutes"] == 300
    assert 'default: "3000"' in API.read_text(encoding="utf-8")


def test_api_backfill_failure_step_saves_progress():
    """Same failure-save behaviour as the daily job."""
    doc = _load(API)
    failure = _step(doc, "api-backfill", "Save progress")
    assert failure.get("if") == "failure()"
    run = failure["run"]
    assert "wal_checkpoint" in run
    assert "tbi validate" in run
    assert "index.db.gz" in run
    assert "progress + report saved" in run


def test_join_groups_workflow():
    """v0.4.6: the slow-join job runs every 12 h (3 groups/run), shares
    the telegram concurrency group, indexes only the newly joined
    groups, publishes the join state with the site, and commits the
    state alone when nothing was joined (a zero-joined run is not a
    failure)."""
    doc = _load(JOIN)
    # NOTE: PyYAML (YAML 1.1) parses the `on:` key as boolean True.
    on = doc[True]
    crons = [s["cron"] for s in on["schedule"]]
    assert crons == ["0 */12 * * *"]
    assert on["workflow_dispatch"]["inputs"]["batch"]["default"] == "3"
    assert doc["concurrency"]["group"] == "kindle-opds-static-telegram-sync"
    assert doc["concurrency"]["cancel-in-progress"] is False
    assert doc["permissions"]["contents"] == "write"
    job = doc["jobs"]["join-groups"]
    assert job["timeout-minutes"] == 120
    join = _step(doc, "join-groups", "Join groups")
    assert "tbi join-groups" in join["run"]
    check = _step(doc, "join-groups", "Check what was joined")
    assert check["id"] == "check"
    assert "GITHUB_OUTPUT" in check["run"]
    index = _step(doc, "join-groups", "Index newly joined groups")
    assert index["timeout-minutes"] == 60
    assert "tbi api-backfill" in index["run"]
    assert "--backfill-block 3000" in index["run"]
    assert "steps.check.outputs.joined == 'true'" in index["if"]
    publish = _step(doc, "join-groups", "Publish atomically")
    assert "telegram/join-state.json" in publish["run"]
    assert "telegram/join-report.md" in publish["run"]
    assert "index.db.gz" in publish["run"]
    state_only = _step(doc, "join-groups", "Commit join state only")
    assert "steps.check.outputs.joined != 'true'" in state_only["if"]
    assert "join-state.json" in state_only["run"]
    failure = _step(doc, "join-groups", "Save progress")
    assert failure.get("if") == "failure()"
    run = failure["run"]
    assert "wal_checkpoint" in run
    assert "tbi validate" in run
    assert "index.db.gz" in run
    assert "join-state.json" in run
    assert "progress + report saved" in run


def test_version_is_0_4_6():
    """pyproject, package __init__, and both docs agree on v0.4.6."""
    pyproject = (
        REPO_ROOT / "telegram" / "pyproject.toml"
    ).read_text(encoding="utf-8")
    assert re.search(r'^version = "0\.4\.6"$', pyproject, re.M)
    init = (
        REPO_ROOT / "telegram" / "tbi" / "__init__.py"
    ).read_text(encoding="utf-8")
    assert '__version__ = "0.4.6"' in init
    readme = (REPO_ROOT / "telegram" / "README.md").read_text(encoding="utf-8")
    assert readme.startswith("# telegram-book-index (v0.4.6")
    guide = (
        REPO_ROOT / "telegram" / "PUSH_GUIDE.md"
    ).read_text(encoding="utf-8")
    assert guide.startswith(
        "# Publishing the Telegram merge into kindle-opds-static (v0.4.6)"
    )
