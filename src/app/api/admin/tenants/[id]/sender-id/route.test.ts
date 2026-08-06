import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    senderId: { create: vi.fn() },
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

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const TENANT = { id: "tenant-1", businessName: "Venix Partners" };

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function callRoute(body: unknown) {
  const req = new NextRequest("https://example.test/api/admin/tenants/tenant-1/sender-id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: "tenant-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetAt: new Date() });
  mockedPrisma.tenant.findUnique.mockResolvedValue(TENANT as never);
  mockedPrisma.senderId.create.mockResolvedValue({ id: "sender-1", requestedName: "Venix" } as never);
});

describe("POST /api/admin/tenants/[id]/sender-id — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute({ requestedName: "Venix" });

    expect(res.status).toBe(403);
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetAt: new Date() });

    const res = await callRoute({ requestedName: "Venix" });

    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/tenants/[id]/sender-id — validation", () => {
  it("rejects a missing requestedName", async () => {
    const res = await callRoute({});
    expect(res.status).toBe(400);
  });

  it("rejects a non-string requestedName", async () => {
    const res = await callRoute({ requestedName: 12345 });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the tenant doesn't exist", async () => {
    mockedPrisma.tenant.findUnique.mockResolvedValue(null);

    const res = await callRoute({ requestedName: "Venix" });

    expect(res.status).toBe(404);
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tenants/[id]/sender-id — success path", () => {
  it("creates all 4 carrier statuses as PENDING", async () => {
    await callRoute({ requestedName: "Venix" });

    expect(mockedPrisma.senderId.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          requestedName: "Venix",
          carrierStatuses: {
            create: [
              { carrier: "MTN", status: "PENDING" },
              { carrier: "AIRTEL", status: "PENDING" },
              { carrier: "GLO", status: "PENDING" },
              { carrier: "MOBILE9", status: "PENDING" },
            ],
          },
        }),
      })
    );
  });

  it("returns 201 with the created record", async () => {
    const res = await callRoute({ requestedName: "Venix" });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.id).toBe("sender-1");
  });

  it("records an admin audit log entry naming the requested Sender ID", async () => {
    await callRoute({ requestedName: "Venix" });

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "SENDER_ID_ADMIN_ASSIGN",
          targetType: "Tenant",
          targetId: "tenant-1",
          notes: expect.stringContaining("Venix"),
        }),
      })
    );
  });
});
