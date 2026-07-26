import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { computeOpsStats } from "@/lib/stats";

/**
 * GET /api/admin/stats
 * Admin-only. Returns the metrics shown on /admin/stats — kept as its own
 * route (rather than computed inline in the page) so the same numbers are
 * available for a future export/CSV/scheduled-report feature without
 * duplicating the aggregation logic.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  const admin = authUser ? await prisma.user.findUnique({ where: { authUserId: authUser.id } }) : null;

  if (!admin || admin.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const stats = await computeOpsStats();
  return NextResponse.json(stats);
}
