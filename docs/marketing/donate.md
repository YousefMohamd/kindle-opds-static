# Donate link (Buy Me a Coffee) — exact placements (PREPARE ONLY)

Status: **READY TO ADD AT LAUNCH — the link has NOT been added anywhere.**
The user deferred the donate link until the project is published correctly.
Nothing below is live. Do NOT add the link to the site, the bot, or the
README until the user says the project is published correctly.

## ⚠️ Missing piece (recorded as an open question)

The actual Buy Me a Coffee URL was **not supplied** for this block — no URL
is invented here. The user must provide his Buy Me a Coffee page URL
(e.g. `https://www.buymeacoffee.com/<his-name>`) before any placement is
filled in. Every placement below uses the placeholder
`<BUY_ME_A_COFFEE_URL>` until then.

## Placement 1 — Bot bio (Telegram, via @BotFather)

- Where: the bot's "About" / bio text (the short description users see
  before they press Start), edited in @BotFather → /mybots → @RliBook_bot →
  Edit About.
- Exact wording to append at the end of the bio (Arabic, one line):
  > ☕ لو المكتبة نفعتك، ادعمنا بكوب قهوة: <BUY_ME_A_COFFEE_URL>
- Note: the bio has a character limit — if it does not fit, use the short
  form: `☕ ادعمنا: <BUY_ME_A_COFFEE_URL>`

## Placement 2 — Website (rlibook.tech, `index.html` — owned by another agent)

- Where: a small "ادعمنا" line in the footer area of the homepage, under
  the bot card and above the existing legal note
  ("RliBook — فهرس مجاني للكتب العامة..."), so it does not compete with
  the search or the bot button.
- Exact wording (Arabic):
  > ☕ RliBook مجاني — لو حابب تدعم استمراره، اشترِ لنا قهوة:
  > <BUY_ME_A_COFFEE_URL>
- Style: same `.note` class as the existing footer note; no banner, no
  popup, no sticky button. The link opens in a new tab
  (`target="_blank" rel="noopener"`).
- NOT added yet — this file is the instruction for the website agent at
  launch time.

## Placement 3 — README (`README.md` in the repo root)

- Where: a short section near the top of the README (after the project
  intro, before the setup instructions).
- Exact wording:
  > ## Support
  >
  > RliBook is free. If it helped you, you can support it here:
  > ☕ <BUY_ME_A_COFFEE_URL>
- NOT added yet — same launch gate as the other two placements.

## Placement 4 — Bot `/donate` command (already exists, no link yet)

- The bot already has a `/donate` command whose current reply is
  "Donations open after the project launches properly (no link yet)"
  (see `rlibook-bot/README.md`). At launch, its reply becomes the same
  one-liner as the bio:
  > ☕ لو المكتبة نفعتك، ادعمنا بكوب قهوة: <BUY_ME_A_COFFEE_URL>
- This is a bot change (another agent owns the bot) — recorded here as a
  launch-time instruction, not built now.

## Launch checklist (when the user says "published correctly")

1. User supplies the real Buy Me a Coffee URL.
2. Replace `<BUY_ME_A_COFFEE_URL>` in all four placements.
3. Bot bio (user, via @BotFather) + `/donate` reply (bot agent).
4. Website footer line (website agent) + README section (repo push).
5. Verify all four links open the correct page (click each one).
