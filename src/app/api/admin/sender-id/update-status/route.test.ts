import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    senderIdCarrierStatus: { update: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ADMIN_ACTION: { limit: 60, windowMs: 60_000 } },
}));
vi.mock("@/lib/notifications", () => ({
  notifySenderIdStatusChange: vi.fn(),
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { notifySenderIdStatusChange } from "@/lib/notifications";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedNotify = vi.mocked(notifySenderIdStatusChange);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const UPDATED = {
  senderIdId: "sender-1",
  carrier: "MTN",
  status: "APPROVED",
  approvedShortcode: "NEKINGXS",
  senderId: {
    requestedName: "Venix",
    tenant: { contactEmail: "biz@example.test", businessName: "Venix Partners" },
  },
};

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function callRoute(body: unknown) {
  const req = new NextRequest("https://example.test/api/admin/sender-id/update-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

const VALID_BODY = { senderIdId: "sender-1", carrier: "MTN", status: "APPROVED", approvedShortcode: "NEKINGXS" };

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetAt: new Date() });
  mockedPrisma.senderIdCarrierStatus.update.mockResolvedValue(UPDATED as never);
  mockedNotify.mockResolvedValue(undefined as never);
});

describe("POST /api/admin/sender-id/update-status — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockedPrisma.senderIdCarrierStatus.update).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetAt: new Date() });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/sender-id/update-status — validation", () => {
  it("rejects a missing senderIdId/carrier/status", async () => {
    const res = await callRoute({ carrier: "MTN", status: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("rejects status APPROVED without an approvedShortcode", async () => {
    const res = await callRoute({ senderIdId: "sender-1", carrier: "MTN", status: "APPROVED" });
    expect(res.status).toBe(400);
    expect(mockedPrisma.senderIdCarrierStatus.update).not.toHaveBeenCalled();
  });

  it("KNOWN GAP: an invalid status value is not validated in-app and reaches Prisma unchecked — this documents current behavior, not a design choice", async () => {
    // Unlike the role-update route (which validates against an explicit
    // allow-list before touching the DB), this route has no such check —
    // a bad `status` string is only ever caught by Prisma's own enum
    // validation, which throws rather than returning a clean 400. Worth
    // fixing with an explicit allow-list, mirroring users/[id]/role.
    mockedPrisma.senderIdCarrierStatus.update.mockRejectedValue(
      Object.assign(new Error("Invalid enum value"), { code: "P2009" })
    );

    await expect(callRoute({ senderIdId: "sender-1", carrier: "MTN", status: "NOT_A_REAL_STATUS" })).rejects.toThrow();
  });
});

describe("POST /api/admin/sender-id/update-status — success path", () => {
  it("updates via the compound (senderIdId, carrier) key", async () => {
    await callRoute(VALID_BODY);

    expect(mockedPrisma.senderIdCarrierStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { senderIdId_carrier: { senderIdId: "sender-1", carrier: "MTN" } },
        data: { status: "APPROVED", approvedShortcode: "NEKINGXS" },
      })
    );
  });

  it("clears approvedShortcode to null when status is REJECTED, even if one was passed", async () => {
    mockedPrisma.senderIdCarrierStatus.update.mockResolvedValue({
      ...UPDATED,
      status: "REJECTED",
      approvedShortcode: null,
    } as never);

    await callRoute({ senderIdId: "sender-1", carrier: "MTN", status: "REJECTED", approvedShortcode: "SHOULD_BE_IGNORED" });

    expect(mockedPrisma.senderIdCarrierStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "REJECTED", approvedShortcode: null } })
    );
  });

  it("notifies the client with the carrier, status, and shortcode", async () => {
    await callRoute(VALID_BODY);

    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "biz@example.test",
        businessName: "Venix Partners",
        carrier: "MTN",
        status: "APPROVED",
        approvedShortcode: "NEKINGXS",
      })
    );
  });

  it("records an admin audit log entry with the carrier -> status transition", async () => {
    await callRoute(VALID_BODY);

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "SENDER_ID_STATUS_UPDATE",
          targetType: "SenderId",
          targetId: "sender-1",
          notes: expect.stringContaining("MTN -> APPROVED"),
        }),
      })
    );
  });

  it("returns the updated record", async () => {
    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("APPROVED");
  });
});
