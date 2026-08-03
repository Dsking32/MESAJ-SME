import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanAndSortNumbers } from "@/lib/numbers";
import { createClient } from "@/lib/supabase/server";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { getSegmentInfo } from "@/lib/smsSegments";
import { loadCarrierOverrides } from "@/lib/portedNumbers";
import { checkContentLength, checkRecipientCount, MAX_MESSAGE_SEGMENTS } from "@/lib/limits";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { isUniqueConstraintViolation } from "@/lib/prismaErrors";

/**
 * Builds the same response shape POST returns for a freshly created
 * campaign, from an already-existing row — used on both idempotency
 * paths below (early-exit lookup and the post-race refetch) so a client
 * retry gets a response indistinguishable from the original.
 */
function idempotentResponse(campaign: {
  recipientCount: number;
  invalidCount: number;
  validatedNumbersJson: string;
}) {
  return NextResponse.json(
    {
      campaign,
      validatedCounts: {
        totalValid: campaign.recipientCount,
        totalInvalid: campaign.invalidCount,
        validByCarrier: JSON.parse(campaign.validatedNumbersJson),
      },
      idempotent: true,
    },
    { status: 200 }
  );
}

/**
 * POST /api/campaigns/submit
 * Body: { senderId: string, message: string, numbers: string[] }
 * Optional header: Idempotency-Key: <client-generated string>
 *
 * Called after the client has seen the exclusion pop-up and clicked "Agree".
 * Re-validates numbers server-side (never trust client-reported counts),
 * checks wallet balance, deducts estimated cost, and creates the campaign
 * in PENDING_APPROVAL for the admin queue.
 *
 * Idempotency: the rate limiter below stops abuse, but not a legitimate
 * double-click or a client retrying after a dropped response — both send
 * a genuine second POST inside the rate limit window. If the client sends
 * an Idempotency-Key header (recommended: one generated per submit
 * attempt, e.g. regenerated each time the "Agree" button becomes
 * clickable), a repeat of that key returns the original campaign instead
 * of creating a second one and deducting the wallet twice. Enforced at
 * the database level via a unique (tenantId, idempotencyKey) constraint —
 * see prisma/migrations/..._campaign_idempotency_key — not just an
 * in-request check, so two concurrent requests with the same key can't
 * both slip through before either commits.
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

  const rawIdempotencyKey = req.headers.get("idempotency-key");
  const idempotencyKey = rawIdempotencyKey?.trim() ? rawIdempotencyKey.trim() : null;

  // Early-exit path: if this exact (tenant, key) pair already produced a
  // campaign, return it without touching the rate limiter, without
  // re-validating numbers, and without any wallet activity. This is the
  // common case for a retry — the request that already succeeded, not a
  // real race — so it's worth short-circuiting before any of the more
  // expensive work below. The DB-level unique constraint (checked again
  // inside the transaction further down) is what actually prevents a
  // double-charge if two requests with the same key land at the same time;
  // this check is just an optimization for the non-concurrent case.
  if (idempotencyKey) {
    const existing = await prisma.campaign.findFirst({
      where: { tenantId: user.tenantId, idempotencyKey },
    });
    if (existing) {
      return idempotentResponse(existing);
    }
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
          idempotencyKey,
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
    // A concurrent request with the same idempotency key won the race and
    // committed first — the whole transaction above (including this one's
    // wallet decrement) rolled back automatically, so nothing to undo.
    // Fetch the winner's campaign and hand back the same response a retry
    // would get from the early-exit check above.
    if (idempotencyKey && isUniqueConstraintViolation(err)) {
      const existing = await prisma.campaign.findFirst({
        where: { tenantId: user.tenantId, idempotencyKey },
      });
      if (existing) {
        return idempotentResponse(existing);
      }
    }
    throw err;
  }

  return NextResponse.json({ campaign, validatedCounts: cleaned }, { status: 201 });
}
