import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanAndSortNumbers } from "@/lib/numbers";
import { createClient } from "@/lib/supabase/server";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { getSegmentInfo } from "@/lib/smsSegments";
import { loadCarrierOverrides } from "@/lib/portedNumbers";
import { checkContentLength, checkRecipientCount, MAX_MESSAGE_SEGMENTS } from "@/lib/limits";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/campaigns/submit
 * Body: { senderId: string, message: string, numbers: string[] }
 *
 * Called after the client has seen the exclusion pop-up and clicked "Agree".
 * Re-validates numbers server-side (never trust client-reported counts),
 * checks wallet balance, deducts estimated cost, and creates the campaign
 * in PENDING_APPROVAL for the admin queue.
 *
 * Note: this does NOT call Mesaj yet. Sending only happens after admin
 * approval — see /api/admin/campaigns/approve.
 */
export async function POST(req: NextRequest) {
  const sizeError = checkContentLength(req);
  if (sizeError) {
    return NextResponse.json({ error: sizeError }, { status: 413 });
  }

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user || !user.tenantId) {
    return NextResponse.json({ error: "No tenant associated with this user" }, { status: 400 });
  }

  const rl = await checkRateLimit(
    `campaign-submit:${user.tenantId}`,
    RATE_LIMITS.CAMPAIGN_SUBMIT.limit,
    RATE_LIMITS.CAMPAIGN_SUBMIT.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

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

  const overrides = await loadCarrierOverrides(numbers);
  const cleaned = cleanAndSortNumbers(numbers, overrides);

  if (cleaned.totalValid === 0) {
    return NextResponse.json({ error: "No valid numbers to send to" }, { status: 400 });
  }

  const estimatedCost = cleaned.totalValid * PRICE_PER_SMS;

  // Reserve funds atomically: the balance check and the decrement happen in
  // a single conditional UPDATE (walletBalance >= estimatedCost in the WHERE
  // clause), not as a separate read-then-write. This closes a race where two
  // concurrent submissions could both read a sufficient balance before
  // either had decremented it, letting the wallet go negative. If the
  // guarded update affects zero rows, the balance was insufficient (whether
  // from the start or because a concurrent request got there first) and we
  // roll back and return 402 — no campaign or wallet transaction is created.
  //
  // Unused reservation is refunded at approval time if fewer messages
  // actually send than recipientCount; a full refund happens on rejection.
  // See /api/admin/campaigns/approve and /reject.
  let campaign;
  try {
    campaign = await prisma.$transaction(async (tx) => {
      const senderIdRecord = await tx.senderId.findFirst({
        where: { id: senderId, tenantId: user.tenantId! },
      });
      if (!senderIdRecord) {
        throw new Error("SENDER_ID_NOT_FOUND");
      }

      const reserved = await tx.tenant.updateMany({
        where: { id: user.tenantId!, walletBalance: { gte: estimatedCost } },
        data: { walletBalance: { decrement: estimatedCost } },
      });
      if (reserved.count === 0) {
        throw new Error("INSUFFICIENT_BALANCE");
      }

      const created = await tx.campaign.create({
        data: {
          tenantId: user.tenantId!,
          senderIdId: senderId,
          messageBody: message,
          recipientCount: cleaned.totalValid,
          invalidCount: cleaned.totalInvalid,
          validatedNumbersJson: JSON.stringify(cleaned.validByCarrier),
          status: "PENDING_APPROVAL",
        },
      });

      await tx.walletTransaction.create({
        data: {
          tenantId: user.tenantId!,
          type: "SPEND",
          amount: estimatedCost,
          units: -cleaned.totalValid,
        },
      });

      return created;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "SENDER_ID_NOT_FOUND") {
      return NextResponse.json({ error: "Sender ID not found for this tenant" }, { status: 404 });
    }
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 402 });
    }
    throw err;
  }

  return NextResponse.json({ campaign, validatedCounts: cleaned }, { status: 201 });
}
