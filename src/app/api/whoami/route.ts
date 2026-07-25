import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/whoami
 * Returns the current session's role (CLIENT/ADMIN) and whether onboarding
 * (Tenant creation) is complete. Used right after login to decide whether
 * to route to /admin or /dashboard (or /onboarding for a first-time client).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return NextResponse.json({ role: null, onboarded: false }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });

  return NextResponse.json({
    role: user?.role ?? null,
    onboarded: Boolean(user?.tenantId),
  });
}
