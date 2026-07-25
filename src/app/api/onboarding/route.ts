import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { onboardingSchema, parseOrError } from "@/lib/validation";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/onboarding
 * Body: { businessName: string, cacNumber: string, sector: string, contactPhone: string }
 *
 * Called once, right after a client's first successful login post-signup.
 * Creates the app-level User row (linked to the Supabase auth user) and a
 * new Tenant, then links them. Everything else in the app assumes both
 * exist, so this must run before any dashboard page is reachable.
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

  const user = await prisma.user.upsert({
    where: { authUserId: authUser.id },
    create: {
      authUserId: authUser.id,
      email: authUser.email,
      role: "CLIENT",
      tenantId: tenant.id,
    },
    update: { tenantId: tenant.id },
  });

  return NextResponse.json({ tenant, user }, { status: 201 });
}
