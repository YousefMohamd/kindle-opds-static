"""Command handlers for the RliBook bot (submit-only).

The bot never searches or downloads books. Search and download happen in
the catalog web tool: https://kindle-opds-static.pages.dev
"""

from __future__ import annotations

import os
from datetime import date

from telegram import Update
from telegram.ext import ContextTypes

from .bookcheck import check_book
from .limits import Limits, parse_referral, referral_link
from .messages import (
    CATALOG_URL,
    DONATE_MSG,
    HELP,
    KINDLE_MSG,
    WELCOME,
    parse_addbook_args,
    parse_channel_arg,
)
from .stats import fetch_stats, format_stats

OWNER_ID = int(os.environ.get("RLIBOOK_OWNER_ID", "0") or 0)


def today_str():
    return date.today().isoformat()


def is_owner(user_id):
    return bool(OWNER_ID) and user_id == OWNER_ID


def get_limits(context):
    """The per-bot Limits store (one per application, kept in bot_data)."""
    limits = context.application.bot_data.get("limits")
    if limits is None:
        db_path = os.environ.get("RLIBOOK_LIMITS_DB", "rlibook-limits.db")
        limits = Limits(db_path)
        context.application.bot_data["limits"] = limits
    return limits


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    # Referral: /start ref_<id>
    if context.args:
        referrer = parse_referral(context.args[0])
        if referrer is not None and user is not None:
            limits = get_limits(context)
            if limits.apply_referral(referrer, user.id, today_str()):
                await update.message.reply_text(
                    "🎉 You joined via a friend's invite — you both earned extra additions today!"
                )
    await update.message.reply_text(WELCOME)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(HELP)


async def kindle(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(KINDLE_MSG)


async def donate(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(DONATE_MSG)


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(format_stats(fetch_stats()))


async def invite(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    username = context.bot.username or "RliBook_bot"
    link = referral_link(username, user.id)
    limits = get_limits(context)
    day = today_str()
    await update.message.reply_text(
        "🔗 Your invite link:\n%s\n\n"
        "Each friend who starts the bot from your link and searches earns you "
        "+5 channel additions and +3 priority that day (and they get a small bonus too).\n"
        "Today you have used %d of %d channel additions and %d of %d priority."
        % (
            link,
            limits.used(user.id, "channel", day),
            limits.allowance(user.id, "channel", day),
            limits.used(user.id, "priority", day),
            limits.allowance(user.id, "priority", day),
        )
    )


async def addchannel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    day = today_str()
    limits = get_limits(context)
    if not limits.can(user.id, "channel", day, is_owner=is_owner(user.id)):
        await update.message.reply_text(
            "You have used today's 5 free channel additions. Invite a friend "
            "(/invite) to earn +5 more today, or try again tomorrow."
        )
        return
    arg = " ".join(context.args).strip() if context.args else ""
    if not arg:
        await update.message.reply_text(
            "Send the channel like this:\n/addchannel @channelname\nor\n/addchannel https://t.me/channelname"
        )
        return
    handle = parse_channel_arg(arg)
    if not handle:
        await update.message.reply_text(
            "That channel name does not look right. Try /addchannel @channelname"
        )
        return
    # Verify-first: the channel must exist and be public.
    try:
        chat = await context.bot.get_chat("@" + handle)
    except Exception:
        await update.message.reply_text(
            "Could not find @%s. Make sure the channel is public and the name is correct." % handle
        )
        return
    if chat.type not in ("channel", "supergroup"):
        await update.message.reply_text(
            "@%s is not a channel or group. Please send a channel or a group." % handle
        )
        return
    limits.record(user.id, "channel", day)
    await update.message.reply_text(
        "✅ @%s received. It will be checked first (public, exists, "
        "book content in Kindle/PDF formats, not spam) and then indexed. "
        "You will be notified when it is added to the catalog." % handle
    )


async def addbook(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args).strip() if context.args else ""
    title, author, source = parse_addbook_args(text)
    if not title:
        await update.message.reply_text(
            "Send the book like this:\n/addbook Title | Author | Source\n\n"
            "Example:\n/addbook Pride and Prejudice | Jane Austen | Project Gutenberg\n\n"
            "Source = where you got the book (so the catalog records it)."
        )
        return
    if not source:
        await update.message.reply_text(
            "Please include the source (where you got the book), so the catalog records it:\n"
            "/addbook " + title + ((" | " + author) if author else "") + " | <Source>"
        )
        return
    result = check_book(title, author)
    if result["verdict"] == "refuse":
        await update.message.reply_text("❌ This upload is refused.\n\n" + result["reason"])
        return
    if result["verdict"] == "unknown":
        await update.message.reply_text("📝 Received. " + result["reason"])
        return
    await update.message.reply_text(
        "✅ Received: “%s”%s (source: %s).\nCheck: %s\nIt will be indexed and you will be notified."
        % (title, (" by " + author) if author else "", source, result["reason"])
    )


async def priority(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    day = today_str()
    limits = get_limits(context)
    if not limits.can(user.id, "priority", day, is_owner=is_owner(user.id)):
        await update.message.reply_text(
            "You have used today's 3 free priority indexing. Invite a friend "
            "(/invite) to earn +3 more today, or try again tomorrow."
        )
        return
    what = " ".join(context.args).strip() if context.args else ""
    if not what:
        await update.message.reply_text("What should be indexed first?\n/priority <channel or book title>")
        return
    limits.record(user.id, "priority", day)
    await update.message.reply_text(
        "⚡ Priority indexing requested for: %s\nIt will be indexed before the normal queue." % what
    )
