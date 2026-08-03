import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { csvEscape } from "@/lib/csv";

/**
 * GET /api/campaigns/[id]/report.csv
 *
 * Same two gates as the report page: must belong to the requesting
 * tenant, and must have an approved report. No pagination — this is the
 * "download everything" counterpart to the paginated on-screen view.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) return NextResponse.json({ error: "No tenant" }, { status: 403 });

  const { id } = await params;
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: user.tenantId } });
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (!campaign.reportApprovedAt) {
    return NextResponse.json({ error: "Report isn't approved for viewing yet" }, { status: 409 });
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
