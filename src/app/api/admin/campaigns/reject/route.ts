import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { notifyCampaignRejected } from "@/lib/notifications";

/**
 * POST /api/admin/campaigns/reject
 * Body: { campaignId: string, reason: string }
 *
 * Admin-only. Rejects a pending campaign and records why, so the client
 * sees the reason on their dashboard. Also emails the client the reason
 * directly (see lib/notifications.ts) — best-effort, never blocks or fails
 * this response if it doesn't send.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-campaign-reject:${admin.id}`,
    RATE_LIMITS.ADMIN_ACTION.limit,
    RATE_LIMITS.ADMIN_ACTION.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { campaignId, reason } = await req.json();
  if (!campaignId || !reason) {
    return NextResponse.json({ error: "campaignId and reason are required" }, { status: 400 });
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { tenant: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.status !== "PENDING_APPROVAL") {
    return NextResponse.json({ error: `Campaign is not pending approval (status: ${campaign.status})` }, { status: 409 });
  }

  const refundAmount = campaign.recipientCount * PRICE_PER_SMS;

  // Atomic guard: only proceeds if the campaign is still PENDING_APPROVAL at
  // the moment of the update, so a concurrent approve can't be undone by a
  // reject arriving a moment later (or vice versa).
  const claimed = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "PENDING_APPROVAL" },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      reviewedByAdminId: admin.id,
    },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "Campaign was already processed by another request" }, { status: 409 });
  }

  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: campaign.tenantId },
      data: { walletBalance: { increment: refundAmount } },
    }),
    prisma.walletTransaction.create({
      data: {
        tenantId: campaign.tenantId,
        type: "REFUND",
        amount: refundAmount,
        units: campaign.recipientCount,
      },
    }),
  ]);

  const updated = await prisma.campaign.findUnique({ where: { id: campaignId } });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "CAMPAIGN_REJECT",
      targetType: "Campaign",
      targetId: campaignId,
      notes: reason,
    },
  });

  await notifyCampaignRejected({
    to: campaign.tenant.contactEmail,
    businessName: campaign.tenant.businessName,
    messageBody: campaign.messageBody,
    reason,
  });

  return NextResponse.json(updated);
}
