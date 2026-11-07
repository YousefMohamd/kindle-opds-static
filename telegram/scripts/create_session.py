#!/usr/bin/env python3
"""Create a Telegram session string ONCE, on the owner's own machine.

This is the one-time setup for the optional, manual-only API backfill
(``tbi api-backfill``). Run it once, on the owner's Mac:

    cd telegram
    pip install -e ".[api]"        # or: pip install telethon
    python3 scripts/create_session.py

It asks for:
  1. api_id / api_hash — from https://my.telegram.org (log in there,
     "API development tools", create an app; copy the two values).
     They can also be given as environment variables
     (TELEGRAM_API_ID / TELEGRAM_API_HASH) instead of typed here.
  2. The owner's phone number — Telegram sends a login code to it.
  3. The login code Telegram just sent (and, if two-step verification
     is on, the 2FA password).

It then prints ONE line: the session string. Paste that line into the
GitHub secret TELEGRAM_SESSION_STRING (repo Settings -> Secrets and
variables -> Actions -> New repository secret). That is the only place
it belongs.

**Privacy — read this before running it:**
  * The session string is a SECRET, like a password. Anyone who has
    it can act as the owner's Telegram account. Never share it, never
    paste it into a chat, never commit it.
  * This script NEVER writes the session string (or the api_id /
    api_hash) to any file. It uses an in-memory StringSession and
    prints the string once, to the terminal, for the owner to copy
    into the GitHub secret. Nothing is saved in this repo tree.
  * The API backfill runs ONLY when the owner starts it manually
    (``tbi api-backfill`` / the ``telegram-api-backfill`` workflow's
    manual dispatch). It is NOT part of the daily scheduled job, so
    nothing runs continuously tied to the owner's account.

Do NOT run this script on a shared machine, and do NOT run it from
any agent/CI environment — it needs the owner's phone and the login
code only the owner receives.
"""

from __future__ import annotations

import asyncio
import getpass
import os
import sys


def _prompt(text: str, *, secret: bool = False) -> str:
    value = getpass.getpass(text) if secret else input(text)
    return (value or "").strip()


async def main() -> int:
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        print(
            "Error: Telethon is not installed.\n"
            "Run: pip install -e \".[api]\"  (or: pip install telethon)",
            file=sys.stderr,
        )
        return 2

    api_id_raw = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()
    if not api_id_raw:
        api_id_raw = _prompt("api_id (from https://my.telegram.org): ")
    if not api_hash:
        api_hash = _prompt("api_hash (from https://my.telegram.org): ", secret=True)
    try:
        api_id = int(api_id_raw)
    except ValueError:
        print("Error: api_id must be an integer.", file=sys.stderr)
        return 2
    if not api_hash:
        print("Error: api_hash must not be empty.", file=sys.stderr)
        return 2

    phone = _prompt("Phone number (with country code, e.g. +20100...): ")
    if not phone:
        print("Error: phone number must not be empty.", file=sys.stderr)
        return 2

    # StringSession() is in-memory only: nothing is written to disk.
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.start(phone=phone)
    session_string = client.session.save()
    await client.disconnect()

    print()
    print("=" * 70)
    print("Your session string (ONE line). Paste it into the GitHub secret")
    print("TELEGRAM_SESSION_STRING — and nowhere else. Never share it.")
    print("=" * 70)
    print(session_string)
    print("=" * 70)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
