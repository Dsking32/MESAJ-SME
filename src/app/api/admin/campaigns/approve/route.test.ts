import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    campaign: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    campaignCarrierBatch: { create: vi.fn() },
    tenant: { update: vi.fn() },
    walletTransaction: { create: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ADMIN_SEND: { limit: 30, windowMs: 60_000 } },
}));
vi.mock("@/lib/mesajClient", () => ({
  sendCampaignAcrossCarriers: vi.fn(),
  batchStatusFromResult: vi.fn((result: { failedRecipients: string[]; sentRecipients: string[] }) => {
    if (result.failedRecipients.length === 0) return "SUCCESS";
    if (result.sentRecipients.length === 0) return "FAILED";
    return "PARTIAL";
  }),
}));
vi.mock("@/lib/notifications", () => ({
  notifyCampaignSent: vi.fn(),
}));
vi.mock("@/lib/messageRecipients", () => ({
  recordMessageRecipients: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { sendCampaignAcrossCarriers } from "@/lib/mesajClient";
import { notifyCampaignSent } from "@/lib/notifications";
import { recordMessageRecipients } from "@/lib/messageRecipients";
import * as Sentry from "@sentry/nextjs";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedSendCampaign = vi.mocked(sendCampaignAcrossCarriers);
const mockedNotify = vi.mocked(notifyCampaignSent);
const mockedRecordMessageRecipients = vi.mocked(recordMessageRecipients);
const mockedCaptureMessage = vi.mocked(Sentry.captureMessage);

const ADMIN_USER = { id: "admin-1", role: "ADMIN" };

function mockAdmin(authenticated: boolean, isAdmin = true) {
  mockedCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: authenticated ? { id: "auth-admin-1" } : null },
      })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(
    authenticated ? (isAdmin ? (ADMIN_USER as never) : ({ id: "user-1", role: "CLIENT" } as never)) : null
  );
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/campaigns/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const APPROVED_SENDER_ID = {
  carrierStatuses: [
    { carrier: "MTN", status: "APPROVED", approvedShortcode: "MYBIZ" },
    { carrier: "AIRTEL", status: "PENDING", approvedShortcode: null },
  ],
};

const TENANT = {
  id: "tenant-1",
  contactEmail: "biz@example.com",
  businessName: "Test Biz",
};

const BASE_CAMPAIGN = {
  id: "campaign-1",
  tenantId: "tenant-1",
  status: "PENDING_APPROVAL",
  messageBody: "20% off this weekend!",
  recipientCount: 10,
  validatedNumbersJson: JSON.stringify({ MTN: Array(10).fill("2348030000000"), AIRTEL: [], GLO: [], MOBILE9: [] }),
  senderId: APPROVED_SENDER_ID,
  tenant: TENANT,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, resetAt: new Date() });
  mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 1 } as never);
  mockedPrisma.campaignCarrierBatch.create.mockResolvedValue({ id: "batch-1" } as never);
});

describe("POST /api/admin/campaigns/approve", () => {
  it("returns 403 for a non-admin user", async () => {
    mockAdmin(true, false);
    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited, before touching the campaign", async () => {
    mockAdmin(true);
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 30, remaining: 0, resetAt: new Date() });

    const res = await POST(postRequest({ campaignId: "campaign-1" }));

    expect(res.status).toBe(429);
    expect(mockedPrisma.campaign.findUnique).not.toHaveBeenCalled();
  });

  it("sends a fully successful campaign, refunds nothing, and notifies with no refund mentioned", async () => {
    mockAdmin(true);
    mockedPrisma.campaign.findUnique.mockResolvedValue(BASE_CAMPAIGN as never);
    mockedSendCampaign.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "MYBIZ",
        recipientCount: 10,
        result: { success: true, sentRecipients: Array(10).fill("x"), failedRecipients: [], raw: {} },
      },
    ] as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("SENT");
    expect(body.totalSent).toBe(10);
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled(); // no refund
    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({ to: "biz@example.com", totalSent: 10, recipientCount: 10, refundedAmount: 0 })
    );
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  it("refunds the shortfall and notifies as a partial send when some recipients fail", async () => {
    mockAdmin(true);
    mockedPrisma.campaign.findUnique.mockResolvedValue(BASE_CAMPAIGN as never);
    mockedSendCampaign.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "MYBIZ",
        recipientCount: 10,
        result: {
          success: false,
          sentRecipients: Array(6).fill("x"),
          failedRecipients: Array(4).fill("y"),
          raw: {},
        },
      },
    ] as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("SENT"); // partial still counts as SENT overall
    expect(body.totalSent).toBe(6);
    expect(mockedPrisma.tenant.update).toHaveBeenCalled(); // refund for the 4 that failed
    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({ to: "biz@example.com", totalSent: 6, recipientCount: 10, refundedAmount: expect.any(Number) })
    );
    const refundedAmount = mockedNotify.mock.calls[0][0].refundedAmount;
    expect(refundedAmount).toBeGreaterThan(0);
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  it("refunds the full amount and notifies as a total failure when every carrier batch fails", async () => {
    mockAdmin(true);
    mockedPrisma.campaign.findUnique.mockResolvedValue(BASE_CAMPAIGN as never);
    mockedSendCampaign.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "MYBIZ",
        recipientCount: 10,
        result: { success: false, sentRecipients: [], failedRecipients: Array(10).fill("y"), raw: {} },
      },
    ] as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("FAILED");
    expect(body.totalSent).toBe(0);
    expect(mockedNotify).toHaveBeenCalledWith(
      expect.objectContaining({ to: "biz@example.com", totalSent: 0, recipientCount: 10 })
    );
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      "Campaign fully failed to send — every carrier batch failed",
      expect.objectContaining({ level: "error", extra: expect.objectContaining({ campaignId: "campaign-1" }) })
    );
  });

  it("returns 409 if the campaign was already processed by a concurrent request", async () => {
    mockAdmin(true);
    mockedPrisma.campaign.findUnique.mockResolvedValue(BASE_CAMPAIGN as never);
    mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 0 } as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));

    expect(res.status).toBe(409);
    expect(mockedSendCampaign).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });
});
