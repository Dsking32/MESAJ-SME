import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { cleanAndSortNumbers } from "@/lib/numbers";
import { sendCampaignAcrossCarriers, type CarrierBatchInput, batchStatusFromResult } from "@/lib/mesajClient";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { getSegmentInfo } from "@/lib/smsSegments";
import { loadCarrierOverrides } from "@/lib/portedNumbers";
import { checkContentLength, checkRecipientCount, MAX_MESSAGE_SEGMENTS } from "@/lib/limits";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { recordMessageRecipients } from "@/lib/messageRecipients";
import { handleCampaignSendFailure } from "@/lib/campaignSendFailure";

/**
 * POST /api/admin/tenants/[id]/campaigns/send
 * Body: { senderId: string, message: string, numbers: string[] }
 *
 * Admin composes AND sends in one step — unlike the client flow
 * (/api/campaigns/submit -> pending -> /api/admin/campaigns/approve),
 * there's no separate approval step here since admin is both the author
 * and the approver. Still goes through full number validation and
 * carrier-split sending exactly like the client flow, and still deducts
 * the client's wallet for what's actually sent (so admin-sent campaigns
 * are billed the same as client-sent ones — flag this to the client if
 * that's not the intended behavior for admin-initiated sends).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const sizeError = checkContentLength(req);
  if (sizeError) {
    return NextResponse.json({ error: sizeError }, { status: 413 });
  }

  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-campaign-send:${admin.id}`,
    RATE_LIMITS.ADMIN_SEND.limit,
    RATE_LIMITS.ADMIN_SEND.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id: tenantId } = await params;
  const { senderId, message, numbers } = await req.json();

  if (!senderId || !message || !Array.isArray(numbers)) {
    return NextResponse.json({ error: "senderId, message, and numbers are required" }, { status: 400 });
  }
  const segmentInfo = getSegmentInfo(message);
  if (segmentInfo.segments > MAX_MESSAGE_SEGMENTS) {
    return NextResponse.json(
      {
        error: `Message is too long: ${segmentInfo.segments} SMS segments (${segmentInfo.encoding} encoding). Max is ${MAX_MESSAGE_SEGMENTS} segments.`,
      },
      { status: 400 }
    );
  }
  const countError = checkRecipientCount(numbers);
  if (countError) {
    return NextResponse.json({ error: countError }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const senderIdRecord = await prisma.senderId.findFirst({
    where: { id: senderId, tenantId },
    include: { carrierStatuses: true },
  });
  if (!senderIdRecord) {
    return NextResponse.json({ error: "Sender ID not found for this tenant" }, { status: 404 });
  }

  const overrides = await loadCarrierOverrides(numbers);
  const cleaned = cleanAndSortNumbers(numbers, overrides);
  if (cleaned.totalValid === 0) {
    return NextResponse.json({ error: "No valid numbers to send to" }, { status: 400 });
  }

  const estimatedCost = cleaned.totalValid * PRICE_PER_SMS;

  // Build per-carrier batches, same exclusion rule as the client-approval path:
  // only carriers where this Sender ID is APPROVED get sent to. Computed
  // BEFORE reserving funds, so a send with zero valid batches never reserves
  // (and never needs an immediate refund).
  const batches: CarrierBatchInput[] = [];
  for (const cs of senderIdRecord.carrierStatuses) {
    const carrier = cs.carrier;
    const recipients = cleaned.validByCarrier[carrier] ?? [];
    if (cs.status !== "APPROVED" || !cs.approvedShortcode || recipients.length === 0) continue;
    batches.push({ carrier, shortCode: cs.approvedShortcode, recipients });
  }

  if (batches.length === 0) {
    return NextResponse.json(
      { error: "No approved carriers with valid recipients — approve at least one carrier for this Sender ID first." },
      { status: 409 }
    );
  }

  // Reserve atomically before sending (same guarded-update pattern as the
  // client submit flow) so two concurrent admin sends for the same tenant
  // can't both pass a balance check that was read separately from the write.
  const reserved = await prisma.tenant.updateMany({
    where: { id: tenantId, walletBalance: { gte: estimatedCost } },
    data: { walletBalance: { decrement: estimatedCost } },
  });
  if (reserved.count === 0) {
    return NextResponse.json(
      { error: `Insufficient wallet balance. Needs ~₦${estimatedCost}, has ₦${tenant.walletBalance}.` },
      { status: 402 }
    );
  }
  await prisma.walletTransaction.create({
    data: { tenantId, type: "SPEND", amount: estimatedCost, units: -cleaned.totalValid },
  });

  const campaign = await prisma.campaign.create({
    data: {
      tenantId,
      senderIdId: senderId,
      messageBody: message,
      recipientCount: cleaned.totalValid,
      invalidCount: cleaned.totalInvalid,
      validatedNumbersJson: JSON.stringify(cleaned.validByCarrier),
      status: "APPROVED",
      reviewedByAdminId: admin.id,
      approvedAt: new Date(),
    },
  });

  let sendResults;
  try {
    sendResults = await sendCampaignAcrossCarriers(message, batches);
  } catch (err) {
    // Same recovery as the client-approval path — campaign was already
    // created as APPROVED and funds already reserved above, so a throw
    // here means zero messages went out. Mark FAILED and refund in full
    // rather than leaving the campaign stuck and the tenant short.
    await handleCampaignSendFailure({
      campaignId: campaign.id,
      tenantId,
      recipientCount: cleaned.totalValid,
      error: err,
    });
    return NextResponse.json(
      { error: "Send failed before reaching Mesaj — campaign marked FAILED and funds refunded in full." },
      { status: 502 }
    );
  }

  let totalSent = 0;
  for (const r of sendResults) {
    const carrierBatch = await prisma.campaignCarrierBatch.create({
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
    await recordMessageRecipients({
      campaignId: campaign.id,
      carrierBatchId: carrierBatch.id,
      tenantId,
      carrier: r.carrier,
      shortCode: r.shortCode,
      recipientResults: r.result.recipientResults,
    });
    totalSent += r.result.sentRecipients.length;
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: totalSent > 0 ? "SENT" : "FAILED" },
  });

  const actualCost = totalSent * PRICE_PER_SMS;
  const refund = estimatedCost - actualCost;
  if (refund > 0) {
    await prisma.tenant.update({ where: { id: tenantId }, data: { walletBalance: { increment: refund } } });
    await prisma.walletTransaction.create({
      data: { tenantId, type: "REFUND", amount: refund, units: refund / PRICE_PER_SMS },
    });
  }

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "ADMIN_CAMPAIGN_SEND",
      targetType: "Campaign",
      targetId: campaign.id,
      notes: `Admin-initiated send: ${totalSent} messages across ${batches.length} carrier(s)`,
    },
  });

  return NextResponse.json({ status: totalSent > 0 ? "SENT" : "FAILED", totalSent, validatedCounts: cleaned, sendResults });
}
