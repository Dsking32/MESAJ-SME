import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    tenant: { create: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ONBOARDING: { limit: 5, windowMs: 60_000 } },
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

function mockAuthedUser(email = "biz@example.test") {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1", email } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function callRoute(body: unknown) {
  const req = new NextRequest("https://example.test/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

const VALID_BODY = {
  businessName: "Venix Partners Ltd",
  cacNumber: "RC1234567",
  sector: "Retail",
  contactPhone: "08031234567",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 5, remaining: 4, resetAt: new Date() });
  mockedPrisma.user.findUnique.mockResolvedValue(null); // no existing user/tenant yet
  mockedPrisma.tenant.create.mockResolvedValue({ id: "tenant-1", businessName: "Venix Partners Ltd" } as never);
  mockedPrisma.tenant.delete.mockResolvedValue({} as never);
  mockedPrisma.user.create.mockResolvedValue({ id: "user-1", tenantId: "tenant-1", role: "CLIENT" } as never);
  mockedPrisma.user.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", tenantId: "tenant-1", role: "CLIENT" } as never);
});

describe("POST /api/onboarding — access control", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(401);
    expect(mockedPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("returns 401 when the auth user has no email (can't set Tenant.contactEmail)", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1", email: null } } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 5, remaining: 0, resetAt: new Date() });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(429);
  });
});

describe("POST /api/onboarding — already-onboarded guard", () => {
  it("returns 409 when this auth user already has a tenant, without touching the DB further", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: "tenant-existing" } as never);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(409);
    expect(mockedPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("FIXED — race path 1 (no User row yet): the loser's create() hits the unique authUserId constraint, deletes its own orphan Tenant, and returns 409 instead of leaving a duplicate Tenant behind", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null); // neither request sees an existing row
    mockedPrisma.user.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already completed/i);
    // The critical assertion: the Tenant this request created gets cleaned
    // up, not left orphaned.
    expect(mockedPrisma.tenant.delete).toHaveBeenCalledWith({ where: { id: "tenant-1" } });
  });

  it("FIXED — race path 2 (a User row already exists without a tenant): the loser's guarded updateMany matches zero rows, deletes its own orphan Tenant, and returns 409", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: null } as never);
    mockedPrisma.user.updateMany.mockResolvedValue({ count: 0 }); // another request already claimed it

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already completed/i);
    expect(mockedPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { authUserId: "auth-user-1", tenantId: null },
      data: { tenantId: "tenant-1" },
    });
    expect(mockedPrisma.tenant.delete).toHaveBeenCalledWith({ where: { id: "tenant-1" } });
  });

  it("the winner of race path 2 does NOT delete its tenant, and returns the now-linked user", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: null } as never);
    mockedPrisma.user.updateMany.mockResolvedValue({ count: 1 }); // this request won the claim

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(mockedPrisma.tenant.delete).not.toHaveBeenCalled();
    expect(json.user.tenantId).toBe("tenant-1");
  });
});

describe("POST /api/onboarding — validation", () => {
  it("rejects a missing businessName via the shared zod schema", async () => {
    const { businessName: _drop, ...withoutBusinessName } = VALID_BODY;
    void _drop;

    const res = await callRoute(withoutBusinessName);

    expect(res.status).toBe(400);
    expect(mockedPrisma.tenant.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding — success path (no existing User row — the common case)", () => {
  it("creates the tenant with contactEmail from the auth session (not client-supplied)", async () => {
    mockAuthedUser("verified-owner@example.test");

    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactEmail: "verified-owner@example.test" }),
      })
    );
  });

  it("creates the User row linked to this tenant with role CLIENT, guarded by the unique authUserId constraint", async () => {
    await callRoute(VALID_BODY);

    expect(mockedPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { authUserId: "auth-user-1", email: "biz@example.test", role: "CLIENT", tenantId: "tenant-1" },
      })
    );
  });

  it("returns 201 with both the tenant and user", async () => {
    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.tenant.id).toBe("tenant-1");
    expect(json.user.tenantId).toBe("tenant-1");
  });
});
