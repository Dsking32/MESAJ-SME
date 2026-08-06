import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    senderId: { findFirst: vi.fn() },
    adminAuditLog: { create: vi.fn() },
    tenant: { updateMany: vi.fn(), update: vi.fn() }, // must NOT be touched by this route
    walletTransaction: { create: vi.fn() }, // must NOT be touched by this route
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ADMIN_SEND: { limit: 30, windowMs: 60_000 } },
}));
vi.mock("@/lib/mesajClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mesajClient")>("@/lib/mesajClient");
  return { ...actual, sendCarrierBatch: vi.fn() };
});

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { sendCarrierBatch } from "@/lib/mesajClient";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedSendBatch = vi.mocked(sendCarrierBatch);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const SENDER_ID = {
  id: "sender-1",
  tenantId: "tenant-1",
  carrierStatuses: [
    { carrier: "MTN", status: "APPROVED", approvedShortcode: "NEKINGXS" },
    { carrier: "AIRTEL", status: "PENDING", approvedShortcode: null },
  ],
};

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function testSendRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/tenants/tenant-1/test-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(body: unknown) {
  return POST(testSendRequest(body), { params: Promise.resolve({ id: "tenant-1" }) });
}

const VALID_BODY = {
  senderIdId: "sender-1",
  testNumber: "08031234567", // MTN
  message: "test message",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, resetAt: new Date() });
  mockedPrisma.senderId.findFirst.mockResolvedValue(SENDER_ID as never);
});

describe("POST /api/admin/tenants/[id]/test-send — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockedSendBatch).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 30, remaining: 0, resetAt: new Date() });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/tenants/[id]/test-send — validation", () => {
  it("rejects a missing senderIdId/testNumber/message", async () => {
    const res = await callRoute({ testNumber: "08031234567" });
    expect(res.status).toBe(400);
  });

  it("rejects a message over MAX_MESSAGE_SEGMENTS", async () => {
    const res = await callRoute({ ...VALID_BODY, message: "x".repeat(1000) });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the Sender ID doesn't belong to this tenant", async () => {
    mockedPrisma.senderId.findFirst.mockResolvedValue(null);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(404);
    expect(mockedPrisma.senderId.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sender-1", tenantId: "tenant-1" } })
    );
  });

  it("returns 400 for an invalid/unrecognized test number", async () => {
    const res = await callRoute({ ...VALID_BODY, testNumber: "not-a-number" });
    expect(res.status).toBe(400);
    expect(mockedSendBatch).not.toHaveBeenCalled();
  });

  it("returns 409 when the Sender ID isn't APPROVED on the test number's carrier", async () => {
    // 08021234567 is AIRTEL, which is only PENDING in SENDER_ID above.
    const res = await callRoute({ ...VALID_BODY, testNumber: "08021234567" });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/not approved on AIRTEL/i);
    expect(mockedSendBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tenants/[id]/test-send — does not touch billing", () => {
  it("never reads or writes the tenant wallet — this is an unbilled QA action, unlike campaigns/send", async () => {
    mockedSendBatch.mockResolvedValue({
      success: true,
      sentRecipients: ["2348031234567"],
      failedRecipients: [],
      recipientResults: [],
      raw: {},
    } as never);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
    expect(mockedPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/tenants/[id]/test-send — success path", () => {
  it("sends via the approved shortCode for the test number's carrier and returns the result", async () => {
    mockedSendBatch.mockResolvedValue({
      success: true,
      sentRecipients: ["2348031234567"],
      failedRecipients: [],
      recipientResults: [],
      raw: { messageId: "abc" },
    } as never);

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(mockedSendBatch).toHaveBeenCalledWith(
      expect.objectContaining({ shortCode: "NEKINGXS", recipients: ["2348031234567"] })
    );
    expect(res.status).toBe(200);
    expect(json).toEqual(
      expect.objectContaining({ success: true, carrier: "MTN", shortCode: "NEKINGXS" })
    );
  });

  it("logs a success audit entry with the carrier and shortCode used", async () => {
    mockedSendBatch.mockResolvedValue({ success: true, raw: {} } as never);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "TEST_SEND",
          targetType: "Tenant",
          targetId: "tenant-1",
          notes: expect.stringContaining("success"),
        }),
      })
    );
  });

  it("still returns 200 (not a 5xx) and logs the failure reason when the carrier send itself fails", async () => {
    mockedSendBatch.mockResolvedValue({ success: false, error: "Carrier timeout", raw: {} } as never);

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: expect.stringContaining("failed — Carrier timeout") }),
      })
    );
  });
});
