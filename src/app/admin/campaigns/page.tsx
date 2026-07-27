import { prisma } from "@/lib/prisma";
import { requireAdminPage } from "@/lib/adminAuth";
import CampaignQueue from "./CampaignQueue";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AdminCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const [campaigns, totalCount] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: "PENDING_APPROVAL" },
      include: { tenant: true, senderId: true },
      orderBy: { createdAt: "asc" },
      skip,
      take,
    }),
    prisma.campaign.count({ where: { status: "PENDING_APPROVAL" } }),
  ]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Campaign approval queue"
        description="Review message content only — invalid numbers were already excluded, and unapproved carriers are automatically skipped on send."
        tone="dark"
      />
      <CampaignQueue
        campaigns={campaigns.map((c) => ({
          id: c.id,
          messageBody: c.messageBody,
          recipientCount: c.recipientCount,
          invalidCount: c.invalidCount,
          createdAt: c.createdAt.toISOString(),
          tenant: { id: c.tenant.id, businessName: c.tenant.businessName },
          senderId: { requestedName: c.senderId.requestedName },
        }))}
      />
      <Pager basePath="/admin/campaigns" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
