import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

const VALID_ROLES = ["CLIENT", "ADMIN"] as const;

/**
 * PATCH /api/admin/users/[id]/role
 * Body: { role: "CLIENT" | "ADMIN" }
 *
 * Promotes or demotes a user's role. This is the UI-driven replacement for
 * hand-editing `role` in the database directly (see README's previously
 * documented gap: "no role: ADMIN assignment UI").
 *
 * Two guardrails beyond the standard admin check:
 *  - An admin can't change their own role here. Self-demotion by accident
 *    (fat-fingering the wrong row) would be an easy way to lock yourself
 *    out with no UI path back in.
 *  - The last remaining ADMIN in the system can't be demoted. Without this,
 *    it's possible to demote every admin down to zero and end up with no
 *    account able to reach /admin at all — recoverable only by going back
 *    to the database directly, i.e. reintroducing the exact gap this
 *    feature exists to close.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  const admin = authUser
    ? await prisma.user.findUnique({ where: { authUserId: authUser.id } })
    : null;

  if (!admin || admin.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const rl = await checkRateLimit(
    `admin-user-role:${admin.id}`,
    RATE_LIMITS.ADMIN_ACTION.limit,
    RATE_LIMITS.ADMIN_ACTION.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id: targetUserId } = await params;
  const { role } = await req.json();

  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }, { status: 400 });
  }

  if (targetUserId === admin.id) {
    return NextResponse.json(
      { error: "You can't change your own role — have another admin do it if this is intentional." },
      { status: 400 }
    );
  }

  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (targetUser.role === "ADMIN" && role === "CLIENT") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Can't demote the last remaining admin — promote someone else first." },
        { status: 409 }
      );
    }
  }

  if (targetUser.role === role) {
    return NextResponse.json({ error: `User already has role ${role}` }, { status: 409 });
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: { role },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      actionType: "USER_ROLE_UPDATE",
      targetType: "User",
      targetId: targetUserId,
      notes: `${targetUser.email}: ${targetUser.role} -> ${role}`,
    },
  });

  return NextResponse.json({ id: updated.id, email: updated.email, role: updated.role });
}
