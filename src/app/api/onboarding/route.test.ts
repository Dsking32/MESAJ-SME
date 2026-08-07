import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    tenant: { create: vi.fn() },
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
  mockedPrisma.user.upsert.mockResolvedValue({ id: "user-1", tenantId: "tenant-1", role: "CLIENT" } as never);
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

  it("KNOWN GAP (documented, not fixed): this check-then-create isn't atomic, so two concurrent onboarding submissions for the same brand-new user can both pass it and both create a Tenant — same category of race as the admin-send fix earlier in this codebase's history, just far lower-stakes here (an orphaned empty Tenant row, not a duplicate paid SMS send). Low priority: needs a literal double-submit of a one-time first-login form to trigger.", async () => {
    // This test documents CURRENT behavior (two creates happen), not a
    // guarantee — if this route is later hardened with the same
    // guarded-transaction pattern used elsewhere, this test should be
    // updated to assert the second attempt is rejected/deduped instead.
    mockedPrisma.user.findUnique.mockResolvedValue(null); // both "concurrent" calls see no existing tenant

    await callRoute(VALID_BODY);
    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.create).toHaveBeenCalledTimes(2);
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

describe("POST /api/onboarding — success path", () => {
  it("creates the tenant with contactEmail from the auth session (not client-supplied)", async () => {
    mockAuthedUser("verified-owner@example.test");

    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactEmail: "verified-owner@example.test" }),
      })
    );
  });

  it("upserts the User row linked to this tenant with role CLIENT", async () => {
    await callRoute(VALID_BODY);

    expect(mockedPrisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authUserId: "auth-user-1" },
        create: expect.objectContaining({ authUserId: "auth-user-1", role: "CLIENT", tenantId: "tenant-1" }),
        update: { tenantId: "tenant-1" },
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
