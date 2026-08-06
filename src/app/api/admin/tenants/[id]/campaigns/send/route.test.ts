import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    senderId: { findFirst: vi.fn() },
    walletTransaction: { create: vi.fn() },
    campaign: { create: vi.fn(), update: vi.fn() },
    campaignCarrierBatch: { create: vi.fn() },
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
vi.mock("@/lib/portedNumbers", () => ({
  loadCarrierOverrides: vi.fn(async () => ({})),
}));
vi.mock("@/lib/mesajClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mesajClient")>("@/lib/mesajClient");
  return { ...actual, sendCampaignAcrossCarriers: vi.fn() };
});
vi.mock("@/lib/messageRecipients", () => ({
  recordMessageRecipients: vi.fn(),
}));
vi.mock("@/lib/campaignSendFailure", () => ({
  handleCampaignSendFailure: vi.fn(),
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { sendCampaignAcrossCarriers } from "@/lib/mesajClient";
import { recordMessageRecipients } from "@/lib/messageRecipients";
import { handleCampaignSendFailure } from "@/lib/campaignSendFailure";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedSend = vi.mocked(sendCampaignAcrossCarriers);
const mockedRecordRecipients = vi.mocked(recordMessageRecipients);
const mockedHandleFailure = vi.mocked(handleCampaignSendFailure);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const TENANT = { id: "tenant-1", walletBalance: 100_000 };
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

function sendRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/tenants/tenant-1/campaigns/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(body: unknown) {
  return POST(sendRequest(body), { params: Promise.resolve({ id: "tenant-1" }) });
}

const VALID_BODY = {
  senderId: "sender-1",
  message: "20% off this weekend!",
  numbers: ["08031234567"], // MTN
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, resetAt: new Date() });
  mockedPrisma.tenant.findUnique.mockResolvedValue(TENANT as never);
  mockedPrisma.senderId.findFirst.mockResolvedValue(SENDER_ID as never);
  mockedPrisma.tenant.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.campaign.create.mockResolvedValue({ id: "campaign-1" } as never);
  mockedPrisma.campaignCarrierBatch.create.mockResolvedValue({ id: "batch-1" } as never);
});

describe("POST /api/admin/tenants/[id]/campaigns/send — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 30, remaining: 0, resetAt: new Date() });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/tenants/[id]/campaigns/send — validation", () => {
  it("rejects a missing senderId/message/numbers", async () => {
    const res = await callRoute({ message: "hi" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the tenant doesn't exist", async () => {
    mockedPrisma.tenant.findUnique.mockResolvedValue(null);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(404);
  });

  it("returns 404 when the Sender ID doesn't belong to this tenant", async () => {
    mockedPrisma.senderId.findFirst.mockResolvedValue(null);

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(404);
    // Confirms the query is actually scoped to this tenant, not just any Sender ID by id.
    expect(mockedPrisma.senderId.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sender-1", tenantId: "tenant-1" } })
    );
  });

  it("returns 400 when no numbers are valid at all", async () => {
    const res = await callRoute({ ...VALID_BODY, numbers: ["not-a-number"] });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the only valid recipients are on carriers with no APPROVED Sender ID status", async () => {
    // 08021234567 is AIRTEL, which is only PENDING in SENDER_ID above.
    const res = await callRoute({ ...VALID_BODY, numbers: ["08021234567"] });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/no approved carriers/i);
    expect(mockedPrisma.tenant.updateMany).not.toHaveBeenCalled(); // no funds reserved
  });
});

describe("POST /api/admin/tenants/[id]/campaigns/send — wallet reservation", () => {
  it("returns 402 without creating a campaign when the guarded reserve finds insufficient balance", async () => {
    mockedPrisma.tenant.updateMany.mockResolvedValue({ count: 0 });

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(402);
    expect(mockedPrisma.campaign.create).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("reserves exactly recipientCount * PRICE_PER_SMS via a guarded (not plain) update", async () => {
    mockedSend.mockResolvedValue([]);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tenant-1", walletBalance: { gte: 9 } }, // 1 recipient * PRICE_PER_SMS(9)
        data: { walletBalance: { decrement: 9 } },
      })
    );
  });
});

describe("POST /api/admin/tenants/[id]/campaigns/send — send throws outright", () => {
  it("delegates to handleCampaignSendFailure and returns 502, rather than duplicating the refund logic inline", async () => {
    mockedSend.mockRejectedValue(new Error("MESAJ_API_TOKEN missing"));

    const res = await callRoute(VALID_BODY);

    expect(res.status).toBe(502);
    expect(mockedHandleFailure).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-1", tenantId: "tenant-1", recipientCount: 1 })
    );
  });
});

describe("POST /api/admin/tenants/[id]/campaigns/send — success path", () => {
  it("creates the campaign as APPROVED (no separate approval step, admin is both author and approver)", async () => {
    mockedSend.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "NEKINGXS",
        recipientCount: 1,
        result: {
          raw: {},
          sentRecipients: ["2348031234567"],
          failedRecipients: [],
          recipientResults: [],
        },
      },
    ] as never);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.campaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED", reviewedByAdminId: "admin-1" }),
      })
    );
  });

  it("marks the campaign SENT and records recipients when at least one message actually sent", async () => {
    mockedSend.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "NEKINGXS",
        recipientCount: 1,
        result: { raw: {}, sentRecipients: ["2348031234567"], failedRecipients: [], recipientResults: [] },
      },
    ] as never);

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(json.status).toBe("SENT");
    expect(json.totalSent).toBe(1);
    expect(mockedPrisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "campaign-1" }, data: { status: "SENT" } })
    );
    expect(mockedRecordRecipients).toHaveBeenCalled();
  });

  it("marks the campaign FAILED (not SENT) when every recipient in the batch failed", async () => {
    mockedSend.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "NEKINGXS",
        recipientCount: 1,
        result: {
          raw: {},
          sentRecipients: [],
          failedRecipients: ["2348031234567"],
          recipientResults: [],
        },
      },
    ] as never);

    const res = await callRoute(VALID_BODY);
    const json = await res.json();

    expect(json.status).toBe("FAILED");
    expect(mockedPrisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } })
    );
  });

  it("refunds the shortfall when actual sent count is less than the reserved estimate", async () => {
    // Reserved for 1 recipient (9 units) but 0 actually sent -> full refund of 9.
    mockedSend.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "NEKINGXS",
        recipientCount: 1,
        result: { raw: {}, sentRecipients: [], failedRecipients: ["2348031234567"], recipientResults: [] },
      },
    ] as never);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tenant-1" }, data: { walletBalance: { increment: 9 } } })
    );
    expect(mockedPrisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "REFUND", amount: 9 }) })
    );
  });

  it("does NOT issue a refund when everything sent successfully (no shortfall)", async () => {
    mockedSend.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "NEKINGXS",
        recipientCount: 1,
        result: { raw: {}, sentRecipients: ["2348031234567"], failedRecipients: [], recipientResults: [] },
      },
    ] as never);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
  });

  it("records an admin audit log entry for the send", async () => {
    mockedSend.mockResolvedValue([
      {
        carrier: "MTN",
        shortCode: "NEKINGXS",
        recipientCount: 1,
        result: { raw: {}, sentRecipients: ["2348031234567"], failedRecipients: [], recipientResults: [] },
      },
    ] as never);

    await callRoute(VALID_BODY);

    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminId: "admin-1", actionType: "ADMIN_CAMPAIGN_SEND", targetId: "campaign-1" }),
      })
    );
  });
});
