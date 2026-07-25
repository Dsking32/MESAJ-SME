import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mocked before importing the route so the real modules (which need a
// live DB / Supabase project) never actually load. vi.mock is hoisted
// above these imports by Vitest regardless of where it's written.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contactList: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { CONTACT_LIST_CREATE: { limit: 20, windowMs: 60_000 }, CONTACT_LIST_DELETE: { limit: 30, windowMs: 60_000 } },
}));
vi.mock("@/lib/portedNumbers", () => ({
  loadCarrierOverrides: vi.fn(async () => new Map()),
}));

import { GET, POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

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
  return new NextRequest("https://example.test/api/contact-lists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 20, remaining: 19, resetAt: new Date() });
});

describe("GET /api/contact-lists", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthenticated(false);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 401 when the auth user has no tenant yet", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue({ ...TENANT_USER, tenantId: null } as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns saved lists with a contact count each, scoped to the caller's tenant", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);
    mockedPrisma.contactList.findMany.mockResolvedValue([
      { id: "list-1", name: "VIPs", createdAt: new Date("2026-01-01"), _count: { contacts: 3 } },
    ] as never);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([{ id: "list-1", name: "VIPs", createdAt: "2026-01-01T00:00:00.000Z", contactCount: 3 }]);
    // Scoped to the caller's tenant, not a global findMany.
    expect(mockedPrisma.contactList.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1" } })
    );
  });
});

describe("POST /api/contact-lists", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuthenticated(false);
    const res = await POST(postRequest({ name: "VIPs", numbers: ["08031234567"] }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited, before touching the database", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 20, remaining: 0, resetAt: new Date() });

    const res = await POST(postRequest({ name: "VIPs", numbers: ["08031234567"] }));

    expect(res.status).toBe(429);
    expect(mockedPrisma.contactList.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty list name instead of silently accepting it", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);

    const res = await POST(postRequest({ name: "", numbers: ["08031234567"] }));

    expect(res.status).toBe(400);
    expect(mockedPrisma.contactList.create).not.toHaveBeenCalled();
  });

  it("returns 400 when every submitted number is invalid, rather than creating an empty list", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);

    const res = await POST(postRequest({ name: "VIPs", numbers: ["not-a-number"] }));

    expect(res.status).toBe(400);
    expect(mockedPrisma.contactList.create).not.toHaveBeenCalled();
  });

  it("creates the list with only the valid numbers and reports the excluded count", async () => {
    mockAuthenticated(true);
    mockedPrisma.user.findUnique.mockResolvedValue(TENANT_USER as never);
    mockedPrisma.contactList.create.mockResolvedValue({
      id: "list-2",
      name: "VIPs",
      createdAt: new Date("2026-01-02"),
      _count: { contacts: 1 },
    } as never);

    const res = await POST(postRequest({ name: "VIPs", numbers: ["08031234567", "not-a-number"] }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.contactCount).toBe(1);
    expect(body.totalInvalid).toBeGreaterThan(0);
    // Contacts are inserted via a single createMany, not one create() per
    // contact — the perf-sensitive path at list-creation scale.
    expect(mockedPrisma.contactList.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          contacts: { createMany: { data: expect.any(Array) } },
        }),
      })
    );
  });
});
