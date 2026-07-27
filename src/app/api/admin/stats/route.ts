import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/adminAuth";
import { computeOpsStats } from "@/lib/stats";

/**
 * GET /api/admin/stats
 * Admin-only. Returns the metrics shown on /admin/stats — kept as its own
 * route (rather than computed inline in the page) so the same numbers are
 * available for a future export/CSV/scheduled-report feature without
 * duplicating the aggregation logic.
 */
export async function GET() {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const stats = await computeOpsStats();
  return NextResponse.json(stats);
}
