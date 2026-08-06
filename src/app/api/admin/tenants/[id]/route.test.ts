import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn(), update: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ADMIN_ACTION: { limit: 60, windowMs: 60_000 } },
}));

import { GET, PATCH } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const TENANT = { id: "tenant-1", businessName: "Venix Partners", contactEmail: "biz@example.test" };

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function callGet() {
  const req = new NextRequest("https://example.test/api/admin/tenants/tenant-1", { method: "GET" });
  return GET(req, { params: Promise.resolve({ id: "tenant-1" }) });
}

function callPatch(body: unknown) {
  const req = new NextRequest("https://example.test/api/admin/tenants/tenant-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id: "tenant-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetAt: new Date() });
  mockedPrisma.tenant.findUnique.mockResolvedValue(TENANT as never);
  mockedPrisma.tenant.update.mockResolvedValue({ ...TENANT, businessName: "New Name" } as never);
});

describe("GET /api/admin/tenants/[id]", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callGet();

    expect(res.status).toBe(403);
  });

  it("returns 404 when the tenant doesn't exist", async () => {
    mockedPrisma.tenant.findUnique.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(404);
  });

  it("includes sender IDs (with carrier statuses), recent campaigns, and recent wallet transactions", async () => {
    await callGet();

    expect(mockedPrisma.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tenant-1" },
        include: expect.objectContaining({
          senderIds: expect.objectContaining({ include: { carrierStatuses: true } }),
          campaigns: expect.objectContaining({ take: 10 }),
          walletTransactions: expect.objectContaining({ take: 20 }),
        }),
      })
    );
  });

  it("returns the tenant on success", async () => {
    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id).toBe("tenant-1");
  });
});

describe("PATCH /api/admin/tenants/[id] — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callPatch({ businessName: "New Name" });

    expect(res.status).toBe(403);
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetAt: new Date() });

    const res = await callPatch({ businessName: "New Name" });

    expect(res.status).toBe(429);
  });
});

describe("PATCH /api/admin/tenants/[id] — field allow-list", () => {
  it("rejects when no recognized fields are present", async () => {
    const res = await callPatch({ someRandomField: "value" });
    expect(res.status).toBe(400);
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
  });

  it("silently drops fields outside the allow-list rather than writing them — e.g. can't be used to smuggle a walletBalance or role change", async () => {
    await callPatch({ businessName: "New Name", walletBalance: 999_999_999, role: "ADMIN" });

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { businessName: "New Name" },
    });
  });

  it("drops a non-string value for an otherwise-allowed field, and returns 400 if that leaves nothing to update", async () => {
    const res = await callPatch({ businessName: 12345 });

    expect(res.status).toBe(400);
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
  });

  it("drops a non-string value for one field but still updates the other valid fields present", async () => {
    await callPatch({ businessName: 12345, contactPhone: "08031234567" });

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { contactPhone: "08031234567" },
    });
  });

  it("accepts a partial update — only the fields present are written", async () => {
    await callPatch({ contactPhone: "08031234567" });

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { contactPhone: "08031234567" },
    });
  });
});

describe("PATCH /api/admin/tenants/[id] — success path", () => {
  it("returns the updated tenant", async () => {
    const res = await callPatch({ businessName: "New Name" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.businessName).toBe("New Name");
  });

  it("records an admin audit log entry listing which fields changed", async () => {
    await callPatch({ businessName: "New Name", contactEmail: "new@example.test" });

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "TENANT_UPDATE",
          targetType: "Tenant",
          targetId: "tenant-1",
          notes: expect.stringContaining("businessName, contactEmail"),
        }),
      })
    );
  });
});
