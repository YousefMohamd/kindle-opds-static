"""Cover pairing for Telegram books (RliBook Blocks 4 + 9, indexer v0.7.0).

Rule (user-confirmed 2026-11-14): **no evidence = no cover — a wrong
cover is worse than no cover.** A cover is paired with a book only on
HIGH-confidence evidence from the messages around the book post:

  * an image in the SAME post as the book file ......... 0.99 confidence
  * a neighbouring post (post_id +/- 1) whose image caption
    matches the book title ............................ 0.90 confidence
  * a neighbouring image WITHOUT a matching caption ... 0.75 confidence
    -> NOT paired (below the threshold; recorded as the reason)

Only the first two pair a cover. The threshold is 0.90.

What a "cover" is here: the pairing records the image's STABLE
reference — the Telegram post URL of the message carrying the image
(``https://t.me/<channel>/<post_id>``) — alongside the book metadata
(see :meth:`CoverPair.to_record`). The cover is EMBEDDED with the book
metadata, never a separate hotlink on the site: the image bytes are
downloaded once (from the recorded reference) and stored with the book
(the download + store step is a follow-up — this module pairs, it does
not download). A transient preview CDN URL (``image_url``), when one is
known, is kept ONLY as the download source for that follow-up step and
must never be rendered on the site.

Evidence model: the pairing works on :class:`PostEvidence` records —
one per Telegram message — each saying whether the message carries an
image, what its text/caption is, and which book files it holds. The
indexer does NOT store photo evidence today (``tbi.scrape`` parses only
document wraps, ``tbi.exports`` drops ``media_type == "photo"``,
``store.posts`` has no image column, and the D1 ``books`` table has no
cover column), so :func:`build_evidence_from_store` honestly reports
``has_image=False`` for every stored post: a run over the stored
catalog pairs NOTHING until the capture step lands (see the module
docstring footer + ``blocks-open-questions.md``). The pairing logic
itself is exercised by the tests and by a live-preview sample run
(see the sample script note in :func:`pair_covers`).

This module never touches ``books.py`` — it only imports
:func:`tbi.books.normalize_arabic` for matching.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

from .books import normalize_arabic

# Confidence per evidence kind (see module docstring).
SAME_POST_CONFIDENCE = 0.99
CAPTION_MATCH_CONFIDENCE = 0.90
NEIGHBOUR_NO_CAPTION_CONFIDENCE = 0.75

# Only evidence at or above this pairs a cover.
HIGH_CONFIDENCE_THRESHOLD = 0.90

# Reasons a book gets no cover (returned by pair_covers, for reporting).
REASON_NO_IMAGE = "no_image_evidence"
REASON_NEIGHBOUR_NO_CAPTION = "neighbour_no_caption"
REASON_NO_NEIGHBOUR = "no_neighbour_post"


@dataclass
class BookFile:
    """One book file in a post (a row of the catalog, roughly)."""

    title: str
    post_id: int
    source: str  # channel/group name, e.g. "books2023"
    author: str = ""
    filename: str = ""
    url: str = ""  # t.me permalink of the book post, when known


@dataclass
class PostEvidence:
    """One Telegram message, as far as cover pairing is concerned."""

    source: str
    post_id: int
    text: str = ""  # post text / image caption
    has_image: bool = False
    image_ref: str = ""  # stable ref: t.me URL of the image post
    image_url: str = ""  # transient preview CDN URL (download source only)
    files: List[BookFile] = field(default_factory=list)


@dataclass
class CoverPair:
    """A high-confidence cover pairing for one book file."""

    book: BookFile
    image_ref: str  # stable Telegram post URL of the image
    image_url: str  # transient CDN URL (download source only, never a hotlink)
    confidence: float
    evidence: str  # "same_post" | "caption_match"
    image_post_id: int

    def to_record(self) -> dict:
        """The cover fields stored WITH the book metadata (embedded,
        not a separate hotlink): the stable reference + confidence +
        evidence, so a later step can download the bytes once and a
        reader can tell why this cover was trusted."""
        return {
            "cover_ref": self.image_ref,
            "cover_confidence": self.confidence,
            "cover_evidence": self.evidence,
            "cover_post_id": self.image_post_id,
        }


def normalize_for_match(text: str) -> str:
    """Match normalization: Arabic search normalization (tashkeel
    stripped, alef forms unified) + lowercase + punctuation/extra
    spaces collapsed. Display text is never changed — this is only
    for matching a caption against a title."""
    text = normalize_arabic(text or "").lower()
    text = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in text)
    return " ".join(text.split())


def caption_matches_title(caption: str, title: str) -> bool:
    """True when the caption names the book: the normalized title is a
    substring of the normalized caption (or vice versa for a caption
    that IS the title), or every word of a short title appears in the
    caption. Empty/short titles never match — a 1-2 character string
    would match almost any caption by accident."""
    norm_title = normalize_for_match(title)
    norm_caption = normalize_for_match(caption)
    if len(norm_title) < 3 or len(norm_caption) < 3:
        return False
    if norm_title in norm_caption or norm_caption in norm_title:
        return True
    words = [w for w in norm_title.split() if len(w) >= 2]
    if not words or len(words) > 8:
        return False
    caption_words = set(norm_caption.split())
    return all(w in caption_words for w in words)


def pair_cover_for_book(
    book: BookFile, posts: Dict[Tuple[str, int], PostEvidence]
) -> Tuple[Optional[CoverPair], str]:
    """Pair a cover for one book, or return (None, reason).

    Order: (1) image in the SAME post (0.99); (2) a neighbouring post
    (post_id - 1 first, then + 1) whose image caption matches the title
    (0.90). A neighbouring image without a matching caption (0.75) is
    recorded as the reason and does NOT pair — when in doubt, no cover.
    """
    key = (book.source, book.post_id)
    own = posts.get(key)
    if own is not None and own.has_image:
        return CoverPair(
            book=book,
            image_ref=own.image_ref or book.url,
            image_url=own.image_url,
            confidence=SAME_POST_CONFIDENCE,
            evidence="same_post",
            image_post_id=own.post_id,
        ), ""
    # Neighbours: caption match anywhere wins over a bare neighbour
    # image, so scan both neighbours for a match first, then fall back
    # to the (non-pairing) neighbour reason.
    neighbour_image = False
    neighbour_exists = False
    for delta in (-1, 1):
        nb = posts.get((book.source, book.post_id + delta))
        if nb is None:
            continue
        neighbour_exists = True
        if not nb.has_image:
            continue
        neighbour_image = True
        if caption_matches_title(nb.text, book.title):
            return CoverPair(
                book=book,
                image_ref=nb.image_ref or nb_url(nb),
                image_url=nb.image_url,
                confidence=CAPTION_MATCH_CONFIDENCE,
                evidence="caption_match",
                image_post_id=nb.post_id,
            ), ""
    if neighbour_image:
        return None, REASON_NEIGHBOUR_NO_CAPTION
    if not neighbour_exists:
        return None, REASON_NO_NEIGHBOUR
    return None, REASON_NO_IMAGE


def nb_url(post: PostEvidence) -> str:
    """Stable t.me URL for a neighbour image post (its own ref, or
    built from source + post_id when the ref was not recorded)."""
    if post.image_ref:
        return post.image_ref
    return f"https://t.me/{post.source}/{post.post_id}"


def pair_covers(
    books: Iterable[BookFile], posts: Iterable[PostEvidence]
) -> List[Tuple[BookFile, Optional[CoverPair], str]]:
    """Pair covers for many books against the surrounding posts.

    Returns one ``(book, pair_or_None, reason)`` tuple per book, in
    input order; ``reason`` is "" when paired, else one of the
    REASON_* constants. A book whose own post is missing from
    ``posts`` is reported as no-neighbour/no-image, never paired.
    """
    by_key = {(p.source, p.post_id): p for p in posts}
    out: List[Tuple[BookFile, Optional[CoverPair], str]] = []
    for book in books:
        pair, reason = pair_cover_for_book(book, by_key)
        out.append((book, pair, reason))
    return out


def summarize(
    results: List[Tuple[BookFile, Optional[CoverPair], str]],
) -> dict:
    """Honest pairing-rate report for a run (see pair_covers)."""
    total = len(results)
    paired = [r for r in results if r[1] is not None]
    reasons: Dict[str, int] = {}
    for _, pair, reason in results:
        if pair is None:
            reasons[reason] = reasons.get(reason, 0) + 1
    return {
        "total_books": total,
        "paired": len(paired),
        "pairing_rate": (len(paired) / total) if total else 0.0,
        "same_post": sum(1 for _, p, _ in paired if p.evidence == "same_post"),
        "caption_match": sum(
            1 for _, p, _ in paired if p.evidence == "caption_match"
        ),
        "unpaired_by_reason": reasons,
    }


def build_evidence_from_store(store) -> List[PostEvidence]:
    """Build evidence records from a :class:`tbi.store.Store`.

    HONEST LIMITATION: the store records NO photo evidence (posts
    carry text + files only), so every record comes back with
    ``has_image=False`` and a pairing run over it pairs NOTHING.
    This is the correct result for the data as stored — it is why the
    full-catalog run must wait for the capture step (record the image
    flag + reference at scrape/export time, add a cover column to D1).
    The function exists so the pairing can run unchanged the moment
    that data exists: it reads the real posts + files, in post order,
    with the neighbour window intact.
    """
    rows = store.conn.execute(
        "SELECT s.name AS source, p.post_id, p.text, "
        "f.title, f.author, f.filename, f.obtain_url "
        "FROM posts p JOIN sources s ON s.id = p.source_id "
        "LEFT JOIN files f ON f.post_id = p.id "
        "ORDER BY s.name, p.post_id"
    ).fetchall()
    posts: Dict[Tuple[str, int], PostEvidence] = {}
    for r in rows:
        key = (r["source"], r["post_id"])
        post = posts.get(key)
        if post is None:
            post = PostEvidence(
                source=r["source"],
                post_id=r["post_id"],
                text=r["text"] or "",
                has_image=False,
            )
            posts[key] = post
        if r["title"] or r["filename"]:
            post.files.append(
                BookFile(
                    title=r["title"] or "",
                    author=r["author"] or "",
                    filename=r["filename"] or "",
                    post_id=r["post_id"],
                    source=r["source"],
                    url=r["obtain_url"] or "",
                )
            )
    return list(posts.values())
