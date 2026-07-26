import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { computeOpsStats } from "@/lib/stats";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Wallet, TrendingUp, Send, Users, AlertTriangle, PiggyBank } from "lucide-react";

function naira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export default async function AdminStatsPage() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const admin = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!admin || admin.role !== "ADMIN") redirect("/dashboard");

  const stats = await computeOpsStats();

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader
        title="Stats"
        description="Revenue, send volume, and tenant activity across the whole platform."
        tone="dark"
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-white/70">Revenue</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            tone="admin"
            label="Net revenue (spent − refunded)"
            value={naira(stats.revenue.netRevenue)}
            icon={TrendingUp}
          />
          <StatCard tone="admin" label="Total ever topped up" value={naira(stats.revenue.totalToppedUp)} icon={Wallet} />
          <StatCard
            tone="admin"
            label="Current unspent wallet balance"
            value={naira(stats.revenue.currentWalletBalance)}
            icon={PiggyBank}
          />
          <StatCard tone="admin" label="Total refunded (failed sends)" value={naira(stats.revenue.totalRefunded)} icon={AlertTriangle} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-white/70">Campaigns</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard tone="admin" label="Sent" value={stats.campaigns.totalSent} icon={Send} />
          <StatCard tone="admin" label="Failed" value={stats.campaigns.totalFailed} icon={AlertTriangle} />
          <StatCard
            tone="admin"
            label="Awaiting approval"
            value={stats.campaigns.byStatus["PENDING_APPROVAL"] ?? 0}
          />
          <StatCard tone="admin" label="Rejected" value={stats.campaigns.byStatus["REJECTED"] ?? 0} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-white/70">Send volume</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            tone="admin"
            label="Recipients attempted (all-time)"
            value={stats.sendVolume.totalRecipientsAttempted.toLocaleString()}
          />
          <StatCard tone="admin" label="Carrier batches: succeeded" value={stats.sendVolume.batchesByStatus["SUCCESS"] ?? 0} />
          <StatCard tone="admin" label="Carrier batches: partial" value={stats.sendVolume.batchesByStatus["PARTIAL"] ?? 0} />
          <StatCard
            tone="admin"
            label="Carrier batch failure rate"
            value={percent(stats.sendVolume.batchFailureRate)}
            icon={AlertTriangle}
          />
        </div>
        <p className="mt-2 text-xs text-white/40">
          Batch outcomes are counted per carrier-batch, not per recipient — a PARTIAL batch&apos;s exact
          successful-recipient count lives only in the raw Mesaj response, not a queryable column.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-white/70">Tenants</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard tone="admin" label="Registered businesses" value={stats.tenants.total} icon={Users} />
          <StatCard tone="admin" label="Active in last 30 days" value={stats.tenants.activeLast30Days} />
          <StatCard tone="admin" label="New in last 7 days" value={stats.tenants.newLast7Days} />
          <StatCard tone="admin" label="New in last 30 days" value={stats.tenants.newLast30Days} />
        </div>
      </section>
    </div>
  );
}
