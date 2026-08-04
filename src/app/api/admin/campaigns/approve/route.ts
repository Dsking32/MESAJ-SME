import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { computeEligibleCarrierBatches, processNextCampaignBatch } from "@/lib/campaignSendProcessor";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/admin/campaigns/approve
 * Body: { campaignId: string }
 *
 * Admin-only. Approves a campaign, then hands sending off to a background
 * chain (see lib/campaignSendProcessor.ts) instead of sending
 * synchronously inside this request.
 *
 * Why: the old version looped over every approved carrier and awaited
 * each Mesaj call in this same request — meaning a campaign with several
 * carriers, each with a large recipient list, could take minutes, all
 * inside one HTTP request the admin's browser was blocked on, leaning on
 * Vercel's execution-time limit by design rather than by architecture.
 *
 * Now: this route only validates, atomically claims the campaign as
 * APPROVED, and schedules the first carrier's send via after() — which
 * runs after this response is already sent, so the admin's request
 * returns immediately. That first hop then triggers the next carrier as
 * its own fresh serverless invocation, and so on, until every carrier is
 * done, at which point the campaign is finalized (SENT/FAILED, refund,
 * client notification) — see lib/campaignSendProcessor.ts for the full
 * chain and lib/campaignSendFailure equivalent handling.
 *
 * The response here is now "approved and sending", not "sent" — the
 * admin UI (CampaignQueue.tsx) already only checks res.ok, it doesn't
 * inspect send results, so no further UI change was needed beyond the
 * toast copy.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-campaign-approve:${admin.id}`,
    RATE_LIMITS.ADMIN_SEND.limit,
    RATE_LIMITS.ADMIN_SEND.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { campaignId } = await req.json();
  if (!campaignId) {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { senderId: { include: { carrierStatuses: true } } },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.status !== "PENDING_APPROVAL") {
    return NextResponse.json({ error: `Campaign is not pending approval (status: ${campaign.status})` }, { status: 409 });
  }

  const eligibleBatches = computeEligibleCarrierBatches(campaign);
  if (eligibleBatches.length === 0) {
    return NextResponse.json(
      { error: "No approved carriers with valid recipients to send to" },
      { status: 409 }
    );
  }

  // Mark approved atomically, guarded on current status — same pattern as
  // the wallet reservation fixes. Prevents two concurrent approve requests
  // for the same campaign from both passing the status check and causing a
  // duplicate send chain to start (which would double-charge the client
  // AND send the same messages twice to their customers).
  const claimed = await prisma.campaign.updateMany({
    where: { id: campaign.id, status: "PENDING_APPROVAL" },
    data: {
      status: "APPROVED",
      reviewedByAdminId: admin.id,
      approvedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "Campaign was already processed by another request" }, { status: 409 });
  }

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "CAMPAIGN_APPROVE",
      targetType: "Campaign",
      targetId: campaign.id,
      notes: `Approved, sending across ${eligibleBatches.length} carrier batch(es) in the background`,
    },
  });

  // Kick off the first carrier's send after this response is sent — see
  // the module doc comment above for why this is a chain of separate
  // invocations rather than one long await here.
  after(() => processNextCampaignBatch(campaign.id));

  return NextResponse.json({ status: "APPROVED", sending: true, carrierBatchesQueued: eligibleBatches.length }, { status: 202 });
}
