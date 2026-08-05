import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * Auth for routes that are never hit by a browser — the internal
 * campaign-send continuation route and the recovery cron route. Both are
 * called by the server itself (or by Vercel's cron dispatcher), not by an
 * admin or client session, so this checks a shared bearer secret instead
 * of requireAdminApi()'s session-based check.
 *
 * Deliberately reuses CRON_SECRET for both purposes rather than adding a
 * second secret: Vercel already auto-provisions CRON_SECRET as an env var
 * the moment a `crons` entry exists in vercel.json (see
 * https://vercel.com/docs/cron-jobs), and Vercel's own cron dispatcher
 * sends it as this exact header — so no extra manual setup is needed
 * beyond what shipping any Vercel Cron job already requires. One secret,
 * two trusted-caller routes.
 *
 * For local dev/testing outside Vercel, set CRON_SECRET manually in .env.
 */
export function verifyInternalSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fails closed: an unset secret must never be treated as "any caller
    // is fine" — that would leave these routes wide open in an
    // environment where CRON_SECRET simply hasn't been configured yet.
    return NextResponse.json({ error: "Server not configured for internal requests" }, { status: 503 });
  }

  // Timing-safe comparison — same reasoning as the Paystack webhook's
  // signature check (see /api/wallet/paystack/webhook): a plain `!==`
  // string comparison returns as soon as it finds a mismatched byte,
  // which leaks how many leading characters of the guess were correct via
  // response-time differences. CRON_SECRET is a long-lived bearer secret
  // an attacker gets unlimited guesses against, so it's worth the same
  // care as a webhook signature. timingSafeEqual requires equal-length
  // buffers, so that's checked first — a wrong-length header is just a
  // mismatch, not a crash.
  const authHeader = req.headers.get("authorization") ?? "";
  const expectedHeader = `Bearer ${expected}`;
  const providedBuffer = Buffer.from(authHeader, "utf8");
  const expectedBuffer = Buffer.from(expectedHeader, "utf8");
  const valid =
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);

  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
