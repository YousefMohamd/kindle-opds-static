"""telegram-book-index: standalone index of books shared in public Telegram
channels (live scrape of the public t.me/s/ preview) and public groups
(Telegram Desktop export parsing). No Telegram API credentials by default,
no server, no background daemon — on-demand CLI only. An optional,
manual-only API backfill (MTProto / Telethon) reads a channel/group's
full history; its credentials live only as GitHub Actions secrets."""

__version__ = "0.6.0"
