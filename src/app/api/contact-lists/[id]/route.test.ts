import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    contactList: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), delete: vi.fn() },
    contact: { createMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: {
    CONTACT_LIST_CREATE: { limit: 10, windowMs: 60_000 },
    CONTACT_LIST_DELETE: { limit: 10, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/portedNumbers", () => ({
  loadCarrierOverrides: vi.fn(async () => ({})),
}));

import { GET, PATCH, DELETE } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const USER = { id: "user-1", tenantId: "tenant-1" };
const LIST = {
  id: "list-1",
  name: "VIP customers",
  tenantId: "tenant-1",
  createdAt: new Date("2026-08-01"),
  contacts: [{ id: "c1", phoneNumber: "2348031234567", carrier: "MTN", createdAt: new Date() }],
  _count: { contacts: 1 },
};

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

function req(method: string, body?: unknown) {
  return new NextRequest("https://example.test/api/contact-lists/list-1", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function callGet() {
  return GET(req("GET"), { params: Promise.resolve({ id: "list-1" }) });
}
function callPatch(body: unknown) {
  return PATCH(req("PATCH", body), { params: Promise.resolve({ id: "list-1" }) });
}
function callDelete() {
  return DELETE(req("DELETE"), { params: Promise.resolve({ id: "list-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 10, remaining: 9, resetAt: new Date() });
  mockedPrisma.contactList.findFirst.mockResolvedValue(LIST as never);
  mockedPrisma.contactList.findUniqueOrThrow.mockResolvedValue({
    id: "list-1",
    name: "VIP customers",
    _count: { contacts: 2 },
  } as never);
  mockedPrisma.$transaction.mockResolvedValue([{}, {}] as never);
});

describe("GET /api/contact-lists/[id]", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callGet();

    expect(res.status).toBe(401);
  });

  it("returns 404 (tenant-scoped query, not another tenant's list)", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(404);
    expect(mockedPrisma.contactList.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "list-1", tenantId: "tenant-1" } })
    );
  });

  it("reports truncated:true when contactCount exceeds the returned contacts (5000 cap)", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue({
      ...LIST,
      _count: { contacts: 6000 }, // more than the 5000-item page returned
    } as never);

    const res = await callGet();
    const json = await res.json();

    expect(json.truncated).toBe(true);
    expect(json.contactCount).toBe(6000);
  });

  it("returns the list with contacts mapped to id/phoneNumber/carrier", async () => {
    const res = await callGet();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.contacts).toEqual([{ id: "c1", phoneNumber: "2348031234567", carrier: "MTN" }]);
  });
});

describe("PATCH /api/contact-lists/[id] — access control & validation", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callPatch({ numbers: ["08031234567"] });

    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 10, remaining: 0, resetAt: new Date() });

    const res = await callPatch({ numbers: ["08031234567"] });

    expect(res.status).toBe(429);
  });

  it("returns 404 when the list doesn't belong to this tenant", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue(null);

    const res = await callPatch({ numbers: ["08031234567"] });

    expect(res.status).toBe(404);
  });

  it("rejects an empty numbers array", async () => {
    const res = await callPatch({ numbers: [] });
    expect(res.status).toBe(400);
    expect(mockedPrisma.contact.createMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/contact-lists/[id] — append semantics", () => {
  it("dedupes against phone numbers already in THIS list before inserting", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue({
      ...LIST,
      contacts: [{ phoneNumber: "2348031234567" }], // already present
    } as never);

    // 08031234567 normalizes to 2348031234567 — already in the list, so
    // should be excluded from the insert even though it's a valid number.
    await callPatch({ numbers: ["08031234567", "08021234567"] });

    expect(mockedPrisma.contact.createMany).toHaveBeenCalledWith({
      data: [{ phoneNumber: "2348021234567", carrier: "AIRTEL", contactListId: "list-1" }],
    });
  });

  it("skips the createMany call entirely when every submitted number is already in the list", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue({
      ...LIST,
      contacts: [{ phoneNumber: "2348031234567" }],
    } as never);

    await callPatch({ numbers: ["08031234567"] });

    expect(mockedPrisma.contact.createMany).not.toHaveBeenCalled();
  });

  it("reports added count and totalAlreadyInList separately in the response", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue({
      ...LIST,
      contacts: [{ phoneNumber: "2348031234567" }],
    } as never);

    const res = await callPatch({ numbers: ["08031234567", "08021234567"] });
    const json = await res.json();

    expect(json.added).toBe(1);
    expect(json.totalAlreadyInList).toBe(1);
  });
});

describe("DELETE /api/contact-lists/[id]", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callDelete();

    expect(res.status).toBe(401);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 404 when the list doesn't belong to this tenant, without touching the transaction", async () => {
    mockedPrisma.contactList.findFirst.mockResolvedValue(null);

    const res = await callDelete();

    expect(res.status).toBe(404);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("deletes contacts and the list atomically in one transaction (contacts first, no FK-violation ordering)", async () => {
    await callDelete();

    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.contact.deleteMany).toHaveBeenCalledWith({ where: { contactListId: "list-1" } });
    expect(mockedPrisma.contactList.delete).toHaveBeenCalledWith({ where: { id: "list-1" } });
  });

  it("returns {deleted:true} on success", async () => {
    const res = await callDelete();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ deleted: true });
  });
});
