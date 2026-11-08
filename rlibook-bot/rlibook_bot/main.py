"""RliBook bot entry point. Reads TELEGRAM_BOT_TOKEN from the environment."""

from __future__ import annotations

import logging
import os
import sys

from telegram.ext import Application, CommandHandler

from . import __version__
from .handlers import (
    addbook,
    addchannel,
    donate,
    help_command,
    invite,
    kindle,
    priority,
    start,
    stats,
)

logging.basicConfig(
    format="%(asctime)s %(name)s %(levelname)s: %(message)s", level=logging.INFO
)
log = logging.getLogger("rlibook-bot")


def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        print("TELEGRAM_BOT_TOKEN is not set. Set it as an environment variable.", file=sys.stderr)
        sys.exit(2)
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("kindle", kindle))
    app.add_handler(CommandHandler("donate", donate))
    app.add_handler(CommandHandler("stats", stats))
    app.add_handler(CommandHandler("invite", invite))
    app.add_handler(CommandHandler("addchannel", addchannel))
    app.add_handler(CommandHandler("addbook", addbook))
    app.add_handler(CommandHandler("priority", priority))
    log.info("RliBook bot v%s starting (polling)", __version__)
    app.run_polling()


if __name__ == "__main__":
    main()
