import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
    tenant: { update: vi.fn() },
    walletTransaction: { create: vi.fn() },
    adminAuditLog: { create: vi.fn() },
    $transaction: vi.fn(),
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
  notifyCampaignRejected: vi.fn(),
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { notifyCampaignRejected } from "@/lib/notifications";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedNotify = vi.mocked(notifyCampaignRejected);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const PENDING_CAMPAIGN = {
  id: "campaign-1",
  tenantId: "tenant-1",
  status: "PENDING_APPROVAL",
  recipientCount: 100,
  messageBody: "test message",
  tenant: { contactEmail: "biz@example.test", businessName: "Venix Partners" },
};

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function rejectRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/campaigns/reject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetAt: new Date() });
  mockedPrisma.campaign.findUnique.mockResolvedValue(PENDING_CAMPAIGN as never);
  mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.$transaction.mockResolvedValue([{}, {}] as never);
  mockedNotify.mockResolvedValue(undefined as never);
});

describe("POST /api/admin/campaigns/reject — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(res.status).toBe(403);
    expect(mockedPrisma.campaign.updateMany).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetAt: new Date() });

    const res = await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/campaigns/reject — validation", () => {
  it("rejects a missing campaignId", async () => {
    const res = await POST(rejectRequest({ reason: "spam content" }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing reason", async () => {
    const res = await POST(rejectRequest({ campaignId: "campaign-1" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the campaign doesn't exist", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(null);

    const res = await POST(rejectRequest({ campaignId: "nonexistent", reason: "spam content" }));

    expect(res.status).toBe(404);
  });

  it("returns 409 when the campaign isn't PENDING_APPROVAL", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue({ ...PENDING_CAMPAIGN, status: "SENT" } as never);

    const res = await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(res.status).toBe(409);
    expect(mockedPrisma.campaign.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/campaigns/reject — concurrent-approve race guard", () => {
  it("returns 409 without refunding when the atomic updateMany claims zero rows (already processed by another request)", async () => {
    mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already processed/i);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("scopes the guarded update to id AND status:PENDING_APPROVAL, so a concurrent approve can't be silently overwritten", async () => {
    await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(mockedPrisma.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "campaign-1", status: "PENDING_APPROVAL" },
        data: expect.objectContaining({ status: "REJECTED", rejectionReason: "spam content" }),
      })
    );
  });
});

describe("POST /api/admin/campaigns/reject — success path", () => {
  it("refunds recipientCount * PRICE_PER_SMS to the tenant wallet inside one transaction", async () => {
    await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { walletBalance: { increment: 900 } }, // 100 recipients * PRICE_PER_SMS (9)
    });
    expect(mockedPrisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant-1", type: "REFUND", amount: 900, units: 100 }),
      })
    );
    // Both calls happen inside the same $transaction — one atomic unit.
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("records an admin audit log entry with the rejection reason", async () => {
    await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "CAMPAIGN_REJECT",
          targetType: "Campaign",
          targetId: "campaign-1",
          notes: "spam content",
        }),
      })
    );
  });

  it("notifies the client of the rejection reason by email", async () => {
    await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "biz@example.test",
        businessName: "Venix Partners",
        reason: "spam content",
      })
    );
  });

  it("still returns 200 when the notification email fails — sendEmail's contract is to return {success:false}, never to throw", async () => {
    // Verified against lib/email.ts: every failure path (missing config,
    // non-2xx response, network error, timeout) is caught internally and
    // returned as {success:false, error}, never a rejection. So mocking a
    // rejection here would test a scenario that can't actually happen —
    // this mocks the real contract instead.
    mockedNotify.mockResolvedValue({ success: false, error: "Resend API returned 500" } as never);

    const res = await POST(rejectRequest({ campaignId: "campaign-1", reason: "spam content" }));

    expect(res.status).toBe(200);
  });
});
