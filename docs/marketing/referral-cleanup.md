# Referral touches — cleanup review (REVIEW ONLY, no bot change)

Status: **review document, prepared 2026-11-14. The bot was NOT changed**
(another agent owns the bot source; changes below go to a later bot
version, recorded as v4.8.43 follow-ups in
`~/workspace/blocks-open-questions.md`).

Source of the rules reviewed: the Block 12 plan, section 13 (as given for
this block). Note: the repo copy of the bot README (`rlibook-bot/README.md`,
v0.5.1) is STALE — it still lists `/priority` as a live command and an old
referral rule. The live bot is v4.8.31; this review follows the plan's
current rules, not the stale README. Updating that README is itself a
follow-up (see below).

Fairness test used for every touch: **a user must understand in one line
what they get for inviting a friend.**

## 1. Add-channel — 5/day free, +5 per referred friend who starts the bot AND searches

- **Limit right?** Yes. 5/day is generous enough to be useful and small
  enough to stop spam submissions. The "+5 per friend" reward matches the
  effort (a friend who actually starts AND searches is a real user).
- **Message clear?** Mostly. The risk: the user must know the friend has to
  do TWO things (start the bot AND search) — if the bot only says "invite a
  friend, get +5", the user will feel cheated when a friend who only starts
  the bot earns nothing.
- **Referral unlock works?** Yes, in principle (per the plan). Needs a live
  check that the +5 lands the same day and shows in `/invite` usage.
- **Change:** one-line wording in the bot: "ادعُ صديقاً يفتح البوت ويبحث —
  تاخد +5 إضافة قناة النهاردة." Nothing else.

## 2. Priority — 3/day — OLD / INACTIVE (`/priority` was removed in v4.2.0)

- **Limit right?** N/A — the feature is dead. Any remaining mention of
  priority in the bot, the website, or the repo README is a stale promise.
- **Message clear?** No — because the command no longer exists, a user who
  remembers it (or reads the old README) will try it and get nothing.
- **Referral unlock works?** No — nothing to unlock.
- **Change (v4.8.43 follow-up):** remove every remaining "priority" mention
  from the bot's help/usage text, from the website's bot card
  ("واطلب فهرسة بأولوية" is still in `index.html` — owned by another agent,
  flagged here, not edited), and from `rlibook-bot/README.md`. Do NOT
  re-add the feature; just stop promising it.

## 3. Red Flag — 3/day, invite after 3

- **Limit right?** Yes. Flagged (recent commercial) books are the sensitive
  case: 3/day keeps the bot from becoming a piracy funnel, and the cap is
  honest about it.
- **Message clear?** Needs work. "Invite after 3" is ambiguous: does
  inviting 1 friend unlock 3 more, or unlimited? And does the invite have
  to be a friend who starts the bot, or just any invite?
- **Referral unlock works?** Unclear from the plan — the exact unlock
  amount is not stated (contrast add-channel, where it is "+5").
- **Change (v4.8.43 follow-up):** pin the rule down to one line, e.g.
  "بعد 3 كتب مُعلَّمة في اليوم، ادعُ صديقاً واحداً يفتح البوت يفتح لك 3 كمان."
  Then make the bot say exactly that line when the cap is hit.

## 4. Catalog re-send — 3/day, invite after 3, reopens tomorrow

- **Limit right?** Yes. Re-sending the catalog file costs an email each
  time (Resend free tier), so 3/day is a fair cost guard; "reopens tomorrow"
  is the right reset.
- **Message clear?** Almost. The user must know WHY it is limited (email
  cost) in one short line, or the limit feels arbitrary.
- **Referral unlock works?** Same ambiguity as Red Flag: how many extra
  re-sends does one invite unlock?
- **Change (v4.8.43 follow-up):** one line at the cap: "وصلت لـ 3 مرات
  النهاردة — الإرسال بيتفتح بكرة، أو ادعُ صديقاً يفتح البوت يفتح لك 3 كمان."
  (Confirm the unlock amount with the user before building it.)

## 5. Personal catalog — first time free, after 3 requests → invite 1 person; 1 invite covers ALL services

- **Limit right?** Yes — this is the fairest touch in the set: the first
  personal catalog is free, and one invite covers everything, so the user
  is never asked to invite 5 different friends for 5 different services.
- **Message clear?** This is the one that most needs the one-line rule,
  because "1 invite covers ALL services" is the key promise and it is easy
  to bury. It must appear in `/invite` itself, not only in a help page.
- **Referral unlock works?** Yes, by design (per the plan). Verify live
  that a single qualifying invite really unlocks all services at once.
- **Change (v4.8.43 follow-up):** put the line in `/invite` verbatim:
  "دعوة واحدة تكفي كل الخدمات — ادعُ شخصاً واحداً يفتح البوت ويبحث."
  Also correct the OLD rule wherever it survives: there is NO "invite 2
  friends" rule (the user corrected this on 2026-11-10) — check the bot
  text and the README for it and delete it.

## 6. Ask AI — 25/day, hard cap, NO referral unlock

- **Limit right?** Yes. Ask AI costs real API calls (Groq first, Gemini
  fallback); a hard cap with no unlock is the honest way to protect the
  free tier. 25/day is generous for a free service.
- **Message clear?** Yes, if the bot shows the remaining count (it does —
  "remaining-count line"). The one thing to add: when the cap is hit, say
  plainly "بكرة تقدر تسأل تاني" and do NOT offer an invite to unlock it
  (there is none).
- **Referral unlock works?** N/A by design — and that is correct. Do not
  add one later without the user approving it.
- **Change:** none, except: audit the cap-hit message to make sure it never
  promises an invite unlock by mistake.

## Summary table

| Touch | Limit OK? | Message clear? | Unlock defined? | Action |
|---|---|---|---|---|
| Add-channel | ✅ | ~ (needs the "start AND search" line) | ✅ +5 | Wording only |
| Priority | ❌ dead | ❌ stale mentions | ❌ | Remove all mentions (v4.8.43) |
| Red Flag | ✅ | ~ (unlock amount unstated) | ❌ amount? | Pin amount, one line (v4.8.43) |
| Catalog re-send | ✅ | ~ (say why: email cost) | ❌ amount? | Pin amount, one line (v4.8.43) |
| Personal catalog | ✅ | ~ (put "1 invite = all" in /invite) | ✅ | Wording + kill "invite 2 friends" (v4.8.43) |
| Ask AI | ✅ | ✅ | N/A (by design) | None (audit cap message) |

## General findings

- The referral system has **two different unlock models** (per-friend +5 for
  add-channel vs. "1 invite covers all" for the personal catalog). That is
  fine if each is stated in one line where it applies — confusing only if
  the bot mixes them in one message. Keep them separate.
- The user correction of 2026-11-10 ("invite after 3 uses of a service →
  invite 1 person; NO 'invite 2 friends' rule") must be checked against
  every bot string: any surviving "invite 2 friends" text is a bug.
- No touch should ever promise an unlock the bot cannot grant the same day.
