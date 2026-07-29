import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Clock, Download } from "lucide-react";
import { formatDate } from "@/lib/formatDate";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";
import { Card } from "@/components/ui/Card";
import { Badge, statusTone } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";

export default async function CampaignReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) redirect("/onboarding");

  const { id } = await params;

  // Scoped to this tenant — a campaign ID belonging to another tenant
  // returns nothing, same as a 404, rather than leaking its existence.
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: user.tenantId } });
  if (!campaign) notFound();

  const backLink = (
    <Link
      href="/dashboard"
      className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> Back to dashboard
    </Link>
  );

  if (!campaign.reportApprovedAt) {
    return (
      <div className="animate-fade-in">
        {backLink}
        <PageHeader title="Delivery report" description={campaign.messageBody} />
        <Card>
          <EmptyState
            icon={Clock}
            title="Report is being reviewed"
            description="This campaign has been sent. We're finalizing delivery outcomes and will notify you by email as soon as the report is ready to view."
          />
        </Card>
      </div>
    );
  }

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const [recipients, totalCount] = await Promise.all([
    prisma.messageRecipient.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: "asc" },
      skip,
      take,
    }),
    prisma.messageRecipient.count({ where: { campaignId: campaign.id } }),
  ]);

  return (
    <div className="animate-fade-in">
      {backLink}
      <PageHeader title="Delivery report" description={campaign.messageBody} />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-[var(--color-ink-500)]">
          {totalCount} recipients · approved {formatDate(campaign.reportApprovedAt)}
        </p>
        <a
          href={`/api/campaigns/${campaign.id}/report.csv`}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink-700)] hover:bg-[var(--color-ink-50)]"
        >
          <Download className="size-3.5" aria-hidden /> Export CSV
        </a>
      </div>

      <TableShell>
        <THead>
          <TH>MSISDN</TH>
          <TH>Telco</TH>
          <TH>Status</TH>
        </THead>
        <tbody>
          {recipients.map((r) => (
            <TR key={r.id}>
              <TD className="font-mono">{r.phoneNumber}</TD>
              <TD>{r.carrier}</TD>
              <TD>
                <Badge tone={statusTone(r.deliveryStatus)}>{r.deliveryStatus}</Badge>
              </TD>
            </TR>
          ))}
        </tbody>
      </TableShell>
      <Pager basePath={`/dashboard/campaigns/${campaign.id}/report`} page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
