import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  // Run the after() callback immediately (and await it) so tests can
  // assert on its side effects without a separate flush step. Real
  // Next.js defers it until after the response is sent — that ordering
  // doesn't matter for what these tests check (that the right work was
  // scheduled with the right arguments).
  return { ...actual, after: vi.fn((cb: () => unknown) => cb()) };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
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
vi.mock("@/lib/campaignSendProcessor", () => ({
  computeEligibleCarrierBatches: vi.fn(),
  processNextCampaignBatch: vi.fn(),
}));

import { POST } from "./route";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { computeEligibleCarrierBatches, processNextCampaignBatch } from "@/lib/campaignSendProcessor";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedComputeEligible = vi.mocked(computeEligibleCarrierBatches);
const mockedProcessNext = vi.mocked(processNextCampaignBatch);
const mockedAfter = vi.mocked(after);

const ADMIN = { id: "admin-1", role: "ADMIN" };

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/campaigns/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PENDING_CAMPAIGN = {
  id: "campaign-1",
  tenantId: "tenant-1",
  status: "PENDING_APPROVAL",
  senderId: { carrierStatuses: [{ carrier: "MTN", status: "APPROVED", approvedShortcode: "MYBIZ" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, resetAt: new Date() });
  mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 1 } as never);
  mockedComputeEligible.mockReturnValue([{ carrier: "MTN", shortCode: "MYBIZ", recipients: ["234800000000"] }] as never);
});

describe("POST /api/admin/campaigns/approve", () => {
  it("returns the auth response for a non-admin/unauthenticated caller", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    } as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited, before touching the campaign", async () => {
    mockAdminOk();
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 30, remaining: 0, resetAt: new Date() });

    const res = await POST(postRequest({ campaignId: "campaign-1" }));

    expect(res.status).toBe(429);
    expect(mockedPrisma.campaign.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the campaign doesn't exist", async () => {
    mockAdminOk();
    mockedPrisma.campaign.findUnique.mockResolvedValue(null);

    const res = await POST(postRequest({ campaignId: "nope" }));
    expect(res.status).toBe(404);
  });

  it("returns 409 when the campaign isn't PENDING_APPROVAL", async () => {
    mockAdminOk();
    mockedPrisma.campaign.findUnique.mockResolvedValue({ ...PENDING_CAMPAIGN, status: "SENT" } as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    expect(res.status).toBe(409);
  });

  it("returns 409 when no carrier is both approved and has valid recipients", async () => {
    mockAdminOk();
    mockedPrisma.campaign.findUnique.mockResolvedValue(PENDING_CAMPAIGN as never);
    mockedComputeEligible.mockReturnValue([]);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));

    expect(res.status).toBe(409);
    expect(mockedPrisma.campaign.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 if a concurrent request already claimed the campaign", async () => {
    mockAdminOk();
    mockedPrisma.campaign.findUnique.mockResolvedValue(PENDING_CAMPAIGN as never);
    mockedPrisma.campaign.updateMany.mockResolvedValue({ count: 0 } as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));

    expect(res.status).toBe(409);
    expect(mockedAfter).not.toHaveBeenCalled();
    expect(mockedProcessNext).not.toHaveBeenCalled();
  });

  it("claims the campaign, logs it, schedules the send chain via after(), and returns 202 without waiting for it", async () => {
    mockAdminOk();
    mockedPrisma.campaign.findUnique.mockResolvedValue(PENDING_CAMPAIGN as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.status).toBe("APPROVED");
    expect(body.sending).toBe(true);
    expect(mockedPrisma.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "campaign-1", status: "PENDING_APPROVAL" },
        data: expect.objectContaining({ status: "APPROVED", reviewedByAdminId: "admin-1" }),
      })
    );
    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalled();
    expect(mockedAfter).toHaveBeenCalledWith(expect.any(Function));
    expect(mockedProcessNext).toHaveBeenCalledWith("campaign-1");
  });
});
