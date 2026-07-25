import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { senderIdRequestSchema, parseOrError } from "@/lib/validation";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

const CARRIERS = ["MTN", "AIRTEL", "GLO", "MOBILE9"] as const;

/**
 * POST /api/sender-id/request
 * Body: { requestedName: string, businessName: string, cacNumber: string, sector: string }
 *
 * Creates a Sender ID request plus a PENDING carrier-status row for each of
 * the 4 telcos. Admin updates each one manually as approvals come back
 * (see /api/admin/sender-id/update-status) — there's no automated telco
 * feed for this in v1.
 */
export async function POST(req: NextRequest) {
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
    `sender-id-request:${user.tenantId}`,
    RATE_LIMITS.SENDER_ID_REQUEST.limit,
    RATE_LIMITS.SENDER_ID_REQUEST.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await req.json();
  const parsed = parseOrError(senderIdRequestSchema, body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { requestedName, businessName, cacNumber, sector } = parsed.data;

  // Keep the tenant's KYC fields current with what was submitted.
  await prisma.tenant.update({
    where: { id: user.tenantId },
    data: { businessName, cacNumber, sector },
  });

  const senderId = await prisma.senderId.create({
    data: {
      tenantId: user.tenantId,
      requestedName,
      carrierStatuses: {
        create: CARRIERS.map((carrier) => ({ carrier, status: "PENDING" as const })),
      },
    },
    include: { carrierStatuses: true },
  });

  return NextResponse.json(senderId, { status: 201 });
}
