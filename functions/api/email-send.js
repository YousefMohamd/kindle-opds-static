// Shared email sender with Brevo fallback (RliBook, round 3, 2026-11-16).
//
// Resend is PRIMARY; Brevo is the automatic FALLBACK / overflow.
//   Resend free tier: 100 emails/day, 3,000/month (project-wide).
//   Brevo free tier:  300 emails/day, no card, no stated expiry.
//   Combined capacity: 400 emails/day. Email is UNLIMITED per user
//   (no per-user cap); the provider caps are project-wide.
//
// Flow (sendEmailWithFallback): try Resend first. ANY Resend failure
// — rate-limit (HTTP 429, the daily cap) or any other failure —
// retries the SAME message via Brevo. If Brevo also fails:
//   - either provider answered 429 (both caps hit) -> the email is
//     queued for tomorrow when a queue is given (code E_QUEUED), so
//     it is never silently dropped; without a queue the result is
//     E_BOTH_EXHAUSTED ("try again tomorrow").
//   - neither was a 429 (e.g. an unverified domain on either side)
//     -> E_SEND_FAILED; queueing would not help tomorrow.
//
// The sender identity is the SAME on both providers —
// "RliBook <send@rlibook.tech>" (from send@rlibook.tech) — and the
// mandatory User-Agent header ("RliBook-bot/1.0") goes on EVERY send:
// Resend sits behind Cloudflare, which answers 403 to requests
// without a User-Agent (verified live 2026-11-11).
//
// Brevo API (verified against Brevo's own docs,
// developers.brevo.com/reference/sendtransacemail, 2026-11-16):
//   POST https://api.brevo.com/v3/smtp/email
//   headers: api-key: <BREVO_API_KEY>, Content-Type: application/json
//   body: { sender: { name, email }, to: [{ email }], subject,
//           htmlContent, textContent, attachment: [{ name, content }] }
//   success: 201 with { messageId }. Keys start with `xkeysib-` and
//   are read ONLY from the env var BREVO_API_KEY (Pages dashboard /
//   Secure Vault) — never in the repo, never in a test, never in a
//   report. There is NO live Brevo send in this environment (no key),
//   so the fallback logic is tested with mocks only (see the test
//   file); the first real Brevo send must be tested live after setup.
//
// SETUP the parent must do before Brevo can send:
//   1. Brevo account (free, no card), approved for sending — Brevo
//      only sends once the account is approved.
//   2. Verify rlibook.tech in Brevo (Senders & Domains): Brevo shows
//      a "Brevo code" TXT record and a DKIM TXT record to add to the
//      Cloudflare DNS. (Brevo needs NO SPF record — its envelope-from
//      is handled by Brevo's own servers.) Until verified, Brevo
//      rejects the send.
//   3. Set the BREVO_API_KEY Pages env var (secret).
//
// HONEST LIMITS (same as the bot's kindle-email.ts):
//   - Brevo's free plan stamps EVERY email with a "Sent with Brevo"
//     footer/branding that cannot be removed on free (removal is a
//     paid add-on, ~$9-12/month on Starter). Fallback emails carry
//     that footer; Resend (primary) emails do not.
//   - Brevo's API docs list the attachment extensions it accepts —
//     and `.epub` is NOT on that list (pdf, docx, doc, txt, mobi,
//     zip... are). RliBook's attachments are almost always EPUB, so
//     the Brevo fallback for an EPUB attachment is UNVERIFIED and
//     may be rejected with a 400. PDF/TXT/DOC attachments are on
//     the supported list. Test a live EPUB send first after setup.
//
// This module is plain JS (Pages Functions) and mirrors the bot's
// src/kindle-email.ts send logic (same contract, same codes) so both
// email paths behave identically.

/** The Brevo API endpoint for sending one transactional email. */
export const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

/** The Brevo sender display name — same identity as Resend. */
export const BREVO_SENDER_NAME = "RliBook";

/** The User-Agent header every provider send carries. */
export const EMAIL_USER_AGENT = "RliBook-bot/1.0";

/** The message shape: the Resend request body (from, to, subject,
//  html, attachments). The Brevo body is derived from it, so the
//  caller builds the message once. `text` is optional plain text
//  for Brevo's textContent (falls back to ""). */
export function buildBrevoRequest(message, senderEmail) {
  return {
    sender: { name: BREVO_SENDER_NAME, email: senderEmail },
    to: (message.to || []).map((email) => ({ email })),
    subject: message.subject,
    htmlContent: message.html,
    textContent: message.text || "",
    attachment: (message.attachments || []).map((a) => ({
      name: a.filename,
      content: a.content,
    })),
  };
}

/** One provider POST. Returns the outcome without throwing: a
 *  non-2xx status keeps the provider's error message, a thrown
 *  fetch keeps the throw's message. `status` is present when the
 *  provider answered (so callers can tell a 429 rate-limit from any
 *  other failure). */
