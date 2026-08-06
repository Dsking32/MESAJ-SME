import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaign: { findUnique: vi.fn(), update: vi.fn() },
    messageRecipient: { count: vi.fn() },
    adminAuditLog: { create: vi.fn() },
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
vi.mock("@/lib/notifications", () => ({
  notifyReportReady: vi.fn(),
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { notifyReportReady } from "@/lib/notifications";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedNotify = vi.mocked(notifyReportReady);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const SENT_CAMPAIGN = {
  id: "campaign-1",
  status: "SENT",
  reportApprovedAt: null,
  messageBody: "test message",
  tenant: { contactEmail: "biz@example.test", businessName: "Venix Partners" },
};

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function callRoute(campaignId: string) {
  const req = new NextRequest(`https://example.test/api/admin/campaigns/${campaignId}/approve-report`, {
    method: "POST",
  });
  return POST(req, { params: Promise.resolve({ id: campaignId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, resetAt: new Date() });
  mockedPrisma.campaign.findUnique.mockResolvedValue(SENT_CAMPAIGN as never);
  mockedPrisma.messageRecipient.count
    .mockResolvedValueOnce(85) // DELIVERED count
    .mockResolvedValueOnce(100); // total recipient count
  mockedNotify.mockResolvedValue(undefined as never);
});

describe("POST /api/admin/campaigns/[id]/approve-report — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(403);
    expect(mockedPrisma.campaign.update).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 30, remaining: 0, resetAt: new Date() });

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/campaigns/[id]/approve-report — validation", () => {
  it("returns 404 when the campaign doesn't exist", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(null);

    const res = await callRoute("nonexistent");

    expect(res.status).toBe(404);
  });

  it("returns 409 when the campaign hasn't been sent yet", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue({ ...SENT_CAMPAIGN, status: "PENDING_APPROVAL" } as never);

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(409);
    expect(mockedPrisma.campaign.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the report was already approved", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue({
      ...SENT_CAMPAIGN,
      reportApprovedAt: new Date("2026-08-01"),
    } as never);

    const res = await callRoute("campaign-1");
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already approved/i);
    expect(mockedPrisma.campaign.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/campaigns/[id]/approve-report — success path", () => {
  it("stamps reportApprovedAt and the approving admin's id", async () => {
    await callRoute("campaign-1");

    expect(mockedPrisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "campaign-1" },
        data: expect.objectContaining({ reportApprovedAt: expect.any(Date), reportApprovedByAdminId: "admin-1" }),
      })
    );
  });

  it("returns the computed delivered/total counts", async () => {
    const res = await callRoute("campaign-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ approved: true, deliveredCount: 85, recipientTotal: 100 });
  });

  it("notifies the client with the correct delivered/total counts", async () => {
    await callRoute("campaign-1");

    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "biz@example.test",
        businessName: "Venix Partners",
        campaignId: "campaign-1",
        deliveredCount: 85,
        recipientCount: 100,
      })
    );
  });

  it("records an admin audit log entry with the delivered/total counts in the notes", async () => {
    await callRoute("campaign-1");

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "CAMPAIGN_REPORT_APPROVE",
          targetType: "Campaign",
          targetId: "campaign-1",
          notes: expect.stringContaining("85/100 delivered"),
        }),
      })
    );
  });
});
