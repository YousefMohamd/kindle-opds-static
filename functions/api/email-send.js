// Shared email sender with Brevo + SMTP2GO fallback (RliBook, round 4, 2026-11-16).
//
// Resend is PRIMARY; Brevo is the FIRST fallback; SMTP2GO is the
// SECOND fallback (round 4).
//   Resend free tier:  100 emails/day, 3,000/month (project-wide).
//   Brevo free tier:   300 emails/day, no card, no stated expiry.
//   SMTP2GO free tier: 200 emails/day, 1,000/month, no card, no
//                       stated expiry ("free for as long as you
//                       like"); 25/hour until the sending domain is
//                       verified (cap lifted on request / support
//                       ticket after verification); 5-day log
//                       retention.
//   Combined capacity: 600 emails/day. Email is UNLIMITED per user
//   (no per-user cap); the provider caps are project-wide.
//
// Flow (sendEmailWithFallback): try Resend first. ANY Resend failure
// — rate-limit (HTTP 429, the daily cap) or any other failure —
// retries the SAME message via Brevo; ANY Brevo failure retries the
// SAME message via SMTP2GO. If all three fail:
//   - any provider answered 429 (caps hit) -> the email is queued
//     for tomorrow when a queue is given (code E_QUEUED), so it is
//     never silently dropped; without a queue the result is
//     E_BOTH_EXHAUSTED ("try again tomorrow"). (The code name is
//     kept from round 3 for compatibility — it now means "all three
//     providers exhausted".)
//   - none was a 429 (e.g. an unverified domain on any side)
//     -> E_SEND_FAILED; queueing would not help tomorrow.
//
// The sender identity is the SAME on all three providers —
// "RliBook <send@rlibook.tech>" for Resend, { name: "RliBook",
// email: "send@rlibook.tech" } for Brevo, and the bare address
// "send@rlibook.tech" for SMTP2GO (its `sender` parameter is a
// plain email address, per its own docs) — and the mandatory
// User-Agent header ("RliBook-bot/1.0") goes on EVERY send:
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
// SMTP2GO API (verified against SMTP2GO's own docs,
// developers.smtp2go.com/docs/send-an-email and
// apidoc.smtp2go.com/documentation, 2026-11-16):
//   POST https://api.smtp2go.com/v3/email/send
//   headers: X-Smtp2go-Api-Key: <SMTP2GO_API_KEY>,
//            Content-Type: application/json
//   (the key may alternatively go in the body as "api_key" — the
//   header is used here, as the docs present it first.)
//   body: { sender (string, bare address), to: [address],
//           subject, text_body, html_body,
//           attachments: [{ filename, fileblob (base64),
//                           mimetype }] }
//   success: 200 with { data: { succeeded, failed, failures,
//   email_id } } — a 200 with succeeded === 0 is a failure (no
//   recipient accepted). Keys are read ONLY from the env var
//   SMTP2GO_API_KEY (Pages dashboard / Secure Vault) — never in
//   the repo, never in a test, never in a report. There is NO live
//   SMTP2GO send in this environment (no key), so the fallback
//   logic is tested with mocks only (see the test file); the first
//   real SMTP2GO send must be tested live after setup.
//
// SETUP the parent must do before SMTP2GO can send:
//   1. SMTP2GO account (free, no card) + an API key with the
//      /email/send endpoint enabled (Settings → API Keys).
//   2. Verify the sending domain/sender in SMTP2GO (Settings →
//      Verified Senders / Sender Domains): until the domain is
//      verified SMTP2GO caps sends at 25/hour; ask support to lift
//      the hourly cap after verification.
//   3. Set the SMTP2GO_API_KEY Pages env var (secret).
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
//   - SMTP2GO footer/branding: NO evidence of a forced footer on
//     free was found in any source checked, and no source says
//     there is none either — UNCONFIRMED. SMTP2GO is a pure
//     transactional relay with no marketing side. Verify with a
//     live test send.
//   - SMTP2GO `.epub`: its API accepts arbitrary base64
//     attachments ({ filename, fileblob, mimetype }) and publishes
//     NO extension allowlist and NO `.epub` exclusion (unlike
//     Brevo). So `.epub` is NOT blocked by any published rule —
//     but it is NOT explicitly confirmed either. A live EPUB send
//     is still needed after setup (same caveat as Brevo).
//
// This module is plain JS (Pages Functions) and mirrors the bot's
// src/kindle-email.ts send logic (same contract, same codes) so both
// email paths behave identically.

