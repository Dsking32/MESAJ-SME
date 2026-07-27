import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

const CARRIERS = ["MTN", "AIRTEL", "GLO", "MOBILE9"] as const;

/**
 * POST /api/admin/tenants/[id]/sender-id
 * Body: { requestedName: string }
 *
 * Admin-initiated Sender ID assignment — used when admin already knows a
 * Sender ID is (or will be) approved for a client and wants to set it up
 * directly, rather than waiting for the client to submit the KYC request
 * themselves via /dashboard/sender-id. Creates the SenderId with all 4
 * carrier statuses PENDING; admin then approves per carrier (with the
 * approved shortCode) the same way as for client-submitted requests.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-sender-id-assign:${admin.id}`,
    RATE_LIMITS.ADMIN_ACTION.limit,
    RATE_LIMITS.ADMIN_ACTION.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id: tenantId } = await params;
  const { requestedName } = await req.json();

  if (!requestedName || typeof requestedName !== "string") {
    return NextResponse.json({ error: "requestedName is required" }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const senderId = await prisma.senderId.create({
    data: {
      tenantId,
      requestedName,
      carrierStatuses: {
        create: CARRIERS.map((carrier) => ({ carrier, status: "PENDING" as const })),
      },
    },
    include: { carrierStatuses: true },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "SENDER_ID_ADMIN_ASSIGN",
      targetType: "Tenant",
      targetId: tenantId,
      notes: `Assigned Sender ID "${requestedName}"`,
    },
  });

  return NextResponse.json(senderId, { status: 201 });
}