async function postProvider(url, headers, body, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.ok) {
      let messageId = "";
      try {
        const data = await res.json();
        messageId = (data && (data.id || data.messageId)) || "";
      } catch {
        // No JSON body — still a success.
      }
      return { ok: true, status: res.status, messageId };
    }
    let detail = "HTTP " + res.status;
    try {
      const data = await res.json();
      const msg = (data && data.error && data.error.message) || (data && data.message);
      if (msg) detail = msg;
    } catch {
      // Keep the HTTP-status detail.
    }
    return { ok: false, status: res.status, detail };
  } catch (e) {
    return { ok: false, detail: (e && e.message) || String(e) };
  }
}

/** Send one email: Resend first, Brevo on any Resend failure, queue
 *  for tomorrow when both providers are rate-limited.
 *
 *  opts: {
 *    resendApiKey, brevoApiKey: strings (either may be empty),
 *    resendApiUrl: Resend endpoint (default https://api.resend.com/emails),
 *    fetchImpl: fetch (defaults to the global fetch),
 *    message: the Resend-shaped message (see buildBrevoRequest),
 *    senderEmail: the Brevo sender address (default send@rlibook.tech),
 *    queue: optional { enqueue(payload): Promise<boolean> },
 *    queuePayload: what to enqueue (defaults to the message),
 *  }
 *  Returns { ok: true, messageId, provider: "resend"|"brevo" } or
 *  { ok: false, code, message?, queued? } with codes E_NO_API_KEY,
 *  E_SEND_FAILED, E_QUEUED (queued:true), E_BOTH_EXHAUSTED. */
export async function sendEmailWithFallback(opts) {
  const resendKey = (opts.resendApiKey || "").trim();
  const brevoKey = (opts.brevoApiKey || "").trim();
  const fetchImpl = opts.fetchImpl || fetch;
  const resendUrl = opts.resendApiUrl || "https://api.resend.com/emails";
  const senderEmail = opts.senderEmail || "send@rlibook.tech";
  if (!resendKey && !brevoKey) {
    return { ok: false, code: "E_NO_API_KEY", message: "RESEND_API_KEY not configured" };
  }
  // Resend first (primary). Any failure falls through to Brevo.
  let resendAttempt = null;
  if (resendKey) {
    resendAttempt = await postProvider(
      resendUrl,
      {
        Authorization: "Bearer " + resendKey,
        "Content-Type": "application/json",
        "User-Agent": EMAIL_USER_AGENT,
      },
      opts.message,
      fetchImpl,
    );
    if (resendAttempt.ok) {
      return { ok: true, messageId: resendAttempt.messageId || "", provider: "resend" };
    }
  }
  // Brevo fallback (300/day). Same sender, same message — and the
  // same mandatory User-Agent header on every send.
  let brevoAttempt = null;
  if (brevoKey) {
    brevoAttempt = await postProvider(
      BREVO_API_URL,
      {
        "api-key": brevoKey,
        "Content-Type": "application/json",
        "User-Agent": EMAIL_USER_AGENT,
      },
      buildBrevoRequest(opts.message, senderEmail),
      fetchImpl,
    );
    if (brevoAttempt.ok) {
      return { ok: true, messageId: brevoAttempt.messageId || "", provider: "brevo" };
    }
  }
  // Only one provider was configured — keep the old single-provider
  // failure shape (E_SEND_FAILED + that provider's message).
  if (!brevoAttempt && resendAttempt) {
    return { ok: false, code: "E_SEND_FAILED", message: resendAttempt.detail };
  }
  if (!resendAttempt && brevoAttempt) {
    return { ok: false, code: "E_SEND_FAILED", message: brevoAttempt.detail };
  }
  // Both providers were tried and both failed.
  const rateLimited =
    (resendAttempt && resendAttempt.status === 429) ||
    (brevoAttempt && brevoAttempt.status === 429);
  if (rateLimited) {
    // Both caps hit (combined 400/day) — queue for tomorrow when a
    // queue was given, so the email is never silently dropped.
    if (opts.queue) {
      try {
        if (await opts.queue.enqueue(opts.queuePayload !== undefined ? opts.queuePayload : opts.message)) {
          return {
            ok: false,
            code: "E_QUEUED",
            queued: true,
            message: "Both email providers are at their daily limit — queued for tomorrow",
          };
        }
      } catch {
        // Enqueue failed — fall through to E_BOTH_EXHAUSTED.
      }
    }
    return {
      ok: false,
      code: "E_BOTH_EXHAUSTED",
      message:
        "Both email providers are at their daily limit (Resend 100/day, Brevo 300/day) — try again tomorrow",
    };
  }
  // Both failed for a non-capacity reason (e.g. an unverified
  // domain on either side) — queueing would not help tomorrow.
  const detail = [
    resendAttempt && resendAttempt.detail ? "Resend: " + resendAttempt.detail : "",
    brevoAttempt && brevoAttempt.detail ? "Brevo: " + brevoAttempt.detail : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { ok: false, code: "E_SEND_FAILED", message: detail || "Both email providers failed" };
}
