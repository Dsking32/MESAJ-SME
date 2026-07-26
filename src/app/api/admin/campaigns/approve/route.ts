import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { sendCampaignAcrossCarriers, type CarrierBatchInput, batchStatusFromResult } from "@/lib/mesajClient";
import type { Carrier } from "@/lib/numbers";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { notifyCampaignSent } from "@/lib/notifications";

/**
 * POST /api/admin/campaigns/approve
 * Body: { campaignId: string }
 *
 * Admin-only. Approves a campaign's message body, then:
 *  1. Loads the validated, carrier-grouped numbers captured at submit time
 *  2. Loads the tenant's Sender ID approval status + approved shortCode per carrier
 *  3. Excludes any carrier the Sender ID isn't approved on (client was already
 *     informed of this via the Sender ID status view)
 *  4. Sends one request per remaining carrier to Mesaj
 *  5. Records each carrier batch's result and deducts the wallet
 *  6. Logs the approval in the admin audit log
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  const admin = authUser
    ? await prisma.user.findUnique({ where: { authUserId: authUser.id } })
    : null;

  if (!admin || admin.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

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
    include: { senderId: { include: { carrierStatuses: true } }, tenant: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.status !== "PENDING_APPROVAL") {
    return NextResponse.json({ error: `Campaign is not pending approval (status: ${campaign.status})` }, { status: 409 });
  }

  const validatedNumbers: Record<Carrier, string[]> = JSON.parse(campaign.validatedNumbersJson);

  // Build per-carrier batches, excluding any carrier the Sender ID isn't
  // approved on — even if the client uploaded numbers for that carrier.
  const batches: CarrierBatchInput[] = [];
  for (const carrierStatus of campaign.senderId.carrierStatuses) {
    const carrier = carrierStatus.carrier;
    const recipients = validatedNumbers[carrier] ?? [];

    if (carrierStatus.status !== "APPROVED" || !carrierStatus.approvedShortcode) {
      continue; // not approved on this carrier — skip entirely
    }
    if (recipients.length === 0) continue;

    batches.push({ carrier, shortCode: carrierStatus.approvedShortcode, recipients });
  }

  if (batches.length === 0) {
    return NextResponse.json(
      { error: "No approved carriers with valid recipients to send to" },
      { status: 409 }
    );
  }

  // Mark approved atomically, guarded on current status — same pattern as
  // the wallet reservation fixes. Prevents two concurrent approve requests
  // for the same campaign from both passing the status check and causing a
  // duplicate send to Mesaj (which would double-charge the client AND send
  // the same message twice to their customers).
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

  const sendResults = await sendCampaignAcrossCarriers(campaign.messageBody, batches);

  let totalSent = 0;
  for (const r of sendResults) {
    await prisma.campaignCarrierBatch.create({
      data: {
        campaignId: campaign.id,
        carrier: r.carrier,
        shortcodeUsed: r.shortCode,
        recipientCount: r.recipientCount,
        mesajResponseStatus: batchStatusFromResult(r.result),
        mesajResponseRaw: JSON.stringify(r.result.raw),
        sentAt: new Date(),
      },
    });
    totalSent += r.result.sentRecipients.length;
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    // Only every carrier batch failing should read as FAILED — a partial
    // send (some recipients got it, some didn't) still counts as SENT
    // overall; the per-carrier breakdown in CampaignCarrierBatch is where
    // that nuance lives.
    data: { status: totalSent > 0 ? "SENT" : "FAILED" },
  });

  if (totalSent === 0) {
    // Every carrier batch failed — nothing reached a recipient despite the
    // campaign being approved with valid, previously-validated numbers.
    // This usually means Mesaj itself is down/erroring, not a one-off bad
    // number, and it's worth someone finding out immediately rather than
    // only when a client complains their campaign never arrived.
    Sentry.captureMessage("Campaign fully failed to send — every carrier batch failed", {
      level: "error",
      extra: {
        campaignId: campaign.id,
        tenantId: campaign.tenantId,
        carriersAttempted: batches.map((b) => b.carrier),
        recipientCount: campaign.recipientCount,
        sendResults: sendResults.map((r) => ({ carrier: r.carrier, error: r.result.error })),
      },
    });
  }

  // Funds for this campaign were already reserved (deducted) at submit time,
  // based on recipientCount. Now that we know how many actually sent
  // successfully, refund the difference if any carrier batch failed.
  const reservedCost = campaign.recipientCount * PRICE_PER_SMS;
  const actualCost = totalSent * PRICE_PER_SMS;
  const refund = reservedCost - actualCost;

  if (refund > 0) {
    await prisma.tenant.update({
      where: { id: campaign.tenantId },
      data: { walletBalance: { increment: refund } },
    });
    await prisma.walletTransaction.create({
      data: {
        tenantId: campaign.tenantId,
        type: "REFUND",
        amount: refund,
        units: refund / PRICE_PER_SMS,
      },
    });
  }

  await notifyCampaignSent({
    to: campaign.tenant.contactEmail,
    businessName: campaign.tenant.businessName,
    messageBody: campaign.messageBody,
    recipientCount: campaign.recipientCount,
    totalSent,
    refundedAmount: refund > 0 ? refund : 0,
  });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "CAMPAIGN_APPROVE",
      targetType: "Campaign",
      targetId: campaign.id,
      notes: `Sent to ${batches.length} carrier batch(es), ${totalSent} messages sent`,
    },
  });

  return NextResponse.json({ status: totalSent > 0 ? "SENT" : "FAILED", totalSent, sendResults });
}
