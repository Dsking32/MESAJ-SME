import { NextRequest, NextResponse } from "next/server";

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

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
