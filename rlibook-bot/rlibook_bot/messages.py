"""Bot reply texts and pure argument parsing (no Telegram import here, so
these are unit-testable without python-telegram-bot installed)."""

from __future__ import annotations

import re

CATALOG_URL = "https://kindle-opds-static.pages.dev"

WELCOME = (
    "👋 Welcome to RliBook — Reply. Read. Fly.\n\n"
    "RliBook is a free catalog of public-domain and Creative Commons books, "
    "indexed from public Telegram channels and groups. Search and download "
    "books in the catalog tool (works on Kindle, any e-reader, iPad and tablet):\n"
    + CATALOG_URL
    + "\n\n"
    "This bot is for submitting, not searching:\n"
    "• /addchannel — submit a channel to index\n"
    "• /addbook — submit a single book\n"
    "• /kindle — get the Kindle / e-reader tool\n"
    "• /priority — priority indexing for your submission\n"
    "• /invite — invite a friend (earn extra additions)\n"
    "• /resources — catalog resources (channels + books)\n"
    "• /help — this list"
)

HELP = (
    "RliBook commands:\n"
    "/addchannel <@channel or link> — submit a channel (5/day free)\n"
    "/addbook <Title> | <Author> | <Source> — submit one book\n"
    "/kindle — the Kindle / e-reader tool\n"
    "/priority <what> — priority indexing (3/day free)\n"
    "/invite — your referral link\n"
    "/resources — catalog resources (channels + books)\n"
    "/donate — donations (open after launch)\n"
    "/help — this list\n\n"
    "Search and download books here: " + CATALOG_URL
)

KINDLE_MSG = (
    "📚 RliBook on Kindle and any e-reader\n\n"
    "Open this link in your Kindle (or any e-reader / iPad / tablet) browser:\n"
    + CATALOG_URL
    + "\n\n"
    "Search any book, open it, and download it — no app, no jailbreak, no "
    "large downloads. A one-tap Kindle launcher file (a small book with links "
    "to search and browse) is coming next; this command will serve it when it is ready.\n\n"
    "Tip: on iPad/tablet, use “Add to Home Screen” to make it look like an app."
)

DONATE_MSG = (
    "💛 Donations open after the project launches properly. "
    "For now, the best support is to use the catalog and invite friends "
    "who love books. Thank you!"
)


def parse_addbook_args(text):
    """Parse '/addbook Title | Author | Source' into (title, author, source).

    Returns (title, author, source) or (None, None, None) if unparseable.
    Author and source are optional; title is required.
    """
    if not text:
        return None, None, None
    parts = [p.strip() for p in text.split("|")]
    title = parts[0] if parts and parts[0] else None
    author = parts[1] if len(parts) > 1 and parts[1] else None
    source = parts[2] if len(parts) > 2 and parts[2] else None
    if not title:
        return None, None, None
    return title, author, source


def parse_channel_arg(text):
    """Normalize a channel argument ('@name', 'https://t.me/name', 'name') to a handle."""
    if not text:
        return None
    handle = text.strip()
    for prefix in ("https://t.me/", "http://t.me/", "t.me/"):
        if handle.startswith(prefix):
            handle = handle[len(prefix):]
    handle = handle.lstrip("@").strip("/").split("/")[0].strip()
    return handle or None


_DL_RE = re.compile(r"^dl_(.+)_(\d+)_([A-Za-z0-9]+)$")


def parse_download_link(arg):
    """Parse a /start dl_<handle>_<post_id>_<format> payload.

    Returns (handle, post_id, format) or None. The handle may contain
    underscores, so the post id (all digits) anchors the split.
    """
    if not arg:
        return None
    m = _DL_RE.match(arg.strip())
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3).lower()


def download_message(handle, post_id, fmt):
    """The reply for a /start dl_ deep link.

    The bot cannot fetch files from channels itself (it only has the Bot
    API token, no Telethon session), so the user downloads the file from
    the original post. Never claim otherwise.
    """
    url = "https://t.me/%s/%s" % (handle, post_id)
    return (
        "⬇️ Download (%s)\n\n"
        "Open the post in Telegram and tap the file to download it:\n%s\n\n"
        "The bot cannot send you the file itself — it has no access to "
        "channel files, so the download happens from the original post."
        % (fmt.upper(), url)
    )
