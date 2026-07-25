/**
 * Minimal Resend REST API client for transactional email.
 *
 * Raw fetch rather than the `resend` SDK — this project already talks to
 * Mesaj's API the same way (see lib/mesajClient.ts) instead of pulling in a
 * client library for what's fundamentally one POST endpoint. Keeps the
 * dependency list smaller for a single HTTP call.
 *
 * Every notification sent through this file is a side effect of some other
 * admin action (Sender ID status change, campaign rejection) — never
 * something that should fail the actual action over. Callers should treat
 * the return value as informational, not something to throw on.
 */

const RESEND_API_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  success: boolean;
  error?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    // Not configured — this is a known, startup-warned-about gap (see
    // lib/env.ts RECOMMENDED_VARS), not a failure worth raising loudly on
    // every action that tries to notify. No-op so local dev without email
    // configured still works end to end; the caller's action still
    // succeeds either way.
    return { success: false, error: "Email not configured (RESEND_API_KEY/EMAIL_FROM missing)" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = `Resend API returned ${response.status}${body ? `: ${body}` : ""}`;
      // eslint-disable-next-line no-console
      console.error(`[email] ${error}`);
      return { success: false, error };
    }

    return { success: true };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const error = isAbort
      ? `Resend API request timed out after ${REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : "Unknown error sending email";
    // eslint-disable-next-line no-console
    console.error(`[email] ${error}`);
    return { success: false, error };
  } finally {
    clearTimeout(timeoutId);
  }
}
