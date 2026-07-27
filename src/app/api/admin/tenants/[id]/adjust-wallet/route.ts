import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/admin/tenants/[id]/adjust-wallet
 * Body: { amount: number, note?: string }
 *
 * Admin manually credits (positive amount) or debits (negative amount) a
 * tenant's wallet — for bank transfer top-ups, goodwill credit, or
 * corrections. This is the "manual" funding path alongside Paystack's
 * automatic one (see /api/wallet/paystack/webhook).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-adjust-wallet:${admin.id}`,
    RATE_LIMITS.ADMIN_SEND.limit,
    RATE_LIMITS.ADMIN_SEND.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id: tenantId } = await params;
  const { amount, note } = await req.json();

  if (typeof amount !== "number" || amount === 0) {
    return NextResponse.json({ error: "amount must be a non-zero number" }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  let updatedTenant;
  try {
    updatedTenant = await prisma.$transaction(async (tx) => {
      if (amount < 0) {
        // Debit: atomic guarded update so a concurrent debit can't push the
        // balance below zero (same race pattern as campaign submission).
        const result = await tx.tenant.updateMany({
          where: { id: tenantId, walletBalance: { gte: -amount } },
          data: { walletBalance: { increment: amount } },
        });
        if (result.count === 0) {
          throw new Error("INSUFFICIENT_BALANCE");
        }
      } else {
        // Credit: no floor risk, plain increment is fine.
        await tx.tenant.update({
          where: { id: tenantId },
          data: { walletBalance: { increment: amount } },
        });
      }

      await tx.walletTransaction.create({
        data: {
          tenantId,
          type: "MANUAL_ADJUST",
          amount,
          units: Math.round(amount / PRICE_PER_SMS), // SMS-unit equivalent, not a mirror of the naira amount
          createdByAdminId: admin.id,
        },
      });

      await tx.adminAuditLog.create({
        data: {
          adminId: admin.id,
          actionType: "WALLET_MANUAL_ADJUST",
          targetType: "Tenant",
          targetId: tenantId,
          notes: `${amount > 0 ? "+" : ""}₦${amount}${note ? ` — ${note}` : ""}`,
        },
      });

      return tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      return NextResponse.json({ error: "Adjustment would take wallet balance below zero" }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json(updatedTenant);
}
