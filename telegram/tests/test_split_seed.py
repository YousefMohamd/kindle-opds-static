"""Tests for the split-seed storage (v0.6.0).

The compressed DB (index.db.gz) is now ~66 MB, over Cloudflare Pages'
25 MB per-file limit, so a single index.db.gz breaks the deployment and
the site serves stale data. The seed is therefore stored as 20 MB parts
(index.db.gz.part-aa, ...), each under the limit, and the workflows
reassemble them (cat) before decompressing and re-split them on publish.

These tests check the workflow files (not the live DB): every workflow
must reassemble the parts, split on publish and on failure-save, and
never commit the single index.db.gz. The byte-exact round-trip of the
parts themselves is verified by the build (md5 of the reassembled file
must equal the md5 of the original index.db.gz).
"""

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = [
    REPO_ROOT / ".github/workflows/telegram-sync.yml",
    REPO_ROOT / ".github/workflows/telegram-api-backfill.yml",
    REPO_ROOT / ".github/workflows/telegram-join-groups.yml",
]

PART_LIMIT = 25 * 1024 * 1024  # Cloudflare Pages per-file limit


def _steps(workflow_path):
    data = yaml.safe_load(workflow_path.read_text())
    job = next(iter(data["jobs"].values()))
    return job["steps"]


def _step_text(step):
    return step.get("run", "")


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda p: p.name)
def test_workflow_is_valid_yaml(workflow):
    data = yaml.safe_load(workflow.read_text())
    assert "jobs" in data
    assert data["permissions"]["contents"] == "write"


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda p: p.name)
def test_decompress_reassembles_parts_first(workflow):
    steps = _steps(workflow)
    decompress = next(s for s in steps if s.get("name") == "Decompress the seed DB")
    run = _step_text(decompress)
    assert "index.db.gz.part-*" in run
    assert "cat index.db.gz.part-* > index.db.gz" in run
    # The single-file path stays as a fallback for the transition.
    assert "gunzip -f index.db.gz" in run


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda p: p.name)
def test_publish_splits_and_adds_parts(workflow):
    steps = _steps(workflow)
    publish = next(s for s in steps if s.get("name") == "Publish atomically")
    run = _step_text(publish)
    assert "split -b 20M" in run
    assert "index.db.gz.part-" in run
    assert "git add telegram/index.db.gz.part-*" in run
    # The single file must not be added, and must be removed from tracking.
    assert "git add telegram/index.db.gz " not in run
    assert "git add telegram/index.db.gz\n" not in run
    assert "git rm --cached telegram/index.db.gz" in run


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda p: p.name)
def test_failure_save_splits_and_adds_parts(workflow):
    steps = _steps(workflow)
    save = next(s for s in steps if "Save progress" in s.get("name", ""))
    run = _step_text(save)
    assert "split -b 20M" in run
    assert "git add index.db.gz.part-*" in run
    assert "git rm --cached index.db.gz" in run


def test_split_parts_are_under_the_pages_limit():
    parts = sorted((REPO_ROOT / "telegram").glob("index.db.gz.part-*"))
    assert parts, "no split parts found in telegram/ (run the build first)"
    for part in parts:
        assert part.stat().st_size <= PART_LIMIT, (
            "%s is %d bytes, over the 25 MB Pages limit" % (part.name, part.stat().st_size)
        )


def test_no_single_seed_file_is_committed():
    # The reassembled single file must not be in the repo (it is built
    # by the workflows from the parts). The .gitignore must exclude it.
    gitignore = (REPO_ROOT / ".gitignore").read_text()
    assert "telegram/index.db.gz" in gitignore
    assert "!telegram/index.db.gz" not in gitignore
