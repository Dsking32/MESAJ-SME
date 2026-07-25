import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savedMessage: { findMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { SAVED_MESSAGE_CREATE: { limit: 20, windowMs: 60_000 }, SAVED_MESSAGE_DELETE: { limit: 30, windowMs: 60_000 } },
}));

import { GET, POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const AUTHENTICATED_USER = { id: "auth-user-1" };
const TENANT_USER = { id: "user-1", tenantId: "tenant-1" };

function mockAuthenticated(authenticated: boolean) {
  mockedCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: authenticated ? AUTHENTICATED_USER : null } })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/saved-messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 20, remaining: 19, resetAt: new Date() });
});

describe("GET /api/saved-messages", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthenticated(false);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns saved messages scoped to the caller's tenant", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);
    mockedPrisma.savedMessage.findMany.mockResolvedValue([
      { id: "msg-1", body: "20% off!", tenantId: "tenant-1", createdAt: new Date("2026-01-01") },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(mockedPrisma.savedMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1" } })
    );
  });
});

describe("POST /api/saved-messages", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthenticated(false);
    const res = await POST(postRequest({ body: "Hello" }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited, before touching the database", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 20, remaining: 0, resetAt: new Date() });

    const res = await POST(postRequest({ body: "Hello" }));

    expect(res.status).toBe(429);
    expect(mockedPrisma.savedMessage.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty body instead of silently accepting it", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);

    const res = await POST(postRequest({ body: "" }));

    expect(res.status).toBe(400);
    expect(mockedPrisma.savedMessage.create).not.toHaveBeenCalled();
  });

  it("returns 400 for a body over the max length", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);

    const res = await POST(postRequest({ body: "a".repeat(MAX_MESSAGE_CHARS + 1) }));

    expect(res.status).toBe(400);
    expect(mockedPrisma.savedMessage.create).not.toHaveBeenCalled();
  });

  it("creates the message and scopes it to the caller's tenant", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);
    mockedPrisma.savedMessage.create.mockResolvedValue({
      id: "msg-2",
      body: "20% off this weekend!",
      tenantId: "tenant-1",
      createdAt: new Date("2026-01-02"),
    } as never);

    const res = await POST(postRequest({ body: "20% off this weekend!" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.id).toBe("msg-2");
    expect(mockedPrisma.savedMessage.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-1", body: "20% off this weekend!" },
    });
  });
});
