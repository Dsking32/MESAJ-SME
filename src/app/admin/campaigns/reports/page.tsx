import { prisma } from "@/lib/prisma";
import { requireAdminPage } from "@/lib/adminAuth";
import ReportQueue from "./ReportQueue";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const where = { status: "SENT" as const, reportApprovedAt: null };

  const [campaigns, totalCount] = await Promise.all([
    prisma.campaign.findMany({
      where,
      include: { tenant: true, senderId: true },
      orderBy: { createdAt: "asc" },
      skip,
      take,
    }),
    prisma.campaign.count({ where }),
  ]);

  // Delivery status breakdown per campaign — grouped in one query rather
  // than N+1'ing per campaign row.
  const campaignIds = campaigns.map((c) => c.id);
  const grouped = await prisma.messageRecipient.groupBy({
    by: ["campaignId", "deliveryStatus"],
    where: { campaignId: { in: campaignIds } },
    _count: true,
  });

  const countsByCampaign: Record<string, { delivered: number; failed: number; expired: number; pending: number; total: number }> = {};
  for (const c of campaigns) {
    countsByCampaign[c.id] = { delivered: 0, failed: 0, expired: 0, pending: 0, total: 0 };
  }
  for (const g of grouped) {
    const bucket = countsByCampaign[g.campaignId];
    if (!bucket) continue;
    bucket.total += g._count;
    if (g.deliveryStatus === "DELIVERED") bucket.delivered += g._count;
    else if (g.deliveryStatus === "FAILED") bucket.failed += g._count;
    else if (g.deliveryStatus === "EXPIRED") bucket.expired += g._count;
    else if (g.deliveryStatus === "PENDING") bucket.pending += g._count;
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Delivery report approval"
        description="Sent campaigns wait here until you review the delivery outcome and approve — clients can't see per-number status until then."
        tone="dark"
      />
      <ReportQueue
        campaigns={campaigns.map((c) => ({
          id: c.id,
          messageBody: c.messageBody,
          recipientCount: c.recipientCount,
          createdAt: c.createdAt.toISOString(),
          tenant: { id: c.tenant.id, businessName: c.tenant.businessName },
          senderId: { requestedName: c.senderId.requestedName },
          counts: countsByCampaign[c.id],
        }))}
      />
      <Pager basePath="/admin/campaigns/reports" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
