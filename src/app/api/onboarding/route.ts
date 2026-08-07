import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { onboardingSchema, parseOrError } from "@/lib/validation";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { isUniqueConstraintViolation } from "@/lib/prismaErrors";

/**
 * POST /api/onboarding
 * Body: { businessName: string, cacNumber: string, sector: string, contactPhone: string }
 *
 * Called once, right after a client's first successful login post-signup.
 * Creates the app-level User row (linked to the Supabase auth user) and a
 * new Tenant, then links them. Everything else in the app assumes both
 * exist, so this must run before any dashboard page is reachable.
 *
 * Concurrency: two genuinely concurrent submissions for the same brand-new
 * user could both pass the initial "not already onboarded" check and both
 * reach the point of creating a Tenant. There's no cheap way to reserve
 * the User row *before* a Tenant exists to reserve it for — User.tenantId
 * has a foreign key to Tenant, so it can't hold a placeholder value.
 * Instead of preventing the race, this lets it happen and makes the loser
 * clean up after itself: only one request can win the atomic claim step
 * below (guarded by the User table's unique authUserId constraint, or by
 * tenantId still being null), and the loser deletes the Tenant it just
 * created rather than leaving an orphaned row behind.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser || !authUser.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const rl = await checkRateLimit(
    `onboarding:${authUser.id}`,
    RATE_LIMITS.ONBOARDING.limit,
    RATE_LIMITS.ONBOARDING.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const existing = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (existing?.tenantId) {
    return NextResponse.json({ error: "Onboarding already completed" }, { status: 409 });
  }

  const body = await req.json();
  const parsed = parseOrError(onboardingSchema, body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { businessName, cacNumber, sector, contactPhone } = parsed.data;

  const tenant = await prisma.tenant.create({
    data: {
      businessName,
      cacNumber,
      sector,
      contactEmail: authUser.email,
      contactPhone,
    },
  });

  let user;
  if (existing) {
    // A User row already exists without a tenant — either genuinely mid-
    // race with another request right now, or left behind by a crashed
    // previous attempt. Guarded update: only succeeds if tenantId is
    // still null at the moment this runs.
    const claimed = await prisma.user.updateMany({
      where: { authUserId: authUser.id, tenantId: null },
      data: { tenantId: tenant.id },
    });
    if (claimed.count === 0) {
      // Lost the race — another request already finished claiming this
      // user in between our check above and this update. Our Tenant is
      // an orphan; delete it rather than leave it behind.
      await prisma.tenant.delete({ where: { id: tenant.id } });
      return NextResponse.json({ error: "Onboarding already completed" }, { status: 409 });
    }
    user = await prisma.user.findUniqueOrThrow({ where: { authUserId: authUser.id } });
  } else {
    // No User row yet — the common case. `create` is guarded by the
    // unique constraint on authUserId: if another request's create() won
    // the race a moment earlier, this throws P2002 instead of succeeding.
    try {
      user = await prisma.user.create({
        data: { authUserId: authUser.id, email: authUser.email, role: "CLIENT", tenantId: tenant.id },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        await prisma.tenant.delete({ where: { id: tenant.id } });
        return NextResponse.json({ error: "Onboarding already completed" }, { status: 409 });
      }
      throw err;
    }
  }

  return NextResponse.json({ tenant, user }, { status: 201 });
}
