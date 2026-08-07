import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savedMessage: { findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: {
    SAVED_MESSAGE_CREATE: { limit: 20, windowMs: 60_000 },
    SAVED_MESSAGE_DELETE: { limit: 20, windowMs: 60_000 },
  },
}));

import { PATCH, DELETE } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const USER = { id: "user-1", tenantId: "tenant-1" };
const MESSAGE = { id: "msg-1", tenantId: "tenant-1", body: "Old text" };

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

function req(method: string, body?: unknown) {
  return new NextRequest("https://example.test/api/saved-messages/msg-1", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function callPatch(body: unknown) {
  return PATCH(req("PATCH", body), { params: Promise.resolve({ id: "msg-1" }) });
}
function callDelete() {
  return DELETE(req("DELETE"), { params: Promise.resolve({ id: "msg-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 20, remaining: 19, resetAt: new Date() });
  mockedPrisma.savedMessage.findFirst.mockResolvedValue(MESSAGE as never);
  mockedPrisma.savedMessage.update.mockResolvedValue({ ...MESSAGE, body: "New text" } as never);
  mockedPrisma.savedMessage.deleteMany.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/saved-messages/[id]", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callPatch({ body: "New text" });

    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 20, remaining: 0, resetAt: new Date() });

    const res = await callPatch({ body: "New text" });

    expect(res.status).toBe(429);
  });

  it("rejects an empty body via the shared zod schema before looking up the message", async () => {
    const res = await callPatch({ body: "" });

    expect(res.status).toBe(400);
    expect(mockedPrisma.savedMessage.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when the message doesn't belong to this tenant (tenant-scoped lookup, not a post-fetch check)", async () => {
    mockedPrisma.savedMessage.findFirst.mockResolvedValue(null);

    const res = await callPatch({ body: "New text" });

    expect(res.status).toBe(404);
    expect(mockedPrisma.savedMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "msg-1", tenantId: "tenant-1" } })
    );
    expect(mockedPrisma.savedMessage.update).not.toHaveBeenCalled();
  });

  it("updates the body and returns the updated record", async () => {
    const res = await callPatch({ body: "New text" });
    const json = await res.json();

    expect(mockedPrisma.savedMessage.update).toHaveBeenCalledWith({
      where: { id: "msg-1" },
      data: { body: "New text" },
    });
    expect(res.status).toBe(200);
    expect(json.body).toBe("New text");
  });
});

describe("DELETE /api/saved-messages/[id]", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callDelete();

    expect(res.status).toBe(401);
    expect(mockedPrisma.savedMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 20, remaining: 0, resetAt: new Date() });

    const res = await callDelete();

    expect(res.status).toBe(429);
  });

  it("deletes via a single tenant-scoped deleteMany (id AND tenantId), not findFirst-then-delete — can't be used to probe another tenant's ids", async () => {
    await callDelete();

    expect(mockedPrisma.savedMessage.deleteMany).toHaveBeenCalledWith({
      where: { id: "msg-1", tenantId: "tenant-1" },
    });
  });

  it("returns 404 when deleteMany matches zero rows (wrong id, or belongs to another tenant)", async () => {
    mockedPrisma.savedMessage.deleteMany.mockResolvedValue({ count: 0 });

    const res = await callDelete();

    expect(res.status).toBe(404);
  });

  it("returns {deleted:true} on success", async () => {
    const res = await callDelete();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ deleted: true });
  });
});
