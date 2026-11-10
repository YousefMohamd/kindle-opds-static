# RliBook bot (v0.5.1)

Submit-only Telegram bot for the RliBook catalog (@RliBook_bot). It lets users
submit channels and single books for indexing, request the Kindle / e-reader
tool, and invite friends. It never searches books and never downloads books —
search and download happen in the catalog web tool:
https://kindle-opds-static.pages.dev

## Why `rlibook-bot/` lives at the repo root

The repo already has a `telegram/` directory (the indexer), and that directory
name would shadow the installed `python-telegram-bot` library (`import
telegram`) when the bot runs from the repo root. So the bot is its own
deployment directory. In Railway, set the service **Root Directory** to
`rlibook-bot/`.

## Commands

| Command | What it does |
|---|---|
| /start | Welcome + catalog link (+ referral via `/start ref_<id>`) |
| /addchannel <@name or link> | Submit a channel (verify-first: public, exists, book content, not spam). 5/day free; owner exempt. |
| /addbook <Title> \| <Author> \| <Source> | Submit one book. Asks for the source and checks it (see below). |
| /kindle | The Kindle / e-reader tool link + instructions (the one-tap launcher file is coming next; this command will serve it when ready). |
| /priority <what> | Priority indexing for a submission. 3/day free. |
| /invite | Your referral link + today's usage. |
| /resources | Catalog resources: channel count + book count (from the published index report). |
| /donate | Donations open after the project launches properly (no link yet). |
| /help | Command list. |

## The /addbook legal check

`/addbook` asks for the source (where the book came from) and checks the
title against Google Books and Open Library (publication date). If the book
is a recent commercial release (published within the last 2 years, not
public-domain), the upload is **refused** and the reason is stated. If the
book cannot be found, it is **not** refused — it goes to manual review
(never refuse on uncertainty).

## Referrals

Search is free and unlimited (in the catalog tool, not the bot). Channel
additions are 5/day free and priority is 3/day free. More comes only via
referral: each friend who starts the bot from your link and searches earns
you +5 channel additions and +3 priority that day; the friend gets a small
bonus (+1/+1) too. No paying, no in-bot ads.

## Deploy on Railway (free tier, 24/7)

1. Create a Railway project and connect the repo `YousefMohamd/kindle-opds-static`.
2. Set the service **Root Directory** to `rlibook-bot/`.
3. Add the environment variable `TELEGRAM_BOT_TOKEN` (the BotFather token —
   never put it in the repo or in chat). Optional: `RLIBOOK_OWNER_ID` (your
   Telegram user id, so the daily limits do not apply to you).
4. Deploy. The start command is `python -m rlibook_bot.main` (see
   `railway.json` / `Procfile`). The bot uses long polling (no webhook, no
   public URL needed).

## Run locally (test only)

```bash
cd rlibook-bot
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
TELEGRAM_BOT_TOKEN=your-bot-token-here python -m rlibook_bot.main
```

## Tests

```bash
python -m pytest telegram/tests/test_bot.py -v
```

No network and no Telegram token are needed for the tests (HTTP calls are
mocked). The handler module needs `python-telegram-bot` installed to import;
the pure modules (`bookcheck`, `limits`, `stats`, `messages`) do not.
