import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { notifyReportReady } from "@/lib/notifications";

/**
 * POST /api/admin/campaigns/[id]/approve-report
 *
 * Gates client visibility of a campaign's per-MSISDN delivery report.
 * Delivery webhooks populate MessageRecipient.deliveryStatus as they
 * arrive from Mesaj (often trickling in over minutes/hours), but the
 * client never sees any of it on their dashboard until an admin reviews
 * the aggregate outcome here and explicitly approves — same shape as the
 * existing message-content approval gate on Campaign, just for the report
 * instead of the send.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-report-approve:${admin.id}`,
    RATE_LIMITS.ADMIN_SEND.limit,
    RATE_LIMITS.ADMIN_SEND.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id: campaignId } = await params;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { tenant: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.status !== "SENT") {
    return NextResponse.json(
      { error: `Campaign hasn't been sent yet (status: ${campaign.status}) — nothing to report on.` },
      { status: 409 }
    );
  }
  if (campaign.reportApprovedAt) {
    return NextResponse.json({ error: "Report was already approved" }, { status: 409 });
  }

  const [deliveredCount, recipientTotal] = await Promise.all([
    prisma.messageRecipient.count({ where: { campaignId, deliveryStatus: "DELIVERED" } }),
    prisma.messageRecipient.count({ where: { campaignId } }),
  ]);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { reportApprovedAt: new Date(), reportApprovedByAdminId: admin.id },
  });

  await notifyReportReady({
    to: campaign.tenant.contactEmail,
    businessName: campaign.tenant.businessName,
    messageBody: campaign.messageBody,
    recipientCount: recipientTotal,
    deliveredCount,
    campaignId: campaign.id,
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
  });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "CAMPAIGN_REPORT_APPROVE",
      targetType: "Campaign",
      targetId: campaign.id,
      notes: `Delivery report approved for client visibility: ${deliveredCount}/${recipientTotal} delivered`,
    },
  });

  return NextResponse.json({ approved: true, deliveredCount, recipientTotal });
}
