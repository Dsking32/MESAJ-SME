import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    campaign: { findFirst: vi.fn() },
    senderId: { findFirst: vi.fn() },
    tenant: { updateMany: vi.fn() },
    walletTransaction: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { CAMPAIGN_SUBMIT: { limit: 10, windowMs: 60_000 } },
}));
vi.mock("@/lib/portedNumbers", () => ({
  loadCarrierOverrides: vi.fn(async () => ({})),
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
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

function postRequest(body: unknown, idempotencyKey?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return new NextRequest("https://example.test/api/campaigns/submit", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  senderId: "sender-1",
  message: "20% off this weekend!",
  numbers: ["08031234567", "08021234567"],
};

const EXISTING_CAMPAIGN = {
  id: "campaign-existing",
  tenantId: "tenant-1",
  status: "PENDING_APPROVAL",
  recipientCount: 2,
  invalidCount: 0,
  validatedNumbersJson: JSON.stringify({ MTN: ["2348031234567"], AIRTEL: ["2348021234567"], GLO: [], MOBILE9: [] }),
  idempotencyKey: "client-key-1",
};

/**
 * Stubs prisma.$transaction to call the callback with a fake `tx` client.
 * Cast at the boundary (the whole mock function, not an inner parameter)
 * rather than typing the callback param as `never` — a `never` parameter
 * is never assignable to the real, non-`never` param type $transaction
 * expects, so that approach fails type-checking against the real
 * generated Prisma client even though it can slip past a stubbed-out one.
 */
function mockTransaction(tx: Record<string, unknown>) {
  mockedPrisma.$transaction.mockImplementation(
    ((fn: (tx: unknown) => unknown) => fn(tx)) as unknown as typeof prisma.$transaction
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 10, remaining: 9, resetAt: new Date() });
  mockedPrisma.campaign.findFirst.mockResolvedValue(null);
  mockTransaction({
    senderId: { findFirst: vi.fn().mockResolvedValue({ id: "sender-1" }) },
    tenant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    campaign: { create: vi.fn().mockResolvedValue({ id: "campaign-new", ...VALID_BODY }) },
    walletTransaction: { create: vi.fn().mockResolvedValue({}) },
  });
});

describe("POST /api/campaigns/submit — idempotency", () => {
  it("returns the existing campaign without hitting the rate limiter when the key was already used", async () => {
    mockAuthedUser();
    mockedPrisma.campaign.findFirst.mockResolvedValue(EXISTING_CAMPAIGN as never);

    const res = await POST(postRequest(VALID_BODY, "client-key-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.campaign.id).toBe("campaign-existing");
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates a new campaign and stores the idempotency key when the key hasn't been seen before", async () => {
    mockAuthedUser();
    const createSpy = vi.fn().mockResolvedValue({ id: "campaign-new", ...VALID_BODY });
    mockTransaction({
      senderId: { findFirst: vi.fn().mockResolvedValue({ id: "sender-1" }) },
      tenant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      campaign: { create: createSpy },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
    });

    const res = await POST(postRequest(VALID_BODY, "client-key-2"));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.idempotent).toBeUndefined();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: "client-key-2" }) })
    );
  });

  it("behaves exactly as before (no idempotency check at all) when no header is sent", async () => {
    mockAuthedUser();

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(mockedPrisma.campaign.findFirst).not.toHaveBeenCalled();
  });

  it("treats a blank Idempotency-Key header the same as no header at all", async () => {
    mockAuthedUser();

    const res = await POST(postRequest(VALID_BODY, "   "));

    expect(res.status).toBe(201);
    expect(mockedPrisma.campaign.findFirst).not.toHaveBeenCalled();
  });

  it("recovers from a same-key race by returning the winning campaign instead of erroring", async () => {
    mockAuthedUser();
    // Nobody has this key yet at the early-exit check...
    mockedPrisma.campaign.findFirst.mockResolvedValueOnce(null);
    // ...but a concurrent request wins the insert first, so the unique
    // constraint fires inside the transaction.
    mockedPrisma.$transaction.mockRejectedValueOnce({ code: "P2002" });
    // The post-race refetch then finds the winner's row.
    mockedPrisma.campaign.findFirst.mockResolvedValueOnce(EXISTING_CAMPAIGN as never);

    const res = await POST(postRequest(VALID_BODY, "client-key-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.campaign.id).toBe("campaign-existing");
  });

  it("still surfaces a non-idempotency database error normally", async () => {
    mockAuthedUser();
    mockedPrisma.$transaction.mockRejectedValueOnce(new Error("connection reset"));

    await expect(POST(postRequest(VALID_BODY, "client-key-3"))).rejects.toThrow("connection reset");
  });
});

describe("POST /api/campaigns/submit — baseline behavior", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited, before validating numbers", async () => {
    mockAuthedUser();
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 10, remaining: 0, resetAt: new Date() });

    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 402 when the wallet balance is insufficient", async () => {
    mockAuthedUser();
    mockTransaction({
      senderId: { findFirst: vi.fn().mockResolvedValue({ id: "sender-1" }) },
      tenant: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      campaign: { create: vi.fn() },
      walletTransaction: { create: vi.fn() },
    });

    const res = await POST(postRequest(VALID_BODY));
    expect(res.status).toBe(402);
  });
});
