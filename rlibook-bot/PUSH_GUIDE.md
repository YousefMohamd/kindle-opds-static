# Push guide — RliBook bot v0.5.0

Unzip over your repo clone, then commit + push. If the push is rejected
(the remote moved), do `git pull --rebase` then `git push` again.
NEVER force-push.

New in v0.5.0: the submit-only Telegram bot (@RliBook_bot) in `rlibook-bot/`
— commands /start, /addchannel, /addbook, /kindle, /priority, /invite,
/stats, /donate, /help; the /addbook check refuses recent commercial releases
(Google Books / Open Library); referrals (+5 channel / +3 priority per
friend); Railway deployment config (Root Directory: `rlibook-bot/`).
The bot token is NOT in this zip — it stays in GitHub Secrets / Railway
environment variables as TELEGRAM_BOT_TOKEN.
