import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { notifySenderIdStatusChange } from "@/lib/notifications";

/**
 * POST /api/admin/sender-id/update-status
 * Body: { senderIdId: string, carrier: "MTN"|"AIRTEL"|"GLO"|"MOBILE9",
 *         status: "APPROVED"|"REJECTED"|"PENDING", approvedShortcode?: string }
 *
 * Admin-only, manual entry — there's no automated telco/Mesaj feed for
 * Sender ID status in v1 (a webhook reportedly exists but isn't wired up
 * yet). Admin checks approval status directly with the telco/Mesaj and
 * records it here, along with the exact approved shortCode string, since
 * carriers can approve slightly different formats (e.g. MTN "VNGI" vs
 * Glo "VNGIS").
 *
 * Emails the client on every status change (see lib/notifications.ts) —
 * best-effort, never blocks or fails this response if it doesn't send.
 *
 * TODO(v1.1): replace manual entry with Mesaj's status webhook once its
 * payload/auth is understood — this is the top automation candidate.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-sender-id-status:${admin.id}`,
    RATE_LIMITS.ADMIN_ACTION.limit,
    RATE_LIMITS.ADMIN_ACTION.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { senderIdId, carrier, status, approvedShortcode } = await req.json();
  if (!senderIdId || !carrier || !status) {
    return NextResponse.json({ error: "senderIdId, carrier, and status are required" }, { status: 400 });
  }
  if (status === "APPROVED" && !approvedShortcode) {
    return NextResponse.json({ error: "approvedShortcode is required when status is APPROVED" }, { status: 400 });
  }

  const updated = await prisma.senderIdCarrierStatus.update({
    where: { senderIdId_carrier: { senderIdId, carrier } },
    data: { status, approvedShortcode: status === "APPROVED" ? approvedShortcode : null },
    include: { senderId: { include: { tenant: true } } },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "SENDER_ID_STATUS_UPDATE",
      targetType: "SenderId",
      targetId: senderIdId,
      notes: `${carrier} -> ${status}${approvedShortcode ? ` (${approvedShortcode})` : ""}`,
    },
  });

  await notifySenderIdStatusChange({
    to: updated.senderId.tenant.contactEmail,
    businessName: updated.senderId.tenant.businessName,
    requestedName: updated.senderId.requestedName,
    carrier: updated.carrier,
    status: updated.status,
    approvedShortcode: updated.approvedShortcode,
  });

  return NextResponse.json(updated);
}
