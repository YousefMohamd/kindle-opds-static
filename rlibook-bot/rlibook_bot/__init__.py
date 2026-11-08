"""RliBook Telegram bot — submit-only bot for the RliBook book catalog.

The bot lets users submit channels and single books for indexing, request
the Kindle / e-reader tool, and invite friends. It never searches books and
never downloads books; search and download happen in the catalog web tool
(https://kindle-opds-static.pages.dev).

Why this lives in `rlibook-bot/` (not under `telegram/`): the repo already
has a `telegram/` directory for the indexer, and that directory name would
shadow the installed `python-telegram-bot` library (`import telegram`) when
the bot runs from the repo root. This directory is the Railway service root.
"""

__version__ = "0.5.0"
