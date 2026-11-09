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
    """v0.4.6: the slow-join job runs every 12 h (2 groups/run), shares
    the telegram concurrency group, indexes only the newly joined
    groups, publishes the join state with the site, and commits the
    state alone when nothing was joined (a zero-joined run is not a
    failure)."""
    doc = _load(JOIN)
    # NOTE: PyYAML (YAML 1.1) parses the `on:` key as boolean True.
    on = doc[True]
    crons = [s["cron"] for s in on["schedule"]]
    assert crons == ["0 */12 * * *"]
    assert on["workflow_dispatch"]["inputs"]["batch"]["default"] == "2"
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


def test_version_is_0_6_1():
    """pyproject, package __init__, and both docs agree on v0.6.1."""
    pyproject = (
        REPO_ROOT / "telegram" / "pyproject.toml"
    ).read_text(encoding="utf-8")
    assert re.search(r'^version = "0\.6\.1"$', pyproject, re.M)
    init = (
        REPO_ROOT / "telegram" / "tbi" / "__init__.py"
    ).read_text(encoding="utf-8")
    assert '__version__ = "0.6.1"' in init
    readme = (REPO_ROOT / "telegram" / "README.md").read_text(encoding="utf-8")
    assert readme.startswith("# telegram-book-index (v0.6.1")
    guide = (
        REPO_ROOT / "telegram" / "PUSH_GUIDE.md"
    ).read_text(encoding="utf-8")
    assert guide.startswith(
        "# Publishing the Telegram merge into kindle-opds-static (v0.6.1)"
    )


# --- v0.4.7: rebase before push -------------------------------------------
# Run 42406045618 (2026-11-07) ran 1h22m and failed at the final push:
# v0.4.6 was pushed mid-run, so the plain `git push` was rejected
# (non-fast-forward) and the run's commit — which existed only on the
# ephemeral runner — was lost. Every push in every telegram workflow
# must now be preceded by a rebase, and force-push is never used.

WORKFLOWS = [SYNC, API, JOIN]
REBASE = "git pull --rebase --autostash origin main"


def _push_steps(doc, job: str):
    """Steps that push (Publish, join-state, failure-save) — every
    `git push` in them must be preceded by a rebase in the same step."""
    for step in doc["jobs"][job]["steps"]:
        run = step.get("run", "")
        if "git push" in run:
            yield step.get("name", "?"), run


def test_rebase_before_every_push():
    """Every `git push` in every telegram workflow is preceded by a
    `git pull --rebase` in the same step — Publish, join-state, and
    failure-save alike. The rebase must be the autostash form: the
    failure-save rebases with uncommitted progress files, and a plain
    rebase refuses with unstaged changes."""
    for path in WORKFLOWS:
        doc = _load(path)
        for job in doc["jobs"]:
            for name, run in _push_steps(doc, job):
                pushes = [m.start() for m in re.finditer(r"git push\b", run)]
                rebases = [
                    m.start() for m in re.finditer(r"git pull --rebase\b", run)
                ]
                assert pushes, f"{path.name} step {name!r}: expected a git push"
                assert rebases, (
                    f"{path.name} step {name!r}: git push without a "
                    "preceding rebase"
                )
                for p in pushes:
                    assert any(r < p for r in rebases), (
                        f"{path.name} step {name!r}: a git push has no "
                        "git pull --rebase before it"
                    )
                assert REBASE in run, (
                    f"{path.name} step {name!r}: rebase must be "
                    f"`{REBASE}`"
                )


def test_no_force_push_anywhere():
    """No workflow may ever force-push: it would discard the other
    writer's commits — the exact data loss the rebase fix prevents."""
    for path in WORKFLOWS:
        text = path.read_text(encoding="utf-8")
        assert "git push --force" not in text, f"{path.name} has a force-push"
        assert "push -f" not in text, f"{path.name} has a force-push"
        assert "force-with-lease" not in text, f"{path.name} has a force-push"


def test_failure_save_rebases_before_add_and_retries_push():
    """The failure-save rebase must come BEFORE the add/commit (so the
    progress commit is built on the current remote head), and its push
    must be retried once after a rebase (single retry, not a loop)."""
    for path in WORKFLOWS:
        doc = _load(path)
        for job in doc["jobs"]:
            failure = _step(doc, job, "Save progress")
            run = failure["run"]
            rebase = run.index("git pull --rebase")
            first_add = run.index("git add")
            assert rebase < first_add, (
                f"{path.name}: failure-save rebase must precede the "
                "first git add"
            )
            assert "if ! git push; then" in run, (
                f"{path.name}: failure-save push needs a single-retry block"
            )
            retry = run[run.index("if ! git push") :]
            assert "git pull --rebase" in retry, (
                f"{path.name}: push retry must rebase before pushing again"
            )
            assert retry.count("git push") == 2, (
                f"{path.name}: push retry must push exactly once more"
            )
            assert not re.search(r"\b(for|while)\b", retry), (
                f"{path.name}: push retry must not be a loop"
            )


# --- v0.4.8: the entity cache is committed by the API workflows ------------
# The 2026-11-07 api-backfill run failed in 24 s: every source hit a
# ~20-hour ResolveUsernameRequest flood wait, because every run
# resolved all 211 handles (the Telethon entity cache is empty on
# every ephemeral runner). The persistent entity cache
# (entity-cache.json) fixes that — but only if the workflows actually
# commit it, in the Publish step AND the failure-save (and the
# join-groups "commit join state only" step). The daily preview sync
# never uses the API, so it must not touch the cache.

API_WORKFLOWS = [API, JOIN]


def test_api_workflows_commit_entity_cache():
    """Both API workflows `git add` entity-cache.json in every step
    that commits (Publish, join-state-only, failure-save) — otherwise
    the resolved handles are lost with the runner and the next run
    re-resolves everything (the 2026-11-07 flood wait, again)."""
    for path in API_WORKFLOWS:
        doc = _load(path)
        for job in doc["jobs"]:
            for step in doc["jobs"][job]["steps"]:
                run = step.get("run", "")
                if "git add" not in run:
                    continue
                assert "entity-cache.json" in run, (
                    f"{path.name} step {step.get('name', '?')!r}: "
                    "a committing step that does not add entity-cache.json"
                )


def test_preview_sync_does_not_touch_entity_cache():
    """The daily preview sync never uses the API (no Telethon, no
    resolve calls), so it must not commit the entity cache."""
    text = SYNC.read_text(encoding="utf-8")
    assert "entity-cache" not in text
