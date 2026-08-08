import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { csvEscape } from "@/lib/csv";

/**
 * GET /api/admin/campaigns/[id]/report.csv
 *
 * Admin's counterpart to /api/campaigns/[id]/report.csv, but the other
 * way round on the gate: the client-facing one requires reportApprovedAt
 * to be set (clients only ever see an approved report), while THIS one
 * deliberately has no such check — the whole point is letting admin
 * download and review the report BEFORE deciding whether to approve it
 * (see the "Delivery report approval" queue this is called from). Only
 * requires the campaign to have actually been sent — before that there's
 * no delivery data to export yet.
 *
 * Same CSV shape as the client export (MSISDN, Telco, Status) so a report
 * downloaded here and one downloaded later by the client after approval
 * are identical, byte for byte.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;
  const { admin } = auth;

  const rl = await checkRateLimit(
    `admin-report-download:${admin.id}`,
    RATE_LIMITS.ADMIN_ACTION.limit,
    RATE_LIMITS.ADMIN_ACTION.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;

  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaign.status !== "SENT") {
    return NextResponse.json(
      { error: `Campaign hasn't been sent yet (status: ${campaign.status}) — nothing to report on.` },
      { status: 409 }
    );
  }

  const recipients = await prisma.messageRecipient.findMany({
    where: { campaignId: campaign.id },
    orderBy: { createdAt: "asc" },
  });

  const rows = [
    "MSISDN,Telco,Status",
    ...recipients.map((r) => [r.phoneNumber, r.carrier, r.deliveryStatus].map(csvEscape).join(",")),
  ];

  return new NextResponse(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-${campaign.id}-report.csv"`,
    },
  });
}
