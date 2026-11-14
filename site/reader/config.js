// RliBook Reader — login config (Block 11b).
//
// Fill these in when the accounts are ready. NOTHING here is a secret:
// a Google client ID and a Telegram bot username are public values
// that belong in the page. No token, key or password ever goes here.
//
// GOOGLE_CLIENT_ID — Google Cloud Console (free, no card) >
//   APIs & Services > Credentials > OAuth client ID (Web application),
//   authorised origin https://rlibook.tech. Empty = the Google button
//   shows "Google login is not set up yet" and Telegram is offered.
//   See README.md ("Login setup") and blocks-open-questions.md.
// BOT_USERNAME — the Telegram bot that owns login: RliBook_bot.
//   The bot's domain must be set in BotFather (/setdomain -> rlibook.tech)
//   or the Telegram button shows Telegram's own error; the bot link
//   below it always works as a fallback.
window.RLIBOOK_READER_CONFIG = {
  GOOGLE_CLIENT_ID: "",
  BOT_USERNAME: "RliBook_bot",
  BOT_LOGIN_URL: "https://t.me/RliBook_bot?start=login",
};
