import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    walletTransaction: { create: vi.fn() },
    adminAuditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ADMIN_SEND: { limit: 30, windowMs: 60_000 } },
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const TENANT = { id: "tenant-1", walletBalance: 1000 };

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function mockTransaction(tx: Record<string, unknown>) {
  mockedPrisma.$transaction.mockImplementation(
    ((fn: (tx: unknown) => unknown) => fn(tx)) as unknown as typeof prisma.$transaction
  );
  return tx;
}

function adjustRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/tenants/tenant-1/adjust-wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(body: unknown) {
  return POST(adjustRequest(body), { params: Promise.resolve({ id: "tenant-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, resetAt: new Date() });
  mockedPrisma.tenant.findUnique.mockResolvedValue(TENANT as never);
});

describe("POST /api/admin/tenants/[id]/adjust-wallet — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute({ amount: 100 });

    expect(res.status).toBe(403);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 30, remaining: 0, resetAt: new Date() });

    const res = await callRoute({ amount: 100 });

    expect(res.status).toBe(429);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tenants/[id]/adjust-wallet — validation", () => {
  it("rejects amount 0", async () => {
    const res = await callRoute({ amount: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric amount", async () => {
    const res = await callRoute({ amount: "100" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the tenant doesn't exist", async () => {
    mockedPrisma.tenant.findUnique.mockResolvedValue(null);

    const res = await callRoute({ amount: 100 });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/tenants/[id]/adjust-wallet — credit path", () => {
  it("plain-increments the balance for a positive amount and records both the transaction and the audit log", async () => {
    const updateSpy = vi.fn().mockResolvedValue({});
    const walletTxSpy = vi.fn().mockResolvedValue({});
    const auditSpy = vi.fn().mockResolvedValue({});
    mockTransaction({
      tenant: {
        update: updateSpy,
        updateMany: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "tenant-1", walletBalance: 1500 }),
      },
      walletTransaction: { create: walletTxSpy },
      adminAuditLog: { create: auditSpy },
    });

    const res = await callRoute({ amount: 500, note: "bank transfer" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.walletBalance).toBe(1500);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalance: { increment: 500 } } })
    );
    expect(walletTxSpy).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "MANUAL_ADJUST", amount: 500 }) })
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: "WALLET_MANUAL_ADJUST", adminId: "admin-1" }),
      })
    );
  });
});

describe("POST /api/admin/tenants/[id]/adjust-wallet — debit path", () => {
  it("uses a guarded updateMany (not a plain update) so a concurrent debit can't push the balance below zero", async () => {
    const updateManySpy = vi.fn().mockResolvedValue({ count: 1 });
    mockTransaction({
      tenant: {
        update: vi.fn(),
        updateMany: updateManySpy,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "tenant-1", walletBalance: 700 }),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
    });

    const res = await callRoute({ amount: -300 });

    expect(res.status).toBe(200);
    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "tenant-1", walletBalance: { gte: 300 } }),
        data: { walletBalance: { increment: -300 } },
      })
    );
  });

  it("returns 400 (not a 500) when the guarded debit finds insufficient balance", async () => {
    const updateManySpy = vi.fn().mockResolvedValue({ count: 0 }); // guard matched zero rows -> would go negative
    mockTransaction({
      tenant: { update: vi.fn(), updateMany: updateManySpy, findUniqueOrThrow: vi.fn() },
      walletTransaction: { create: vi.fn() },
      adminAuditLog: { create: vi.fn() },
    });

    const res = await callRoute({ amount: -5000 });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/below zero/i);
  });
});