/** The Brevo API endpoint for sending one transactional email. */
export const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

/** The SMTP2GO API endpoint for sending one email (round 4). */
export const SMTP2GO_API_URL = "https://api.smtp2go.com/v3/email/send";

/** The Brevo sender display name — same identity as Resend. */
export const BREVO_SENDER_NAME = "RliBook";

/** The SMTP2GO sender — the SAME address as Resend/Brevo, but as a
 *  bare address: SMTP2GO's `sender` parameter is a plain email
 *  address string (per its own docs), not a "Name <addr>" string. */
export const SMTP2GO_SENDER = "send@rlibook.tech";

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

/** MIME type for an SMTP2GO attachment, from the filename
 *  extension. The website's message attachments carry no MIME (the
 *  Resend/Brevo shapes do not need one), so SMTP2GO's `mimetype`
 *  is derived here. EPUB — the format RliBook sends almost always
 *  — is application/epub+zip. Unknown extensions fall back to
 *  application/octet-stream. */
export const SMTP2GO_MIME_BY_EXT = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function smtp2goMimeFor(filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return SMTP2GO_MIME_BY_EXT[ext] || "application/octet-stream";
}

/** Build the SMTP2GO request body (round 4) from the Resend-shaped
 *  message: sender is the bare address, `to` is a plain string
 *  array, the body is text_body + html_body, and attachments are
 *  { filename, fileblob (base64), mimetype }. */
export function buildSmtp2goRequest(message, senderEmail) {
  return {
    sender: senderEmail,
    to: message.to || [],
    subject: message.subject,
    text_body: message.text || "",
    html_body: message.html,
    attachments: (message.attachments || []).map((a) => ({
      filename: a.filename,
      fileblob: a.content,
      mimetype: smtp2goMimeFor(a.filename),
    })),
  };
}

/** One provider POST. Returns the outcome without throwing: a
 *  non-2xx status keeps the provider's error message, a thrown
 *  fetch keeps the throw's message. `status` is present when the
 *  provider answered (so callers can tell a 429 rate-limit from any
 *  other failure). `data` is the parsed JSON body (or null) — the
 *  SMTP2GO step needs it to read data.succeeded / data.email_id. */
async function postProvider(url, headers, body, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.ok) {
      let data = null;
      let messageId = "";
      try {
        data = await res.json();
        // Resend: { id }; Brevo: { messageId }; SMTP2GO:
        // { data: { email_id } }.
        messageId =
          (data && (data.id || data.messageId)) ||
          (data && data.data && data.data.email_id) ||
          "";
      } catch {
        // No JSON body — still a success.
      }
      return { ok: true, status: res.status, messageId, data };
    }
    let detail = "HTTP " + res.status;
    let data = null;
    try {
      data = await res.json();
      const msg = (data && data.error && data.error.message) || (data && data.message);
      if (msg) detail = msg;
    } catch {
      // Keep the HTTP-status detail.
    }
    return { ok: false, status: res.status, detail, data };
  } catch (e) {
    return { ok: false, detail: (e && e.message) || String(e) };
  }
}

/** Send one email: Resend first, Brevo on any Resend failure,
 *  SMTP2GO on any Brevo failure, queue for tomorrow when all three
 *  providers are rate-limited.
 *
 *  opts: {
 *    resendApiKey, brevoApiKey, smtp2goApiKey: strings (any may be
 *      empty; at least one must be set),
 *    resendApiUrl: Resend endpoint (default https://api.resend.com/emails),
 *    fetchImpl: fetch (defaults to the global fetch),
 *    message: the Resend-shaped message (see buildBrevoRequest),
 *    senderEmail: the Brevo/SMTP2GO sender address (default send@rlibook.tech),
 *    queue: optional { enqueue(payload): Promise<boolean> },
 *    queuePayload: what to enqueue (defaults to the message),
 *  }
 *  Returns { ok: true, messageId, provider: "resend"|"brevo"|"smtp2go" }
 *  or { ok: false, code, message?, queued? } with codes E_NO_API_KEY,
 *  E_SEND_FAILED, E_QUEUED (queued:true), E_BOTH_EXHAUSTED. */
