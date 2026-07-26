import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Proves, against a real Postgres database, that two WalletTransaction rows
 * can never share a paymentReference — the exact guarantee the webhook
 * idempotency fix depends on. A unit test with a mocked Prisma client can
 * only prove "the code calls create() once"; it can't prove the database
 * itself would reject a second concurrent attempt. This can.
 */

let prisma: PrismaClient;
let tenantId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — integration tests must run against a real (disposable, migrated) database."
    );
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  prisma = new PrismaClient({ adapter });

  const tenant = await prisma.tenant.create({
    data: {
      businessName: "Integration Test Biz",
      cacNumber: "IT-0001",
      sector: "Testing",
      contactEmail: "integration-test@example.test",
      contactPhone: "2348030000000",
    },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  // Clean up everything this file created, then disconnect — this test
  // suite doesn't own the whole database, just its own rows.
  await prisma.walletTransaction.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.walletTransaction.deleteMany({ where: { tenantId } });
});

describe("WalletTransaction.paymentReference uniqueness (real DB)", () => {
  it("allows the first insert with a given paymentReference", async () => {
    const tx = await prisma.walletTransaction.create({
      data: { tenantId, type: "TOPUP", amount: 5000, units: 500, paymentReference: "ref-unique-1" },
    });
    expect(tx.paymentReference).toBe("ref-unique-1");
  });

  it("rejects a second insert with the same paymentReference", async () => {
    await prisma.walletTransaction.create({
      data: { tenantId, type: "TOPUP", amount: 5000, units: 500, paymentReference: "ref-duplicate" },
    });

    await expect(
      prisma.walletTransaction.create({
        data: { tenantId, type: "TOPUP", amount: 5000, units: 500, paymentReference: "ref-duplicate" },
      })
    ).rejects.toMatchObject({ code: "P2002" });

    // And critically: exactly one row exists, not two — the wallet was
    // never double-credited.
    const rows = await prisma.walletTransaction.findMany({ where: { tenantId, paymentReference: "ref-duplicate" } });
    expect(rows).toHaveLength(1);
  });

  it("rejects two truly concurrent inserts with the same reference — only one wins", async () => {
    // Simulates two webhook deliveries arriving at (near) the same instant —
    // the exact race the findFirst-then-create pattern couldn't close.
    const attempt = () =>
      prisma.walletTransaction.create({
        data: { tenantId, type: "TOPUP", amount: 5000, units: 500, paymentReference: "ref-concurrent" },
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rows = await prisma.walletTransaction.findMany({ where: { tenantId, paymentReference: "ref-concurrent" } });
    expect(rows).toHaveLength(1);
  });

  it("allows multiple MANUAL_ADJUST rows with no paymentReference (NULL != NULL)", async () => {
    await prisma.walletTransaction.create({
      data: { tenantId, type: "MANUAL_ADJUST", amount: 1000, units: 100, paymentReference: null },
    });
    await prisma.walletTransaction.create({
      data: { tenantId, type: "MANUAL_ADJUST", amount: 2000, units: 200, paymentReference: null },
    });

    const rows = await prisma.walletTransaction.findMany({
      where: { tenantId, paymentReference: null },
    });
    expect(rows).toHaveLength(2);
  });
});
