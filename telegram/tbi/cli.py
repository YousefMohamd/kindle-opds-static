"""Command-line interface: ``tbi index`` / ``tbi search`` / ``tbi sources``
/ ``tbi search-channel`` / ``tbi api-backfill`` / ``tbi join-groups`` /
``tbi submit-book``.

On-demand only: every command opens the SQLite file, does its work, and
exits. No server, no background process.

``tbi index --backfill`` walks each not-yet-complete channel newest ->
oldest in blocks (default 3000 posts per run per channel), so the deep
history beyond the local run's cap fills in over successive scheduled
runs; ``tbi search-channel`` is the targeted server-side search used
for priority requests (a book asked for before it is indexed).

``tbi api-backfill`` is the OPTIONAL, MANUAL-ONLY Telegram API path
(MTProto / Telethon): it reads a channel/group's full history,
including the old posts the web preview never serves. Credentials come
only from the environment (GitHub Actions secrets — never in the repo),
it reads only configured channels/groups (never personal chats), and
it is NOT part of the daily scheduled job. ``tbi submit-book`` indexes
one book individually, recording its source link.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import __version__, join_groups
from .api_history import (
    ApiCredentialsError,
    create_client,
    find_config_entry,
    iter_api_posts,
    load_api_credentials,
)
from .entity_cache import DEFAULT_ENTITY_CACHE, EntityCache, ResolveFloodWait
from .books import BOOK_EXTS, dedupe_key, parse_title_author
from .config import load_config
from .export_static import export_static
from .exports import is_book_file, parse_export
from .report import ChannelRun, GroupRun, RunRecord, build_report, write_report
from .scrape import classify, normalize_link, search_channel, walk
from .store import Store
from .submit import submit_book


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _book_file_dict(
    filename: str,
    ext: str,
    size_text,
    size_bytes,
    caption: str,
    obtain_url: str,
) -> dict:
    title, author = parse_title_author(filename, caption)
    return {
        "filename": filename,
        "ext": ext,
        "size_text": size_text,
        "size_bytes": size_bytes,
        "title": title,
        "author": author,
        "dedupe_key": dedupe_key(title, author, size_bytes),
        "obtain_url": obtain_url,
    }


def _consume_walk(store: Store, sid: int, username: str, posts, state: dict) -> None:
    """Consume one walk iterator into the store.

    ``state`` (``count``/``files``/``oldest``/``newest``) is shared across
    the new-posts and resume phases of one channel so progress
    accumulates. Commits, records progress, and prints a line every 20
    posts — so a Ctrl+C (or a crash) keeps everything indexed so far
    instead of rolling the whole channel back, and the silence between
    pages is visibly progress, not a hang.
    """
    for post in posts:
        db_pid = store.upsert_post(
            sid, post.post_id, post.date, post.text, post.url
        )
        book_files = [
            _book_file_dict(
                f.filename,
                f.ext,
                f.size_text,
                f.size_bytes,
                post.text,
                post.url,
            )
            for f in post.files
            if f.ext in BOOK_EXTS
        ]
        store.replace_files_for_post(db_pid, book_files)
        state["count"] += 1
        state["files"] += len(book_files)
        state["oldest"] = (
            post.post_id
            if state["oldest"] is None
            else min(state["oldest"], post.post_id)
        )
        state["newest"] = (
            post.post_id
            if state["newest"] is None
            else max(state["newest"], post.post_id)
        )
        if state["count"] % 20 == 0:
            store.commit()
            store.set_progress(sid, state["oldest"], state["newest"])
            print(
                f"[...] @{username}: {state['count']} posts so far, "
                f"oldest reached {state['oldest']}",
                flush=True,
            )
    store.commit()
    store.set_progress(sid, state["oldest"], state["newest"])


def cmd_index(args: argparse.Namespace) -> int:
    try:
        cfg = load_config(args.config)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    db_path = args.db or cfg.settings.db
    limit = cfg.settings.limit_per_channel or None
    block = args.backfill_block
    if args.backfill and (args.full or args.new_only):
        print(
            "Error: --backfill cannot be combined with --full or "
            "--new-only",
            file=sys.stderr,
        )
        return 2
    if args.full:
        mode = "full"
    elif args.new_only:
        mode = "new-only"
    elif args.backfill:
        mode = "backfill"
    elif limit is not None:
        mode = f"capped {limit}"
    else:
        mode = "incremental"
    run = RunRecord(
        started_at=_now_iso(),
        mode=mode,
        config=str(args.config),
        db=str(db_path),
        note=(
            f"Backfill: one block of {block} posts per channel below the "
            "oldest indexed post; a channel is complete when a block "
            f"reaches post 1 or returns fewer than {block} posts."
            if args.backfill
            else ""
        ),
    )
    started_mono = time.monotonic()
    store = Store(db_path)
    total_posts = total_files = 0
    try:
        # --- channels: live scrape of the public preview ----------------
        # Priority first (backfill runs only): channels with pending
        # priority requests — a book someone asked for — go before the
        # rest, in request order. The queue is consumed by the backfill
        # run; --new-only runs only check for new posts, so order
        # does not matter there.
        priority = store.pending_priority_channels()
        if priority and args.backfill:
            pset = set(priority)
            entries = sorted(
                cfg.channels,
                key=lambda e: 0 if e.username in pset else 1,
            )
            print(
                "[priority] channels with pending priority requests go "
                f"first: {', '.join('@' + n for n in priority)}",
                flush=True,
            )
        else:
            entries = cfg.channels
        for entry in entries:
            kind = classify(entry.username)
            sid = store.upsert_source("channel", entry.username, entry.label)
            if kind != "channel":
                store.set_source_status(
                    sid,
                    "no_preview",
                    note=(
                        "No public preview (t.me/s/ redirects). This is a "
                        "group, a private channel, a preview-disabled "
                        "channel, or a name that does not exist. "
                        "Live-scraping is impossible without Telegram API "
                        "credentials; index it from a Desktop export instead."
                    ),
                    last_indexed=_now_iso(),
                )
                print(f"[skip] @{entry.username}: no public preview")
                run.channels.append(
                    ChannelRun(
                        username=entry.username,
                        status="no_preview",
                        scope="—",
                        note="No public preview (t.me/s/ redirects).",
                    )
                )
                continue
            # Resume: if this channel already has posts in the DB, do
            # not re-walk them. Phase 1 picks up posts newer than the
            # stored newest; phase 2 continues below the stored oldest.
            # A limit disables resume (a capped walk is a sample, not a
            # full walk, so its stored oldest is not a resume point).
            # --full also disables resume (re-walk from the top).
            # --new-only does phase 1 only: scheduled runs only fetch
            # new posts, they never grind through a giant's history.
            prev = store.get_source(entry.username)
            prev_oldest = prev["oldest_post_id"] if prev else None
            prev_newest = prev["newest_post_id"] if prev else None
            prev_count = prev["post_count"] if prev else 0
            resumable = (
                not args.full
                and limit is None
                and prev_count
                and prev_oldest is not None
                and prev_newest is not None
            )
            new_only = bool(args.new_only and prev_count and prev_newest is not None)
            backfill = bool(args.backfill)
            if backfill:
                scope = "backfill"
                print(
                    f"[...] @{entry.username}: backfill — one block of "
                    f"{block} posts below the oldest indexed post",
                    flush=True,
                )
            elif new_only:
                scope = "incremental"
                print(
                    f"[...] @{entry.username}: checking for new posts "
                    f"above {prev_newest}",
                    flush=True,
                )
            elif resumable:
                scope = "resumed"
                print(
                    f"[...] @{entry.username}: resuming — {prev_count} posts "
                    f"already indexed (newest {prev_newest}, oldest "
                    f"{prev_oldest}); new posts first, then continuing "
                    f"below {prev_oldest}",
                    flush=True,
                )
            else:
                scope = f"capped {limit}" if limit else "full"
                print(
                    f"[...] @{entry.username}: indexing from the newest post",
                    flush=True,
                )
            # Seed the span from the previous run when resuming or
            # backfilling, so a run that finds nothing new does not
            # wipe the stored coverage back to NULL.
            state = {
                "count": 0,
                "files": 0,
                "oldest": prev_oldest if (resumable or backfill) else None,
                "newest": prev_newest if (resumable or backfill) else None,
            }
            backfill_posts = 0
            backfill_complete = False
            try:
                if backfill:
                    # Phase 1: new posts above the stored newest.
                    if prev_count and prev_newest is not None:
                        _consume_walk(
                            store,
                            sid,
                            entry.username,
                            walk(
                                entry.username,
                                min_id=prev_newest,
                                delay=cfg.settings.delay_seconds,
                            ),
                            state,
                        )
                    # Phase 2: one block below the stored oldest — or
                    # from the top when the channel has no posts yet.
                    # The block cap is what makes the deep history
                    # fill in gradually over successive runs instead
                    # of one giant 6-8h walk.
                    before = state["count"]
                    if prev_count and prev_oldest is not None:
                        _consume_walk(
                            store,
                            sid,
                            entry.username,
                            walk(
                                entry.username,
                                start_before=prev_oldest,
                                limit=block,
                                delay=cfg.settings.delay_seconds,
                            ),
                            state,
                        )
                    else:
                        _consume_walk(
                            store,
                            sid,
                            entry.username,
                            walk(
                                entry.username,
                                limit=block,
                                delay=cfg.settings.delay_seconds,
                            ),
                            state,
                        )
                    backfill_posts = state["count"] - before
                    backfill_complete = (
                        backfill_posts < block
                        or (
                            state["oldest"] is not None
                            and state["oldest"] <= 1
                        )
                    )
                elif new_only:
                    # Scheduled runs only fetch new posts (phase 1).
                    _consume_walk(
                        store,
                        sid,
                        entry.username,
                        walk(
                            entry.username,
                            min_id=prev_newest,
                            delay=cfg.settings.delay_seconds,
                        ),
                        state,
                    )
                elif resumable:
                    _consume_walk(
                        store,
                        sid,
                        entry.username,
                        walk(
                            entry.username,
                            min_id=prev_newest,
                            delay=cfg.settings.delay_seconds,
                        ),
                        state,
                    )
                    _consume_walk(
                        store,
                        sid,
                        entry.username,
                        walk(
                            entry.username,
                            start_before=prev_oldest,
                            delay=cfg.settings.delay_seconds,
                        ),
                        state,
                    )
                else:
                    _consume_walk(
                        store,
                        sid,
                        entry.username,
                        walk(
                            entry.username,
                            limit=limit,
                            delay=cfg.settings.delay_seconds,
                        ),
                        state,
                    )
                oldest, newest = state["oldest"], state["newest"]
                count, files = state["count"], state["files"]
                note = (
                    f"Walked to post {oldest} (oldest reached). "
                    "The preview has a coverage ceiling: reaching the "
                    "first post is not guaranteed on large/old channels."
                    if oldest and oldest > 1
                    else "Walked to the first post."
                )
                if backfill:
                    note = (
                        f"Backfill block: {backfill_posts} posts; oldest "
                        f"reached {oldest}. "
                        + (
                            "Complete — reached the first post or the "
                            "preview is exhausted."
                            if backfill_complete
                            else "More remain — the next run continues "
                            f"below post {oldest}."
                        )
                    )
                store.set_source_status(
                    sid, "ok", note=note, oldest=oldest, newest=newest,
                    last_indexed=_now_iso(),
                )
                print(f"[ok] @{entry.username}: {count} posts, {files} book files")
                run.channels.append(
                    ChannelRun(
                        username=entry.username,
                        status="ok",
                        posts_new=count,
                        files_new=files,
                        scope=scope,
                        note=note,
                        backfill_posts=backfill_posts,
                        backfill_complete=backfill_complete,
                    )
                )
                if backfill:
                    # A pending priority request is resolved when the
                    # book it asked for shows up in this channel now.
                    resolved = store.resolve_matching_priority(entry.username)
                    if resolved:
                        store.commit()
                        print(
                            f"[priority] @{entry.username}: priority "
                            f"request(s) resolved: {', '.join(resolved)}"
                        )
            except KeyboardInterrupt:
                # Keep what was indexed: _consume_walk commits every 20
                # posts, and this commit also saves the current partial
                # page. Record the progress so the next run resumes here.
                store.set_progress(sid, state["oldest"], state["newest"])
                run.status = "interrupted"
                run.channels.append(
                    ChannelRun(
                        username=entry.username,
                        status="interrupted",
                        posts_new=state["count"],
                        files_new=state["files"],
                        scope=scope,
                        note=(
                            "Interrupted — kept "
                            f"{state['count']} posts indexed so far."
                        ),
                    )
                )
                resume_hint = (
                    f" — re-run `tbi index` to resume below post "
                    f"{state['oldest']}"
                    if state["oldest"] is not None
                    else " — re-run `tbi index` to start this channel again"
                )
                print(
                    f"[interrupted] @{entry.username}: kept "
                    f"{state['count']} posts indexed so far{resume_hint}",
                    file=sys.stderr,
                )
                raise
            except Exception as exc:  # keep the other sources going
                store.set_source_status(
                    sid, "error", note=str(exc),
                    oldest=state["oldest"], newest=state["newest"],
                    last_indexed=_now_iso(),
                )
                print(f"[error] @{entry.username}: {exc}", file=sys.stderr)
                run.channels.append(
                    ChannelRun(
                        username=entry.username,
                        status="error",
                        posts_new=state["count"],
                        files_new=state["files"],
                        scope=scope,
                        error=str(exc),
                    )
                )
            total_posts += state["count"]
            total_files += state["files"]
        # --- groups: Telegram Desktop JSON exports ----------------------
        for entry in cfg.groups:
            export_path = Path(entry.export).expanduser()
            sid = store.upsert_source("group", entry.name, entry.label)
            if not entry.export:
                # API-only group (no Desktop export configured): the
                # API backfill indexes it; the preview sync has
                # nothing to do here and must NOT mark it as an
                # error (that would clobber the API's "ok" status and
                # spam the report with a failure every day).
                print(f"[skip] group {entry.name}: no Desktop export (API-only)")
                continue
            if not export_path.is_file():
                store.set_source_status(
                    sid,
                    "error",
                    note=f"Export file not found: {export_path}",
                    last_indexed=_now_iso(),
                )
                print(f"[skip] group {entry.name}: export not found: {export_path}")
                run.groups.append(
                    GroupRun(
                        name=entry.name,
                        status="error",
                        error=f"Export file not found: {export_path}",
                    )
                )
                continue
            try:
                chat_name, posts = parse_export(export_path)
            except ValueError as exc:
                store.set_source_status(
                    sid, "error", note=str(exc), last_indexed=_now_iso()
                )
                print(f"[error] group {entry.name}: {exc}", file=sys.stderr)
                run.groups.append(
                    GroupRun(name=entry.name, status="error", error=str(exc))
                )
                continue
            count = files = 0
            oldest = newest = None
            for post in posts:
                db_pid = store.upsert_post(
                    sid, post.post_id, post.date, post.text, post.url
                )
                book_files = [
                    _book_file_dict(
                        f.filename,
                        f.ext,
                        None,
                        f.size_bytes,
                        post.text,
                        post.url,
                    )
                    for f in post.files
                    if is_book_file(f)
                ]
                store.replace_files_for_post(db_pid, book_files)
                count += 1
                files += len(book_files)
                oldest = post.post_id if oldest is None else min(oldest, post.post_id)
                newest = post.post_id if newest is None else max(newest, post.post_id)
            store.commit()
            store.set_source_status(
                sid,
                "ok",
                note=f"Indexed from Desktop export {export_path.name}",
                oldest=oldest,
                newest=newest,
                last_indexed=_now_iso(),
            )
            print(f"[ok] group {entry.name}: {count} posts, {files} book files")
            run.groups.append(
                GroupRun(
                    name=entry.name,
                    status="ok",
                    posts_new=count,
                    files_new=files,
                    note=f"Indexed from Desktop export {export_path.name}",
                )
            )
            total_posts += count
            total_files += files
    finally:
        run.finished_at = _now_iso()
        run.duration_s = time.monotonic() - started_mono
        if run.status != "interrupted":
            processed = run.channels + run.groups
            # Only real errors count as failure: a group with no
            # preview is the normal "not indexable live" state, not
            # a failure (a config with only groups is not a failed
            # run). A fully-failed run exits non-zero so the cloud
            # workflow stops instead of publishing nothing new.
            errored = [r for r in processed if r.status == "error"]
            if processed and len(errored) == len(processed):
                run.status = "failed"
            elif errored:
                run.status = "partial"
            else:
                run.status = "ok"
        counts = store.counts()
        # The report is written even when the run was interrupted or
        # partly failed, so the failure is a durable record — and the
        # cloud workflow publishes it instead of the new index.
        try:
            report_text = build_report(store, run, cfg)
            report_path = (
                Path(args.report)
                if args.report
                else Path(db_path).parent / "index-report.md"
            )
            write_report(report_path, report_text)
            print(f"Report: {report_path}")
        except Exception as exc:  # never fail the run over the report
            print(f"Warning: could not write index report: {exc}", file=sys.stderr)
        store.close()
    print(
        f"\nDone. Index now holds {counts['posts']} posts, "
        f"{counts['files']} files ({counts['books']} distinct books) "
        f"from {counts['sources']} sources. DB: {db_path}"
    )
    return 1 if run.status == "failed" else 0


def cmd_search(args: argparse.Namespace) -> int:
    store = Store(args.db)
    try:
        hits = store.search(
            " ".join(args.query),
            ext=args.format,
            source=args.source,
            limit=args.limit,
        )
    finally:
        store.close()
    if not hits:
        print("No matches. Try fewer words, or run `tbi index` first.")
        return 0
    for i, h in enumerate(hits, 1):
        title = h.title or h.filename
        author = f" — {h.author}" if h.author else ""
        size = f" [{h.size_text}]" if h.size_text else ""
        date = f" ({h.date[:10]})" if h.date else ""
        print(f"{i}. {title}{author}{size}{date}")
        print(f"   file: {h.filename}  |  {h.source_kind}: {h.source_name}")
        print(f"   get it: {h.obtain_url or '(open the source in Telegram)'}")
    print(f"\n{len(hits)} result(s). Files are obtained in Telegram — "
          "the index holds metadata only, no downloads.")
    return 0


def cmd_search_channel(args: argparse.Namespace) -> int:
    """Targeted server-side search in one channel (``?q=``).

    The priority-search helper: a user asks for a book that is not
    indexed yet -> this runs the channel's own search and returns the
    post link immediately when found (indexing that post), otherwise
    the (channel, query) pair is queued as a priority backfill request
    for the next scheduled run. Metadata only — nothing is downloaded.
    """
    name = normalize_link(args.channel)
    if not name:
        print(
            f"Error: not a Telegram channel link or name: {args.channel}",
            file=sys.stderr,
        )
        return 2
    kind = classify(name)
    if kind != "channel":
        print(
            f"Error: @{name} has no public preview "
            f"(classify: {kind}) — server-side search is impossible. "
            "It may be a group, a private channel, or a name that "
            "does not exist.",
            file=sys.stderr,
        )
        return 1
    query = " ".join(args.query).strip()
    if not query:
        print("Error: --query needs at least one word.", file=sys.stderr)
        return 2
    try:
        posts = search_channel(name, query, limit=args.limit)
    except Exception as exc:
        print(f"Error: search failed for @{name}: {exc}", file=sys.stderr)
        return 1
    store = Store(args.db)
    try:
        if not posts:
            queued = store.add_priority_request(name, query)
            store.commit()
            print(
                f"No match for '{query}' in @{name} (server-side search)."
            )
            if queued:
                print(
                    "Queued as a priority backfill request — the next "
                    f"scheduled run backfills @{name} first, and the "
                    "request resolves when the book shows up there."
                )
            else:
                print("A priority request for this book is already queued.")
            return 0
        sid = store.upsert_source("channel", name)
        count = files = 0
        for i, post in enumerate(posts, 1):
            db_pid = store.upsert_post(
                sid, post.post_id, post.date, post.text, post.url
            )
            book_files = [
                _book_file_dict(
                    f.filename,
                    f.ext,
                    f.size_text,
                    f.size_bytes,
                    post.text,
                    post.url,
                )
                for f in post.files
                if f.ext in BOOK_EXTS
            ]
            store.replace_files_for_post(db_pid, book_files)
            count += 1
            files += len(book_files)
            if book_files:
                for bf in book_files:
                    title = bf["title"] or bf["filename"]
                    size = f" [{bf['size_text']}]" if bf["size_text"] else ""
                    print(f"{i}. {title}{size}")
                    print(f"   file: {bf['filename']}  |  get it: {post.url}")
            else:
                print(f"{i}. (text match, no book file) {post.url}")
        store.commit()
        resolved = store.resolve_matching_priority(name)
        if resolved:
            store.commit()
            print(f"Priority request(s) resolved: {', '.join(resolved)}")
        print(
            f"\n{count} result(s), {files} book file(s) — indexed into "
            f"{args.db}."
        )
        return 0
    finally:
        store.close()


def cmd_api_backfill(args: argparse.Namespace) -> int:
    """API backfill (manual-only): full history via MTProto / Telethon.

    Reads each target's full message history — including the old posts
    the web preview never serves (and the groups the preview cannot
    see at all) — and indexes the book files with the same store code
    as ``tbi index`` (same title/author parsing, same dedup keys).

    Credentials come only from the environment (``TELEGRAM_API_ID``,
    ``TELEGRAM_API_HASH``, ``TELEGRAM_SESSION_STRING`` — GitHub
    Actions secrets; never in the repo). The targets are only the
    configured channels/groups in ``channels.yaml`` — a ``--channel``
    that is not in the config is refused, and a resolved entity that
    turns out to be a person is refused too. This command is never
    run by the daily scheduled job; it runs only when the owner starts
    it (``tbi api-backfill`` / the ``telegram-api-backfill`` workflow's
    manual dispatch).
    """
    try:
        cfg = load_config(args.config)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    if args.backfill and (args.full or args.new_only):
        print(
            "Error: --backfill cannot be combined with --full or "
            "--new-only",
            file=sys.stderr,
        )
        return 2
    if args.channel:
        found = find_config_entry(cfg, args.channel)
        if found is None:
            print(
                f"Error: @{normalize_link(args.channel)} is not in "
                f"{args.config} — add it there first. The API job "
                "only reads configured channels/groups, never "
                "personal chats.",
                file=sys.stderr,
            )
            return 2
        kind, entry = found
        targets = [
            (
                kind,
                entry.username if kind == "channel" else entry.name,
                entry.label,
            )
        ]
    else:
        targets = [("channel", e.username, e.label) for e in cfg.channels]
        targets += [("group", e.name, e.label) for e in cfg.groups]
    if not targets:
        print(
            f"Error: no sources configured in {args.config} — add a "
            "channel or group first.",
            file=sys.stderr,
        )
        return 2
    try:
        api_id, api_hash, session = load_api_credentials()
    except ApiCredentialsError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    try:
        client = create_client(api_id, api_hash, session)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    db_path = args.db or cfg.settings.db
    limit = cfg.settings.limit_per_channel or None
    block = args.backfill_block
    if args.full:
        mode = "api-full"
    elif args.new_only:
        mode = "api-new-only"
    elif args.backfill:
        mode = "api-backfill"
    elif limit is not None:
        mode = f"api-capped {limit}"
    else:
        mode = "api-incremental"
    run = RunRecord(
        started_at=_now_iso(),
        mode=mode,
        config=str(args.config),
        db=str(db_path),
        note=(
            "API backfill (manual-only): full history via the MTProto "
            "API (Telethon). Credentials from the environment (GitHub "
            "Actions secrets); never part of the daily preview job; "
            "reads only configured channels/groups, never personal "
            "chats. Metadata only — no book files are downloaded."
        ),
    )
    started_mono = time.monotonic()
    store = Store(db_path)
    totals = {"posts": 0, "files": 0}
    # The persistent entity cache (v0.4.8): a cached handle is used
    # WITHOUT any ResolveUsernameRequest. Without it, every run
    # resolved all 211 handles and tripped a ~20-hour flood wait
    # (2026-11-07). A missing/corrupt file loads as empty — the run
    # re-resolves and rebuilds it, it never blocks the backfill.
    cache = EntityCache.load(args.entity_cache)
    # Set by _target when a resolve flood-wait stops the run: no
    # further source is attempted (the wait is account-wide).
    stop_after_target = {"resolve_flood_wait": None}

    async def _consume_api(store_: Store, sid: int, name: str, state: dict,
                           **kwargs) -> None:
        """Drain one API iterator into the store in batches of 50.

        Batches keep memory bounded on a giant's full history; the
        shared ``state`` accumulates across batches (and across the
        new-posts / backfill phases) exactly like ``_consume_walk``.
        """
        batch = []
        async for post in iter_api_posts(client, name, cache=cache, **kwargs):
            batch.append(post)
            if len(batch) >= 50:
                _consume_walk(store_, sid, name, iter(batch), state)
                batch.clear()
        if batch:
            _consume_walk(store_, sid, name, iter(batch), state)

    async def _target(kind: str, name: str, label: str) -> bool:
        """Index one source. Returns True when the run must stop
        immediately (a resolve flood-wait) — False otherwise."""
        sid = store.upsert_source(kind, name, label)
        prev = store.get_source(name)
        prev_oldest = prev["oldest_post_id"] if prev else None
        prev_newest = prev["newest_post_id"] if prev else None
        prev_count = prev["post_count"] if prev else 0
        resumable = (
            not args.full
            and limit is None
            and prev_count
            and prev_oldest is not None
            and prev_newest is not None
        )
        new_only = bool(args.new_only and prev_count and prev_newest is not None)
        backfill = bool(args.backfill)
        if backfill:
            scope = "api-backfill"
        elif new_only:
            scope = "api-new-only"
        elif resumable:
            scope = "api-resumed"
        elif args.full:
            scope = "api-full"
        else:
            scope = f"api-capped {limit}" if limit else "api-full"
        state = {
            "count": 0,
            "files": 0,
            "oldest": prev_oldest if (resumable or backfill) else None,
            "newest": prev_newest if (resumable or backfill) else None,
        }
        backfill_posts = 0
        backfill_complete = False
        print(f"[...] @{name}: API backfill ({scope})", flush=True)
        try:
            if backfill:
                if prev_count and prev_newest is not None:
                    await _consume_api(
                        store, sid, name, state, min_id=prev_newest
                    )
                before = state["count"]
                if prev_count and prev_oldest is not None:
                    await _consume_api(
                        store, sid, name, state,
                        start_before=prev_oldest, limit=block,
                    )
                else:
                    await _consume_api(store, sid, name, state, limit=block)
                backfill_posts = state["count"] - before
                backfill_complete = (
                    backfill_posts < block
                    or (state["oldest"] is not None and state["oldest"] <= 1)
                )
            elif new_only:
                await _consume_api(store, sid, name, state, min_id=prev_newest)
            elif resumable:
                await _consume_api(store, sid, name, state, min_id=prev_newest)
                await _consume_api(
                    store, sid, name, state, start_before=prev_oldest
                )
            else:
                await _consume_api(store, sid, name, state, limit=limit)
            oldest, newest = state["oldest"], state["newest"]
            count, files = state["count"], state["files"]
            if backfill:
                note = (
                    f"API backfill block: {backfill_posts} posts; oldest "
                    f"reached {oldest}. "
                    + (
                        "Complete — reached the first post or the API "
                        "history is exhausted."
                        if backfill_complete
                        else "More remain — the next run continues "
                        f"below post {oldest}."
                    )
                )
            else:
                note = (
                    f"API history walked to post {oldest} (oldest "
                    "reached)."
                    if oldest and oldest > 1
                    else "API history walked to the first post."
                )
            store.set_source_status(
                sid, "ok", note=note, oldest=oldest, newest=newest,
                last_indexed=_now_iso(),
            )
            print(f"[ok] @{name}: {count} posts, {files} book files (API)")
            record = (
                ChannelRun(
                    username=name, status="ok", posts_new=count,
                    files_new=files, scope=scope, note=note,
                    backfill_posts=backfill_posts,
                    backfill_complete=backfill_complete,
                )
                if kind == "channel"
                else GroupRun(
                    name=name, status="ok", posts_new=count,
                    files_new=files, note=note,
                )
            )
            if kind == "channel":
                run.channels.append(record)
            else:
                run.groups.append(record)
            if backfill:
                resolved = store.resolve_matching_priority(name)
                if resolved:
                    store.commit()
                    print(
                        f"[priority] @{name}: priority request(s) "
                        f"resolved: {', '.join(resolved)}"
                    )
        except KeyboardInterrupt:
            store.set_progress(sid, state["oldest"], state["newest"])
            run.status = "interrupted"
            note = (
                "Interrupted — kept "
                f"{state['count']} posts indexed so far."
            )
            if kind == "channel":
                run.channels.append(
                    ChannelRun(
                        username=name, status="interrupted",
                        posts_new=state["count"], files_new=state["files"],
                        scope=scope, note=note,
                    )
                )
            else:
                run.groups.append(
                    GroupRun(
                        name=name, status="interrupted",
                        posts_new=state["count"], files_new=state["files"],
                        note=note,
                    )
                )
            print(
                f"[interrupted] @{name}: kept {state['count']} posts "
                "indexed so far — re-run `tbi api-backfill` to resume.",
                file=sys.stderr,
            )
            raise
        except ResolveFloodWait as exc:
            # A resolve flood-wait is account-wide and long: STOP the
            # whole run now (the next source would hit the same wait
            # and could extend it). Recorded per-source AND in the run
            # note, so the report says plainly what happened and when
            # to retry.
            until = datetime.now(timezone.utc) + timedelta(
                seconds=exc.seconds
            )
            message = (
                f"STOPPED by a Telegram flood-wait on username "
                f"resolution: @{exc.handle} needs a {exc.seconds:g} "
                f"second wait (until {until.isoformat()}). No further "
                "sources were attempted — re-run after the wait "
                "expires. The entity cache means the next run "
                "resolves each handle only once."
            )
            store.set_source_status(
                sid, "error", note=str(exc),
                oldest=state["oldest"], newest=state["newest"],
                last_indexed=_now_iso(),
            )
            print(f"[error] @{name}: {exc}", file=sys.stderr)
            print(f"[flood-wait] {message}", file=sys.stderr)
            if kind == "channel":
                run.channels.append(
                    ChannelRun(
                        username=name, status="error",
                        posts_new=state["count"], files_new=state["files"],
                        scope=scope, error=str(exc),
                    )
                )
            else:
                run.groups.append(
                    GroupRun(
                        name=name, status="error",
                        posts_new=state["count"], files_new=state["files"],
                        error=str(exc),
                    )
                )
            run.note = message
            stop_after_target["resolve_flood_wait"] = (
                exc.handle, exc.seconds
            )
        except Exception as exc:  # keep the other sources going
            store.set_source_status(
                sid, "error", note=str(exc),
                oldest=state["oldest"], newest=state["newest"],
                last_indexed=_now_iso(),
            )
            print(f"[error] @{name}: {exc}", file=sys.stderr)
            if kind == "channel":
                run.channels.append(
                    ChannelRun(
                        username=name, status="error",
                        posts_new=state["count"], files_new=state["files"],
                        scope=scope, error=str(exc),
                    )
                )
            else:
                run.groups.append(
                    GroupRun(
                        name=name, status="error",
                        posts_new=state["count"], files_new=state["files"],
                        error=str(exc),
                    )
                )
        totals["posts"] += state["count"]
        totals["files"] += state["files"]
        return stop_after_target["resolve_flood_wait"] is not None

    async def _run_all() -> None:
        await client.start()
        try:
            for kind, name, label in targets:
                if await _target(kind, name, label):
                    break
        finally:
            await client.disconnect()

    try:
        asyncio.run(_run_all())
    except KeyboardInterrupt:
        run.status = "interrupted"
        print("[interrupted] API backfill stopped.", file=sys.stderr)
    finally:
        run.finished_at = _now_iso()
        run.duration_s = time.monotonic() - started_mono
        if run.status != "interrupted":
            processed = run.channels + run.groups
            errored = [r for r in processed if r.status == "error"]
            if processed and len(errored) == len(processed):
                run.status = "failed"
            elif errored:
                run.status = "partial"
            else:
                run.status = "ok"
        counts = store.counts()
        try:
            report_text = build_report(store, run, cfg)
            report_path = (
                Path(args.report)
                if args.report
                else Path(db_path).parent / "index-report.md"
            )
            write_report(report_path, report_text)
            print(f"Report: {report_path}")
        except Exception as exc:  # never fail the run over the report
            print(f"Warning: could not write index report: {exc}", file=sys.stderr)
        store.close()
    print(
        f"\nDone. Index now holds {counts['posts']} posts, "
        f"{counts['files']} files ({counts['books']} distinct books) "
        f"from {counts['sources']} sources. DB: {db_path}"
    )
    return 1 if run.status == "failed" else 0


def cmd_join_groups(args: argparse.Namespace) -> int:
    """Slow, safe group joining (v0.4.6): join a few configured groups
    per run, add them to the owner's chat folder, and record the
    outcome in join-state.json. Scheduled (telegram-join-groups.yml),
    never part of the daily preview job. Credentials only from the
    environment (GitHub Actions secrets); reads only configured
    groups (channels.yaml) — never personal chats. Joining only: the
    indexing of a newly joined group is a separate step (the workflow
    runs ``tbi api-backfill --channel <name>`` for each name this
    command writes to newly-joined.txt).

    Exit 0 when the run completed — even when nothing was joined, or
    when a flood wait stopped it (both are expected states the
    workflow handles, not failures). Exit 2 for config/credential
    problems, 1 when interrupted.
    """
    try:
        cfg = load_config(args.config)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    state_path = Path(args.state)
    try:
        state = join_groups.load_state(state_path, cfg)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    # The persistent entity cache (v0.4.8): a cached group is used
    # WITHOUT any ResolveUsernameRequest. A missing/corrupt file
    # loads as empty — the run re-resolves and rebuilds it.
    cache = EntityCache.load(args.entity_cache)
    batch = (
        args.batch
        if args.batch is not None
        else int(state.get("batch_size", join_groups.DEFAULT_BATCH_SIZE))
    )
    folder = args.folder or state.get(
        "folder_title", join_groups.DEFAULT_FOLDER_TITLE
    )
    delay = state.get("delay_seconds") or [
        join_groups.DEFAULT_DELAY_MIN_S,
        join_groups.DEFAULT_DELAY_MAX_S,
    ]
    delay_min = (
        args.delay_min
        if args.delay_min is not None
        else float(delay[0])
    )
    delay_max = (
        args.delay_max
        if args.delay_max is not None
        else float(delay[1])
    )
    if delay_min < 0 or delay_max < delay_min:
        print(
            "Error: --delay-min/--delay-max must satisfy "
            "0 <= min <= max.",
            file=sys.stderr,
        )
        return 2
    try:
        api_id, api_hash, session = load_api_credentials()
    except ApiCredentialsError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    try:
        client = create_client(api_id, api_hash, session)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    def _save(_state=None) -> None:
        join_groups.save_state(state_path, state)

    async def _run() -> join_groups.JoinResult:
        await client.start()
        try:
            return await join_groups.join_pending(
                client, cfg, state, batch=batch, delay_min=delay_min,
                delay_max=delay_max, folder_title=folder, on_update=_save,
                entity_cache=cache,
            )
        finally:
            await client.disconnect()

    try:
        result = asyncio.run(_run())
    except KeyboardInterrupt:
        print("[interrupted] join-groups stopped.", file=sys.stderr)
        _save()
        return 1
    # Files the workflow reads: the names to index (one per line; the
    # file exists even when nothing was joined, so the workflow can
    # tell "nothing new" from "the step never ran").
    Path(args.newly_joined).write_text(
        "".join(f"{name}\n" for name in result.joined), encoding="utf-8"
    )
    report_text = join_groups.build_join_report(result, state)
    report_path = Path(args.report)
    report_path.write_text(report_text, encoding="utf-8")
    _save()
    print(
        f"\nDone. Joined {len(result.joined)}, already a member of "
        f"{len(result.already_member)}, failed {len(result.failed)}"
        + (
            " — stopped by a flood wait; the next scheduled run retries"
            if result.stopped_by_flood_wait
            else ""
        )
        + f". Report: {report_path}  State: {state_path}"
    )
    return 0


def cmd_submit_book(args: argparse.Namespace) -> int:
    """Index one book individually, recording its source link."""
    store = Store(args.db)
    try:
        record = submit_book(
            store,
            args.source,
            args.title,
            author=args.author or "",
            format=args.format,
            size_bytes=args.size,
            size_text=args.size_text,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    finally:
        store.close()
    print(f"Indexed: {record['title']}")
    if record["author"]:
        print(f"  author: {record['author']}")
    print(
        f"  file: {record['filename']}  |  source: {record['kind']}: "
        f"{record['source']}"
    )
    print(f"  get it: {record['obtain_url']}")
    if record["already_indexed_from"]:
        print(
            f"  note: this book was already in the index from "
            f"{record['already_indexed_from']} other source(s) — it now "
            "has one more."
        )
    return 0


def cmd_sources(args: argparse.Namespace) -> int:
    store = Store(args.db)
    try:
        rows = store.list_sources()
        counts = store.counts()
    finally:
        store.close()
    if not rows:
        print("No sources indexed yet. Add links to channels.yaml, "
              "then run `tbi index`.")
        return 0
    for r in rows:
        span = ""
        if r["oldest_post_id"] is not None:
            span = f"posts {r['oldest_post_id']}..{r['newest_post_id']}"
        print(f"- [{r['kind']}] {r['name']} ({r['status']}) {span} "
              f"— {r['post_count']} posts")
        if r["note"]:
            print(f"    {r['note']}")
    print(f"\nTotals: {counts['posts']} posts, {counts['files']} files, "
          f"{counts['books']} distinct books.")
    return 0


def cmd_classify(args: argparse.Namespace) -> int:
    for link in args.links:
        print(f"{link} -> {classify(link)}")
    return 0


def cmd_export_static(args: argparse.Namespace) -> int:
    try:
        stats = export_static(args.db, args.out, args.report)
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    print(
        f"Static export: {stats['books']} books, {stats['files']} files, "
        f"{stats['posts']} posts from {stats['sources']} sources"
    )
    print(f"  {stats['json_path']} ({stats['json_bytes']} bytes)")
    if stats["report_copied"]:
        print(f"  report copied to {Path(args.out) / 'index-report.md'}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    """Check the DB (and the generated JSON) are publishable.

    Fails when the DB is missing/empty or the FTS search is broken.
    Sources in error state are reported but do not fail the check —
    a partial index is still publishable, the failures are in the
    run report.
    """
    problems: list[str] = []
    db_path = Path(args.db)
    if not db_path.is_file():
        print(f"Error: DB not found: {db_path}", file=sys.stderr)
        return 2
    store = Store(db_path)
    try:
        counts = store.counts()
        if counts["posts"] == 0:
            problems.append("DB has 0 posts")
        if counts["files"] == 0:
            problems.append("DB has 0 book files")
        try:
            hits = store.search("", limit=1)
            if counts["files"] > 0 and not hits:
                problems.append("FTS search returned nothing for an empty query")
        except Exception as exc:
            problems.append(f"FTS search failed: {exc}")
        errored = [
            s for s in store.per_source_totals() if s["status"] == "error"
        ]
    finally:
        store.close()
    if args.json:
        jpath = Path(args.json)
        if not jpath.is_file():
            problems.append(f"index.json not found: {jpath}")
        else:
            try:
                data = json.loads(jpath.read_text(encoding="utf-8"))
            except Exception as exc:
                problems.append(f"index.json is not valid JSON: {exc}")
            else:
                books = data.get("books")
                if not isinstance(books, list) or not books:
                    problems.append("index.json has no books")
                if "totals" not in data:
                    problems.append("index.json has no totals")
    if problems:
        for p in problems:
            print(f"FAIL: {p}", file=sys.stderr)
        return 1
    print(
        f"OK: {counts['posts']} posts, {counts['files']} files, "
        f"{counts['books']} distinct books from {counts['sources']} sources"
    )
    if errored:
        print(
            "Note: "
            f"{len(errored)} source(s) in error state: "
            + ", ".join(s["name"] for s in errored)
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tbi",
        description="Index books shared in public Telegram channels "
        "(live preview scrape) and groups (Desktop export), then search "
        "them. No API credentials, no server.",
    )
    p.add_argument("--version", action="version", version=f"tbi {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    pi = sub.add_parser("index", help="Index all sources from the config file")
    pi.add_argument("--config", default="channels.yaml")
    pi.add_argument("--db", default=None, help="SQLite file (default: from config)")
    pi.add_argument(
        "--full", action="store_true",
        help="Force a full walk, ignoring stored progress",
    )
    pi.add_argument(
        "--new-only", action="store_true",
        help="Only fetch posts newer than the stored newest (for "
        "scheduled runs; never backfills a giant's history)",
    )
    pi.add_argument(
        "--backfill", action="store_true",
        help="Walk each not-yet-complete channel in blocks: new posts "
        "first, then one block (see --backfill-block) below the oldest "
        "indexed post per run, so deep history fills in over "
        "successive scheduled runs",
    )
    pi.add_argument(
        "--backfill-block", type=int, default=3000, metavar="N",
        help="Posts per backfill block per channel (default: 3000)",
    )
    pi.add_argument(
        "--report", default=None,
        help="Where to write index-report.md (default: next to the DB)",
    )
    pi.set_defaults(func=cmd_index)

    pe = sub.add_parser(
        "export-static",
        help="Generate the static site data (index.json) from the DB",
    )
    pe.add_argument("--db", default="index.db")
    pe.add_argument("--out", default="site",
                    help="Output directory (default: site)")
    pe.add_argument(
        "--report", default=None,
        help="Run report to copy (default: index-report.md next to the DB)",
    )
    pe.set_defaults(func=cmd_export_static)

    pval = sub.add_parser(
        "validate", help="Check the DB and generated JSON are publishable"
    )
    pval.add_argument("--db", default="index.db")
    pval.add_argument("--json", default=None,
                      help="Generated index.json to check")
    pval.set_defaults(func=cmd_validate)

    ps = sub.add_parser("search", help="Search the index by title/author")
    ps.add_argument("query", nargs="*", help="Words to search for")
    ps.add_argument("--db", default="index.db")
    ps.add_argument("--format", default=None,
                    help="Filter: epub, mobi, azw3, kfx, pdf, txt")
    ps.add_argument("--source", default=None, help="Filter by source name")
    ps.add_argument("--limit", type=int, default=50)
    ps.set_defaults(func=cmd_search)

    psc = sub.add_parser(
        "search-channel",
        help="Targeted server-side search in one channel; indexes hits, "
        "or queues a priority backfill request when nothing is found",
    )
    psc.add_argument("--channel", required=True,
                     help="Channel link, @handle or name")
    psc.add_argument("--query", nargs="+", required=True,
                     help="Book title / words to search for")
    psc.add_argument("--db", default="index.db")
    psc.add_argument("--limit", type=int, default=20,
                     help="Max results (default: 20, about one screen)")
    psc.set_defaults(func=cmd_search_channel)

    pa = sub.add_parser(
        "api-backfill",
        help="Manual-only API backfill: full history via MTProto/Telethon "
        "(credentials from the environment — GitHub Actions secrets). "
        "Never part of the daily scheduled job.",
    )
    pa.add_argument("--config", default="channels.yaml")
    pa.add_argument("--db", default=None, help="SQLite file (default: from config)")
    pa.add_argument(
        "--channel", default=None,
        help="One configured channel/group only (default: all configured)",
    )
    pa.add_argument(
        "--full", action="store_true",
        help="Force a full history walk, ignoring stored progress",
    )
    pa.add_argument(
        "--new-only", action="store_true",
        help="Only fetch posts newer than the stored newest",
    )
    pa.add_argument(
        "--backfill", action="store_true",
        help="New posts first, then one block (see --backfill-block) "
        "below the oldest indexed post per channel",
    )
    pa.add_argument(
        "--backfill-block", type=int, default=3000, metavar="N",
        help="Posts per backfill block per channel (default: 3000)",
    )
    pa.add_argument(
        "--report", default=None,
        help="Where to write index-report.md (default: next to the DB)",
    )
    pa.add_argument(
        "--entity-cache", default=DEFAULT_ENTITY_CACHE,
        help="Persistent entity cache (default: entity-cache.json) — "
        "a cached handle is used without any ResolveUsernameRequest; "
        "a missing/corrupt file loads as empty and is rebuilt.",
    )
    pa.set_defaults(func=cmd_api_backfill)

    pj = sub.add_parser(
        "join-groups",
        help="Scheduled-only slow group joining: join a few configured "
        "groups per run and add them to the owner's chat folder "
        "(credentials from the environment — GitHub Actions secrets). "
        "Never part of the daily preview job.",
    )
    pj.add_argument("--config", default="channels.yaml")
    pj.add_argument(
        "--state", default="join-state.json",
        help="Join-state file (default: join-state.json)",
    )
    pj.add_argument(
        "--batch", type=int, default=None,
        help="Groups to attempt per run (default: from the state file, 3)",
    )
    pj.add_argument(
        "--delay-min", type=float, default=None,
        help="Minimum pause between joins in seconds (default: from the "
        "state file, 60)",
    )
    pj.add_argument(
        "--delay-max", type=float, default=None,
        help="Maximum pause between joins in seconds (default: from the "
        "state file, 120)",
    )
    pj.add_argument(
        "--folder", default=None,
        help="Chat-folder title to add joined groups to (default: from "
        "the state file, 📚كتب)",
    )
    pj.add_argument(
        "--newly-joined", default="newly-joined.txt",
        help="File for the newly joined group names, one per line "
        "(default: newly-joined.txt)",
    )
    pj.add_argument(
        "--report", default="join-report.md",
        help="Where to write join-report.md (default: join-report.md)",
    )
    pj.add_argument(
        "--entity-cache", default=DEFAULT_ENTITY_CACHE,
        help="Persistent entity cache (default: entity-cache.json) — "
        "a cached group is used without any ResolveUsernameRequest; "
        "a missing/corrupt file loads as empty and is rebuilt.",
    )
    pj.set_defaults(func=cmd_join_groups)

    pb = sub.add_parser(
        "submit-book",
        help="Index one book individually, recording its source link "
        "(a t.me post link or an external URL). Metadata only.",
    )
    pb.add_argument("--source", required=True,
                    help="Book's source: a t.me channel/group post link "
                    "or an external http(s) URL")
    pb.add_argument("--title", required=True, help="Book title")
    pb.add_argument("--author", default="", help="Author (optional)")
    pb.add_argument("--format", default="epub",
                    help="Format: epub, mobi, azw3, kfx, pdf, txt "
                    "(default: epub)")
    pb.add_argument("--size", type=int, default=None,
                    help="File size in bytes (optional)")
    pb.add_argument("--size-text", default=None,
                    help="Display size, e.g. '1.2 MB' (optional)")
    pb.add_argument("--db", default="index.db")
    pb.set_defaults(func=cmd_submit_book)

    pv = sub.add_parser("sources", help="List indexed sources and coverage")
    pv.add_argument("--db", default="index.db")
    pv.set_defaults(func=cmd_sources)

    pc = sub.add_parser("classify", help="Check whether links are live-scrapable channels")
    pc.add_argument("links", nargs="+")
    pc.set_defaults(func=cmd_classify)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
