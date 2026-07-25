import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return null;
  const admin = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  return admin?.role === "ADMIN" ? admin : null;
}

/**
 * GET /api/admin/tenants/[id]
 * Full detail view of a tenant: profile, sender IDs + carrier statuses,
 * recent campaigns, recent wallet transactions.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const { id } = await params;

  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: {
      senderIds: { include: { carrierStatuses: true }, orderBy: { createdAt: "desc" } },
      campaigns: { orderBy: { createdAt: "desc" }, take: 10 },
      walletTransactions: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  return NextResponse.json(tenant);
}

/**
 * PATCH /api/admin/tenants/[id]
 * Body: any subset of { businessName, cacNumber, sector, contactEmail, contactPhone }
 * Admin edits a client's business/KYC details.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const rl = await checkRateLimit(
    `admin-tenant-update:${admin.id}`,
    RATE_LIMITS.ADMIN_ACTION.limit,
    RATE_LIMITS.ADMIN_ACTION.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const body = await req.json();

  const allowedFields = ["businessName", "cacNumber", "sector", "contactEmail", "contactPhone"] as const;
  const data: Record<string, string> = {};
  for (const field of allowedFields) {
    if (typeof body[field] === "string") data[field] = body[field];
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const updated = await prisma.tenant.update({ where: { id }, data });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "TENANT_UPDATE",
      targetType: "Tenant",
      targetId: id,
      notes: `Updated fields: ${Object.keys(data).join(", ")}`,
    },
  });

  return NextResponse.json(updated);
}
