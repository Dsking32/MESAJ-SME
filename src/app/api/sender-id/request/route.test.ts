import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    tenant: { update: vi.fn() },
    senderId: { create: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { SENDER_ID_REQUEST: { limit: 5, windowMs: 60_000 } },
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const USER = { id: "user-1", tenantId: "tenant-1" };

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

function callRoute(body: unknown) {
  const req = new NextRequest("https://example.test/api/sender-id/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

const VALID_BODY = {
  requestedName: "Venix",
  businessName: "Venix Partners Ltd",
  cacNumber: "RC1234567",
  sector: "Retail",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 5, remaining: 4, resetAt: new Date() });
  mockedPrisma.tenant.update.mockResolvedValue({} as never);
  mockedPrisma.senderId.create.mockResolvedValue({ id: "sender-1", requestedName: "Venix" } as never);
});

describe("POST /api/sender-id/request — access control", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(401);
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("returns 400 when the authenticated user has no tenant", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: null } as never);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited, scoped per tenant (not per user)", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 5, remaining: 0, resetAt: new Date() });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(429);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.stringContaining("tenant-1"), 5, 60_000);
  });
});

describe("POST /api/sender-id/request — validation", () => {
  it("rejects an empty requestedName via the shared zod schema", async () => {
    const res = await callRoute({ ...VALID_BODY, requestedName: "" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("rejects a missing businessName", async () => {
    const { businessName: _drop, ...withoutBusinessName } = VALID_BODY;
    void _drop;

    const res = await callRoute(withoutBusinessName);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/sender-id/request — success path", () => {
  it("updates the tenant's KYC fields (businessName, cacNumber, sector) with what was submitted", async () => {
    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { businessName: "Venix Partners Ltd", cacNumber: "RC1234567", sector: "Retail" },
    });
  });

  it("creates the Sender ID with all 4 carrier statuses PENDING", async () => {
    await callRoute(VALID_BODY);

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
    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.id).toBe("sender-1");
  });
});
