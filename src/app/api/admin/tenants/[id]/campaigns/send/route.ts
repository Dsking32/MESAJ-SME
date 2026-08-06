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
import { isUniqueConstraintViolation } from "@/lib/prismaErrors";

/**
 * POST /api/admin/tenants/[id]/campaigns/send
 * Body: { senderId: string, message: string, numbers: string[] }
 * Optional header: Idempotency-Key: <admin-generated string>
 *
 * Admin composes AND sends in one step — unlike the client flow
 * (/api/campaigns/submit -> pending -> /api/admin/campaigns/approve),
 * there's no separate approval step here since admin is both the author
 * and the approver. Still goes through full number validation and
 * carrier-split sending exactly like the client flow, and still deducts
 * the client's wallet for what's actually sent (so admin-sent campaigns
 * are billed the same as client-sent ones — flag this to the client if
 * that's not the intended behavior for admin-initiated sends).
 *
 * Idempotency: unlike the client submit flow, this route sends
 * immediately rather than staging for approval — so a double-click or a
 * dropped-response retry here doesn't just risk a duplicate DB row, it
 * risks a duplicate real SMS send billed twice. Reuses the same
 * (tenantId, idempotencyKey) unique constraint and pattern as
 * /api/campaigns/submit: a repeat of the same key returns the original
 * outcome instead of composing and sending again.
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
  const rawIdempotencyKey = req.headers.get("idempotency-key");
  const idempotencyKey = rawIdempotencyKey?.trim() ? rawIdempotencyKey.trim() : null;

  // Early-exit path for the common (non-concurrent) retry case: if this
  // exact (tenant, key) pair already produced a campaign, don't re-validate
  // numbers or touch the wallet again — just report the outcome. The DB
  // unique constraint (checked again below) is what actually prevents a
  // double-send if two requests with the same key land at the same time;
  // this is purely an optimization to skip the expensive path for a plain
  // retry.
  if (idempotencyKey) {
    const existing = await prisma.campaign.findFirst({ where: { tenantId, idempotencyKey } });
    if (existing) {
      return idempotentAdminSendResponse(existing);
    }
  }

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

  // Reserve funds and create the campaign atomically (same guarded-update
  // pattern as the client submit flow, plus the idempotencyKey so the DB's
  // unique (tenantId, idempotencyKey) constraint is what actually stops a
  // true concurrent double-send — the early-exit check above only handles
  // the common non-concurrent retry case).
  let campaign;
  try {
    campaign = await prisma.$transaction(async (tx) => {
      const reserved = await tx.tenant.updateMany({
        where: { id: tenantId, walletBalance: { gte: estimatedCost } },
        data: { walletBalance: { decrement: estimatedCost } },
      });
      if (reserved.count === 0) {
        throw new Error("INSUFFICIENT_BALANCE");
      }
      await tx.walletTransaction.create({
        data: { tenantId, type: "SPEND", amount: estimatedCost, units: -cleaned.totalValid },
      });
      return tx.campaign.create({
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
          idempotencyKey,
        },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      return NextResponse.json(
        { error: `Insufficient wallet balance. Needs ~₦${estimatedCost}, has ₦${tenant.walletBalance}.` },
        { status: 402 }
      );
    }
    // A concurrent request with the same idempotency key won the race and
    // committed first — this transaction (including its wallet decrement)
    // rolled back automatically, so nothing to undo here. Hand back the
    // winner's outcome, same as the early-exit check above would for a
    // later retry.
    if (idempotencyKey && isUniqueConstraintViolation(err)) {
      const existing = await prisma.campaign.findFirst({ where: { tenantId, idempotencyKey } });
      if (existing) {
        return idempotentAdminSendResponse(existing);
      }
    }
    throw err;
  }

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

/**
 * Response for a repeat request carrying an Idempotency-Key that's already
 * been used for a campaign on this tenant — either the fast-path check
 * before any work starts, or the unique-constraint-violation path after
 * losing a genuine concurrent race.
 *
 * Can't reconstruct the exact original response shape (sendResults isn't
 * persisted in raw form), so this reports the campaign's current actual
 * state instead — sufficient to confirm nothing needs to be sent again,
 * which is the guarantee that actually matters here.
 *
 * If the matched campaign is still APPROVED, the original request that
 * created it hasn't reached a terminal outcome yet — either it's still
 * genuinely in flight (a real concurrent request, mid-send right now), or
 * it crashed between creating the campaign and marking it SENT/FAILED.
 * Either way, fabricating a totalSent here would be a guess; 202 telling
 * the caller to check back is the honest answer.
 */
async function idempotentAdminSendResponse(campaign: { id: string; status: string; recipientCount: number }) {
  if (campaign.status === "APPROVED") {
    return NextResponse.json(
      {
        status: "IN_PROGRESS",
        campaignId: campaign.id,
        message: "A send with this idempotency key is already in progress or did not reach a terminal state — check back shortly rather than retrying.",
      },
      { status: 202 }
    );
  }

  const totalSent = await prisma.messageRecipient.count({
    where: { campaignId: campaign.id, gatewayAccepted: true },
  });

  return NextResponse.json({
    status: campaign.status,
    campaignId: campaign.id,
    totalSent,
    recipientCount: campaign.recipientCount,
    replay: true,
  });
}
