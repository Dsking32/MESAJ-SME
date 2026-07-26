/**
 * Computes the metrics shown on /admin/stats. Pulled out of the route/page
 * so the aggregation logic itself — which numbers count as "revenue", how
 * a batch failure rate is computed, etc. — has direct test coverage
 * without needing to render a page or hit an API route.
 *
 * Money figures throughout are read from WalletTransaction.amount, which
 * is always stored as a positive naira value regardless of direction (see
 * lib/pricing.ts callers) — the `type` field carries the direction, not
 * the sign.
 */

import { prisma } from "./prisma";

export interface OpsStats {
  revenue: {
    /** Sum of all SPEND transactions — what clients have been charged for campaigns. */
    totalSpent: number;
    /** Sum of all REFUND transactions — the part of totalSpent given back (failed sends). */
    totalRefunded: number;
    /** totalSpent - totalRefunded. The actual money kept for delivered messages. */
    netRevenue: number;
    /** Sum of all TOPUP transactions — total funds ever added to wallets (not the same as revenue; funds can sit unspent). */
    totalToppedUp: number;
    /** Current sum of every tenant's walletBalance right now — unspent funds still on the platform. */
    currentWalletBalance: number;
  };
  campaigns: {
    byStatus: Record<string, number>;
    totalSent: number;
    totalFailed: number;
  };
  sendVolume: {
    /** Sum of recipientCount across every carrier batch that was actually attempted (has a sentAt). */
    totalRecipientsAttempted: number;
    /** Carrier batches, grouped by outcome — SUCCESS/PARTIAL/FAILED counts, not recipient counts.
     * PARTIAL batches don't have an exact per-recipient success count stored outside the raw
     * Mesaj response JSON, so this reports batch-level outcomes rather than fabricating a
     * recipient-level "delivered" total that the schema can't actually back up. */
    batchesByStatus: Record<string, number>;
    /** FAILED batches / total batches. 0 if there have been no batches yet. */
    batchFailureRate: number;
  };
  tenants: {
    total: number;
    /** Tenants with at least one campaign approved in the last 30 days. */
    activeLast30Days: number;
    newLast7Days: number;
    newLast30Days: number;
  };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function computeOpsStats(): Promise<OpsStats> {
  const [
    spendAgg,
    refundAgg,
    topupAgg,
    walletAgg,
    campaignsByStatus,
    batchAgg,
    batchesByStatus,
    tenantTotal,
    activeTenants,
    newTenants7d,
    newTenants30d,
  ] = await Promise.all([
    prisma.walletTransaction.aggregate({ where: { type: "SPEND" }, _sum: { amount: true } }),
    prisma.walletTransaction.aggregate({ where: { type: "REFUND" }, _sum: { amount: true } }),
    prisma.walletTransaction.aggregate({ where: { type: "TOPUP" }, _sum: { amount: true } }),
    prisma.tenant.aggregate({ _sum: { walletBalance: true } }),
    prisma.campaign.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.campaignCarrierBatch.aggregate({
      where: { sentAt: { not: null } },
      _sum: { recipientCount: true },
    }),
    prisma.campaignCarrierBatch.groupBy({ by: ["mesajResponseStatus"], _count: { _all: true } }),
    prisma.tenant.count(),
    prisma.tenant.count({
      where: { campaigns: { some: { approvedAt: { gte: daysAgo(30) } } } },
    }),
    prisma.tenant.count({ where: { createdAt: { gte: daysAgo(7) } } }),
    prisma.tenant.count({ where: { createdAt: { gte: daysAgo(30) } } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of campaignsByStatus) {
    byStatus[row.status] = row._count._all;
  }

  const batchStatusCounts: Record<string, number> = {};
  for (const row of batchesByStatus) {
    batchStatusCounts[row.mesajResponseStatus] = row._count._all;
  }
  const totalBatches = Object.values(batchStatusCounts).reduce((sum, n) => sum + n, 0);
  const failedBatches = batchStatusCounts["FAILED"] ?? 0;

  const totalSpent = spendAgg._sum.amount ?? 0;
  const totalRefunded = refundAgg._sum.amount ?? 0;

  return {
    revenue: {
      totalSpent,
      totalRefunded,
      netRevenue: totalSpent - totalRefunded,
      totalToppedUp: topupAgg._sum.amount ?? 0,
      currentWalletBalance: walletAgg._sum.walletBalance ?? 0,
    },
    campaigns: {
      byStatus,
      totalSent: byStatus["SENT"] ?? 0,
      totalFailed: byStatus["FAILED"] ?? 0,
    },
    sendVolume: {
      totalRecipientsAttempted: batchAgg._sum.recipientCount ?? 0,
      batchesByStatus: batchStatusCounts,
      batchFailureRate: totalBatches > 0 ? failedBatches / totalBatches : 0,
    },
    tenants: {
      total: tenantTotal,
      activeLast30Days: activeTenants,
      newLast7Days: newTenants7d,
      newLast30Days: newTenants30d,
    },
  };
}
