/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./prisma", () => ({
  prisma: {
    walletTransaction: { aggregate: vi.fn() },
    tenant: { aggregate: vi.fn(), count: vi.fn() },
    campaign: { groupBy: vi.fn() },
    campaignCarrierBatch: { aggregate: vi.fn(), groupBy: vi.fn() },
  },
}));

import { computeOpsStats } from "./stats";
import { prisma } from "./prisma";

const mockedPrisma = vi.mocked(prisma, { deep: true });

function setupDefaults() {
  const aggregateMock = mockedPrisma.walletTransaction.aggregate.mockImplementation as any;
  aggregateMock(async ({ where }: any) => {
    if (where?.type === "SPEND") return { _sum: { amount: 500_000 } };
    if (where?.type === "REFUND") return { _sum: { amount: 20_000 } };
    if (where?.type === "TOPUP") return { _sum: { amount: 1_000_000 } };
    return { _sum: { amount: 0 } };
  });
  mockedPrisma.tenant.aggregate.mockResolvedValue({ _sum: { walletBalance: 300_000 } } as never);
  mockedPrisma.campaign.groupBy.mockResolvedValue([
    { status: "SENT", _count: { _all: 40 } },
    { status: "FAILED", _count: { _all: 3 } },
    { status: "PENDING_APPROVAL", _count: { _all: 2 } },
  ] as never);
  mockedPrisma.campaignCarrierBatch.aggregate.mockResolvedValue({ _sum: { recipientCount: 12_000 } } as never);
  mockedPrisma.campaignCarrierBatch.groupBy.mockResolvedValue([
    { mesajResponseStatus: "SUCCESS", _count: { _all: 35 } },
    { mesajResponseStatus: "PARTIAL", _count: { _all: 4 } },
    { mesajResponseStatus: "FAILED", _count: { _all: 5 } },
  ] as never);
  mockedPrisma.tenant.count.mockResolvedValue(50 as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaults();
});

describe("computeOpsStats", () => {
  it("computes net revenue as spent minus refunded", async () => {
    const stats = await computeOpsStats();
    expect(stats.revenue.totalSpent).toBe(500_000);
    expect(stats.revenue.totalRefunded).toBe(20_000);
    expect(stats.revenue.netRevenue).toBe(480_000);
    expect(stats.revenue.totalToppedUp).toBe(1_000_000);
    expect(stats.revenue.currentWalletBalance).toBe(300_000);
  });

  it("builds the campaign status breakdown and pulls out SENT/FAILED shortcuts", async () => {
    const stats = await computeOpsStats();
    expect(stats.campaigns.byStatus).toEqual({ SENT: 40, FAILED: 3, PENDING_APPROVAL: 2 });
    expect(stats.campaigns.totalSent).toBe(40);
    expect(stats.campaigns.totalFailed).toBe(3);
  });

  it("computes batch failure rate as FAILED batches over total batches", async () => {
    const stats = await computeOpsStats();
    // 5 failed out of 35 + 4 + 5 = 44 total
    expect(stats.sendVolume.batchFailureRate).toBeCloseTo(5 / 44, 5);
    expect(stats.sendVolume.totalRecipientsAttempted).toBe(12_000);
    expect(stats.sendVolume.batchesByStatus).toEqual({ SUCCESS: 35, PARTIAL: 4, FAILED: 5 });
  });

  it("returns a failure rate of 0 when there are no batches yet, instead of NaN", async () => {
    mockedPrisma.campaignCarrierBatch.groupBy.mockResolvedValue([] as never);
    const stats = await computeOpsStats();
    expect(stats.sendVolume.batchFailureRate).toBe(0);
  });

  it("defaults every sum to 0 rather than null when there's no data at all", async () => {
    mockedPrisma.walletTransaction.aggregate.mockResolvedValue({ _sum: { amount: null } } as never);
    mockedPrisma.tenant.aggregate.mockResolvedValue({ _sum: { walletBalance: null } } as never);
    mockedPrisma.campaignCarrierBatch.aggregate.mockResolvedValue({ _sum: { recipientCount: null } } as never);

    const stats = await computeOpsStats();
    expect(stats.revenue.totalSpent).toBe(0);
    expect(stats.revenue.netRevenue).toBe(0);
    expect(stats.revenue.currentWalletBalance).toBe(0);
    expect(stats.sendVolume.totalRecipientsAttempted).toBe(0);
  });

  it("passes tenant counts through unchanged", async () => {
    mockedPrisma.tenant.count
      .mockResolvedValueOnce(50 as never) // total
      .mockResolvedValueOnce(18 as never) // activeLast30Days
      .mockResolvedValueOnce(4 as never) // newLast7Days
      .mockResolvedValueOnce(11 as never); // newLast30Days

    const stats = await computeOpsStats();
    expect(stats.tenants).toEqual({ total: 50, activeLast30Days: 18, newLast7Days: 4, newLast30Days: 11 });
  });
});