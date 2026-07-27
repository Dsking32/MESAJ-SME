import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminPage } from "@/lib/adminAuth";
import { formatDate } from "@/lib/formatDate";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { PageHeader } from "@/components/ui/PageHeader";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Users } from "lucide-react";

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const [tenants, totalCount] = await Promise.all([
    prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { campaigns: true, senderIds: true } },
      },
      skip,
      take,
    }),
    prisma.tenant.count(),
  ]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Clients"
        description={`${totalCount} registered business${totalCount === 1 ? "" : "es"}.`}
        tone="dark"
      />

      {tenants.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]">
          <EmptyState icon={Users} title="No clients yet" className="text-white" />
        </div>
      ) : (
        <TableShell>
          <THead>
            <TH>Business</TH>
            <TH>Sector</TH>
            <TH>Wallet</TH>
            <TH>Sender IDs</TH>
            <TH>Campaigns</TH>
            <TH>Joined</TH>
          </THead>
          <tbody>
            {tenants.map((t) => (
              <TR key={t.id}>
                <TD>
                  <Link href={`/admin/clients/${t.id}`} className="font-medium text-[var(--color-brand-700)] hover:underline">
                    {t.businessName}
                  </Link>
                  <p className="text-xs text-[var(--color-ink-500)]">{t.contactEmail}</p>
                </TD>
                <TD>{t.sector}</TD>
                <TD className="font-mono tabular-nums">₦{t.walletBalance.toLocaleString()}</TD>
                <TD className="font-mono tabular-nums">{t._count.senderIds}</TD>
                <TD className="font-mono tabular-nums">{t._count.campaigns}</TD>
                <TD className="text-[var(--color-ink-500)]">{formatDate(t.createdAt)}</TD>
              </TR>
            ))}
          </tbody>
        </TableShell>
      )}
      <Pager basePath="/admin/clients" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
