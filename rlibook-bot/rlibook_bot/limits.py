"""Per-user daily limits and referrals for the RliBook bot.

Stored in a small SQLite database (stdlib only). The owner/admin (set via
RLIBOOK_OWNER_ID) is exempt from limits.
"""

from __future__ import annotations

import sqlite3

CHANNEL_LIMIT = 5
PRIORITY_LIMIT = 3
REFERRAL_CHANNEL_BONUS = 5
REFERRAL_PRIORITY_BONUS = 3
NEW_USER_CHANNEL_BONUS = 1
NEW_USER_PRIORITY_BONUS = 1


class Limits:
    def __init__(self, db_path=":memory:"):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS usage "
            "(user_id INTEGER, kind TEXT, day TEXT, count INTEGER, "
            "PRIMARY KEY (user_id, kind, day))"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS bonuses "
            "(user_id INTEGER, kind TEXT, day TEXT, bonus INTEGER, "
            "PRIMARY KEY (user_id, kind, day))"
        )
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS referrals "
            "(referrer_id INTEGER, referred_id INTEGER, day TEXT, "
            "PRIMARY KEY (referrer_id, referred_id))"
        )
        self.conn.commit()

    def allowance(self, user_id, kind, day):
        base = CHANNEL_LIMIT if kind == "channel" else PRIORITY_LIMIT
        row = self.conn.execute(
            "SELECT bonus FROM bonuses WHERE user_id=? AND kind=? AND day=?",
            (user_id, kind, day),
        ).fetchone()
        return base + (row[0] if row else 0)

    def used(self, user_id, kind, day):
        row = self.conn.execute(
            "SELECT count FROM usage WHERE user_id=? AND kind=? AND day=?",
            (user_id, kind, day),
        ).fetchone()
        return row[0] if row else 0

    def can(self, user_id, kind, day, is_owner=False):
        if is_owner:
            return True
        return self.used(user_id, kind, day) < self.allowance(user_id, kind, day)

    def record(self, user_id, kind, day):
        self.conn.execute(
            "INSERT INTO usage (user_id, kind, day, count) VALUES (?, ?, ?, 1) "
            "ON CONFLICT(user_id, kind, day) DO UPDATE SET count = count + 1",
            (user_id, kind, day),
        )
        self.conn.commit()

    def apply_referral(self, referrer_id, referred_id, day):
        """A new user started the bot from referrer_id's link.

        Grants the referrer +5 channel additions and +3 priority for today,
        and the new user a small bonus (+1/+1). Returns True if this is a
        new referral, False if it was already recorded (or self-referral).
        """
        if referrer_id == referred_id:
            return False
        try:
            self.conn.execute(
                "INSERT INTO referrals (referrer_id, referred_id, day) VALUES (?, ?, ?)",
                (referrer_id, referred_id, day),
            )
        except sqlite3.IntegrityError:
            return False
        for kind, bonus in (
            ("channel", REFERRAL_CHANNEL_BONUS),
            ("priority", REFERRAL_PRIORITY_BONUS),
        ):
            self.conn.execute(
                "INSERT INTO bonuses (user_id, kind, day, bonus) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, kind, day) DO UPDATE SET bonus = bonus + ?",
                (referrer_id, kind, day, bonus, bonus),
            )
        for kind, bonus in (
            ("channel", NEW_USER_CHANNEL_BONUS),
            ("priority", NEW_USER_PRIORITY_BONUS),
        ):
            self.conn.execute(
                "INSERT INTO bonuses (user_id, kind, day, bonus) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, kind, day) DO UPDATE SET bonus = bonus + ?",
                (referred_id, kind, day, bonus, bonus),
            )
        self.conn.commit()
        return True


def referral_link(bot_username, user_id):
    return "https://t.me/%s?start=ref_%s" % (bot_username, user_id)


def parse_referral(start_arg):
    """Parse a /start argument like 'ref_12345' into the referrer id, or None."""
    if not start_arg:
        return None
    if start_arg.startswith("ref_"):
        try:
            return int(start_arg[4:])
        except ValueError:
            return None
    return None
