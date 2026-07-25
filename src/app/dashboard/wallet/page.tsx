import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopUpForm from "./TopUpForm";
import { formatDate } from "@/lib/formatDate";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { CardHeader, Card } from "@/components/ui/Card";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Receipt } from "lucide-react";

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) redirect("/onboarding");

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const [tenant, transactions, totalCount] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: user.tenantId } }),
    prisma.walletTransaction.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.walletTransaction.count({ where: { tenantId: user.tenantId } }),
  ]);

  return (
    <div className="animate-fade-in space-y-8">
      <div className="mb-8">
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-ink-900)]">Wallet</h1>
        <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-[var(--color-ink-900)]">
          ₦{tenant?.walletBalance.toLocaleString() ?? 0}
        </p>
      </div>

      <TopUpForm />

      <div>
        <CardHeader title="Transaction history" />
        {transactions.length === 0 ? (
          <Card padded={false}>
            <EmptyState icon={Receipt} title="No transactions yet" description="Top up your wallet to see your ledger here." />
          </Card>
        ) : (
          <TableShell>
            <THead>
              <TH>Type</TH>
              <TH>Amount</TH>
              <TH>Date</TH>
            </THead>
            <tbody>
              {transactions.map((t) => (
                <TR key={t.id}>
                  <TD>{t.type}</TD>
                  <TD
                    className={
                      "font-mono tabular-nums " + (t.type === "SPEND" ? "text-[var(--color-red-600)]" : "text-[var(--color-brand-600)]")
                    }
                  >
                    {t.type === "SPEND" ? "-" : "+"}₦{Math.abs(t.amount).toLocaleString()}
                  </TD>
                  <TD className="text-[var(--color-ink-500)]">{formatDate(t.createdAt)}</TD>
                </TR>
              ))}
            </tbody>
          </TableShell>
        )}
        <Pager basePath="/dashboard/wallet" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
      </div>
    </div>
  );
}
