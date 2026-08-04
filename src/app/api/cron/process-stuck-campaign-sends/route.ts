import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyInternalSecret } from "@/lib/internalAuth";
import { processNextCampaignBatch } from "@/lib/campaignSendProcessor";

// A normal send chain finishes in seconds to low minutes (a handful of
// carriers, each one short hop). Anything still APPROVED-but-not-SENT
// past this threshold almost certainly means its chain broke somewhere
// (a deploy landing mid-chain, a crashed invocation, triggerNextBatch's
// fetch failing) rather than genuinely still being in progress — so it's
// safe to treat as stalled and resume.
const STALLED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// Bounds how much work one sweep takes on, so the sweep itself can't run
// long enough to hit its own function timeout on a bad day with many
// stalled campaigns at once. Any leftover stalled campaigns just get
// picked up on the next sweep.
const MAX_CAMPAIGNS_PER_SWEEP = 20;

/**
 * GET /api/cron/process-stuck-campaign-sends
 * Auth: Authorization: Bearer <CRON_SECRET> — sent automatically by
 * Vercel's cron dispatcher (see lib/internalAuth.ts), or manually for
 * local testing.
 *
 * GET, not POST: Vercel's cron dispatcher always sends a GET request,
 * regardless of what the underlying work does — this is a Vercel Cron
 * requirement, not a REST-semantics choice.
 *
 * Registered in vercel.json. On the Hobby plan Vercel Cron can only run
 * once a day — that's fine here, since this is a safety net for a
 * chain that broke, not the primary send mechanism (that's the
 * near-instant after()-triggered chain in the approve route and the
 * internal continuation route). A stalled campaign recovering within a
 * day is a large improvement over today's behavior, where it would stay
 * stuck forever until someone noticed.
 */
export async function GET(req: NextRequest) {
  const authError = verifyInternalSecret(req);
  if (authError) return authError;

  const stalled = await prisma.campaign.findMany({
    where: {
      status: "APPROVED",
      approvedAt: { lt: new Date(Date.now() - STALLED_THRESHOLD_MS) },
    },
    select: { id: true },
    take: MAX_CAMPAIGNS_PER_SWEEP,
  });

  // Scheduled via after() rather than awaited in a loop here, so this
  // route itself responds quickly regardless of how long the resumed
  // sends take — the actual resumption work happens the same way any
  // other hop does.
  after(async () => {
    for (const campaign of stalled) {
      await processNextCampaignBatch(campaign.id);
    }
  });

  return NextResponse.json({ stalledCampaignsFound: stalled.length });
}