export async function sendEmailWithFallback(opts) {
  const resendKey = (opts.resendApiKey || "").trim();
  const brevoKey = (opts.brevoApiKey || "").trim();
  const smtp2goKey = (opts.smtp2goApiKey || "").trim();
  const fetchImpl = opts.fetchImpl || fetch;
  const resendUrl = opts.resendApiUrl || "https://api.resend.com/emails";
  const senderEmail = opts.senderEmail || "send@rlibook.tech";
  if (!resendKey && !brevoKey && !smtp2goKey) {
    return { ok: false, code: "E_NO_API_KEY", message: "RESEND_API_KEY not configured" };
  }
  // Every provider that was tried, in order — the failure handling
  // below only looks at this list, so adding a provider is one step.
  const attempts = [];
  // Resend first (primary). Any failure falls through to Brevo.
  if (resendKey) {
    const resendAttempt = await postProvider(
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
    attempts.push({ provider: "Resend", attempt: resendAttempt });
  }
  // Brevo fallback (300/day). Same sender, same message — and the
  // same mandatory User-Agent header on every send.
  if (brevoKey) {
    const brevoAttempt = await postProvider(
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
    attempts.push({ provider: "Brevo", attempt: brevoAttempt });
  }
  // SMTP2GO fallback (round 4, 200/day). Same sender (bare address),
  // same message — and the same mandatory User-Agent header.
  if (smtp2goKey) {
    let smtp2goAttempt = await postProvider(
      SMTP2GO_API_URL,
      {
        "X-Smtp2go-Api-Key": smtp2goKey,
        "Content-Type": "application/json",
        "User-Agent": EMAIL_USER_AGENT,
      },
      buildSmtp2goRequest(opts.message, senderEmail),
      fetchImpl,
    );
    if (smtp2goAttempt.ok) {
      // SMTP2GO answers 200 with { data: { succeeded, failed,
      // failures, email_id } } — a 200 with succeeded === 0 means
      // no recipient accepted the mail, so it is a failure, not a
      // success. (When the shape is unexpected, a 2xx still counts
      // as a success — the provider accepted the request.)
      const d = smtp2goAttempt.data && smtp2goAttempt.data.data;
      if (d && typeof d.succeeded === "number" && d.succeeded === 0) {
        const f = Array.isArray(d.failures) && d.failures[0];
        smtp2goAttempt = {
          ok: false,
          status: smtp2goAttempt.status,
          detail: (f && (f.error || String(f))) || "SMTP2GO accepted 0 recipients",
          data: smtp2goAttempt.data,
        };
      } else {
        return { ok: true, messageId: smtp2goAttempt.messageId || "", provider: "smtp2go" };
      }
    }
    attempts.push({ provider: "SMTP2GO", attempt: smtp2goAttempt });
  }
  // Only one provider was configured — keep the old single-provider
  // failure shape (E_SEND_FAILED + that provider's message).
  if (attempts.length === 1) {
    return { ok: false, code: "E_SEND_FAILED", message: attempts[0].attempt.detail };
  }
  // Two or three providers were tried and all failed.
  const rateLimited = attempts.some((a) => a.attempt && a.attempt.status === 429);
  if (rateLimited) {
    // All caps hit (combined 600/day) — queue for tomorrow when a
    // queue was given, so the email is never silently dropped.
    if (opts.queue) {
      try {
        if (await opts.queue.enqueue(opts.queuePayload !== undefined ? opts.queuePayload : opts.message)) {
          return {
            ok: false,
            code: "E_QUEUED",
            queued: true,
            message: "All email providers are at their daily limit — queued for tomorrow",
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
        "All email providers are at their daily limit (Resend 100/day, Brevo 300/day, SMTP2GO 200/day) — try again tomorrow",
    };
  }
  // All failed for a non-capacity reason (e.g. an unverified
  // domain on any side) — queueing would not help tomorrow.
  const detail = attempts
    .map((a) => (a.attempt && a.attempt.detail ? a.provider + ": " + a.attempt.detail : ""))
    .filter(Boolean)
    .join("; ");
  return { ok: false, code: "E_SEND_FAILED", message: detail || "All email providers failed" };
}
