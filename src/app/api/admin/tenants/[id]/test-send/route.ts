import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { normalizeNumber } from "@/lib/numbers";
import { sendCarrierBatch } from "@/lib/mesajClient";
import { getSegmentInfo } from "@/lib/smsSegments";
import { MAX_MESSAGE_SEGMENTS } from "@/lib/limits";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/admin/tenants/[id]/test-send
 * Body: { senderIdId: string, testNumber: string, message: string }
 *
 * Lets admin send a one-off test message using a client's Sender ID, to
 * verify the approved shortCode actually works on a real handset before
 * the client relies on it for a real campaign. Does NOT go through the
 * approval queue and does NOT deduct from the client's wallet — this is
 * an operational/QA action, not a billable client send. It IS logged to
 * the admin audit trail.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-test-send:${admin.id}`,
    RATE_LIMITS.ADMIN_SEND.limit,
    RATE_LIMITS.ADMIN_SEND.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id: tenantId } = await params;
  const { senderIdId, testNumber, message } = await req.json();

  if (!senderIdId || !testNumber || !message) {
    return NextResponse.json({ error: "senderIdId, testNumber, and message are required" }, { status: 400 });
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

  const senderId = await prisma.senderId.findFirst({
    where: { id: senderIdId, tenantId },
    include: { carrierStatuses: true },
  });
  if (!senderId) {
    return NextResponse.json({ error: "Sender ID not found for this tenant" }, { status: 404 });
  }

  const normalized = normalizeNumber(testNumber);
  if (!normalized.valid || !normalized.normalized || !normalized.carrier) {
    return NextResponse.json(
      { error: `Test number is invalid: ${normalized.reason ?? "unrecognized format"}` },
      { status: 400 }
    );
  }

  const carrierStatus = senderId.carrierStatuses.find((cs) => cs.carrier === normalized.carrier);
  if (!carrierStatus || carrierStatus.status !== "APPROVED" || !carrierStatus.approvedShortcode) {
    return NextResponse.json(
      {
        error: `Sender ID is not approved on ${normalized.carrier} (the carrier for this test number), so there's no shortCode to test with yet.`,
      },
      { status: 409 }
    );
  }

  const result = await sendCarrierBatch({
    message,
    shortCode: carrierStatus.approvedShortcode,
    recipients: [normalized.normalized],
  });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "TEST_SEND",
      targetType: "Tenant",
      targetId: tenantId,
      notes: `Test to ${normalized.normalized} via ${normalized.carrier} (${carrierStatus.approvedShortcode}): ${
        result.success ? "success" : `failed — ${result.error}`
      }`,
    },
  });

  return NextResponse.json({
    success: result.success,
    carrier: normalized.carrier,
    shortCode: carrierStatus.approvedShortcode,
    error: result.error,
    raw: result.raw,
  });
}
