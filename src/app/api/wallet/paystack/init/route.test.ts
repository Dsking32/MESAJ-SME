import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    tenant: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { WALLET_TOPUP_INIT: { limit: 10, windowMs: 60_000 } },
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const USER = { id: "user-1", tenantId: "tenant-1" };
const TENANT = { id: "tenant-1", contactEmail: "biz@example.test" };

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

function initRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/wallet/paystack/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = "sk_test_xxx";
  process.env.NEXT_PUBLIC_APP_URL = "https://mesaj-sme.test";
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 10, remaining: 9, resetAt: new Date() });
  mockedPrisma.tenant.findUnique.mockResolvedValue(TENANT as never);
  global.fetch = vi.fn();
});

describe("POST /api/wallet/paystack/init — access control", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await POST(initRequest({ amountNaira: 1000 }));

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 400 when the authenticated user has no tenant", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: null } as never);

    const res = await POST(initRequest({ amountNaira: 1000 }));

    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited, scoped per tenant", async () => {
    mockAuthedUser();
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 10, remaining: 0, resetAt: new Date() });

    const res = await POST(initRequest({ amountNaira: 1000 }));

    expect(res.status).toBe(429);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("tenant-1"),
      10,
      60_000
    );
  });
});

describe("POST /api/wallet/paystack/init — validation", () => {
  it("rejects a missing amountNaira", async () => {
    mockAuthedUser();
    const res = await POST(initRequest({}));
    expect(res.status).toBe(400);
  });

  it("rejects a zero or negative amountNaira", async () => {
    mockAuthedUser();
    const res = await POST(initRequest({ amountNaira: -100 }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the tenant row is missing", async () => {
    mockAuthedUser();
    mockedPrisma.tenant.findUnique.mockResolvedValue(null);

    const res = await POST(initRequest({ amountNaira: 1000 }));

    expect(res.status).toBe(404);
  });
});

describe("POST /api/wallet/paystack/init — Paystack call", () => {
  it("converts naira to kobo and attaches tenantId in metadata", async () => {
    mockAuthedUser();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: true, data: { authorization_url: "https://paystack.test/pay/abc", reference: "ref-1" } }),
        { status: 200 }
      )
    );

    await POST(initRequest({ amountNaira: 1000 }));

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.paystack.co/transaction/initialize",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk_test_xxx" }),
      })
    );
    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(options.body);
    expect(sentBody.amount).toBe(100_000); // 1000 naira * 100 = kobo
    expect(sentBody.metadata).toEqual({ tenantId: "tenant-1" });
  });

  it("returns the authorization URL and reference on success", async () => {
    mockAuthedUser();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: true, data: { authorization_url: "https://paystack.test/pay/abc", reference: "ref-1" } }),
        { status: 200 }
      )
    );

    const res = await POST(initRequest({ amountNaira: 1000 }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ authorizationUrl: "https://paystack.test/pay/abc", reference: "ref-1" });
  });

  it("returns 502 (not a crash) when Paystack rejects the request", async () => {
    mockAuthedUser();
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: false }), { status: 400 }));

    const res = await POST(initRequest({ amountNaira: 1000 }));

    expect(res.status).toBe(502);
  });

  it("returns 502 when Paystack responds 200 but status:false (their documented failure shape)", async () => {
    mockAuthedUser();
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: false, message: "Invalid key" }), { status: 200 })
    );

    const res = await POST(initRequest({ amountNaira: 1000 }));

    expect(res.status).toBe(502);
  });
});
