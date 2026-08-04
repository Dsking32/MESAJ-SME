import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { verifyInternalSecret } from "@/lib/internalAuth";
import { processNextCampaignBatch } from "@/lib/campaignSendProcessor";

/**
 * POST /api/internal/campaigns/process-send
 * Body: { campaignId: string }
 * Auth: Authorization: Bearer <CRON_SECRET> — see lib/internalAuth.ts
 *
 * One hop in a campaign's send chain. Never called by a browser — only by
 * the approve route's first hop, by this route's own next hop, or by the
 * recovery cron resuming a stalled campaign. Responds as soon as the work
 * is scheduled (via after()), not once the carrier's send has actually
 * finished — the caller (triggerNextBatch in campaignSendProcessor.ts)
 * only needs confirmation this invocation started, not that it's done.
 */
export async function POST(req: NextRequest) {
  const authError = verifyInternalSecret(req);
  if (authError) return authError;

  const { campaignId } = await req.json();
  if (!campaignId) {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }

  after(() => processNextCampaignBatch(campaignId));

  return NextResponse.json({ accepted: true });
}
