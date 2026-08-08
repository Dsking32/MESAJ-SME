import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaign: { findUnique: vi.fn() },
    messageRecipient: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/rateLimit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rateLimit")>("@/lib/rateLimit");
  return {
    ...actual,
    checkRateLimit: vi.fn(),
    rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  };
});

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const SENT_CAMPAIGN = { id: "campaign-1", status: "SENT" };

function callRoute(campaignId: string) {
  const req = new NextRequest(`https://example.test/api/admin/campaigns/${campaignId}/report.csv`);
  return GET(req, { params: Promise.resolve({ id: campaignId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: { id: "admin-1" } } as never);
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetAt: new Date() });
  mockedPrisma.campaign.findUnique.mockResolvedValue(SENT_CAMPAIGN as never);
  mockedPrisma.messageRecipient.findMany.mockResolvedValue([]);
});

describe("GET /api/admin/campaigns/[id]/report.csv — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    const deniedResponse = new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 });
    mockedRequireAdminApi.mockResolvedValue({ ok: false, response: deniedResponse } as never);

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(403);
    expect(mockedPrisma.campaign.findUnique).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetAt: new Date() });

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(429);
  });
});

describe("GET /api/admin/campaigns/[id]/report.csv — availability before approval", () => {
  it("returns 404 when the campaign doesn't exist", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(null);

    const res = await callRoute("missing");

    expect(res.status).toBe(404);
  });

  it("returns 409 when the campaign hasn't been sent yet", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue({ id: "campaign-1", status: "PENDING_APPROVAL" } as never);

    const res = await callRoute("campaign-1");
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/hasn't been sent/i);
  });

  it("succeeds for a SENT campaign with NO reportApprovedAt check at all — this is the whole point of the route", async () => {
    // Deliberately not setting reportApprovedAt anywhere on SENT_CAMPAIGN —
    // the admin-side download must work precisely when the report is NOT
    // yet approved, so they can review before deciding.
    const res = await callRoute("campaign-1");

    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/campaigns/[id]/report.csv — CSV content", () => {
  it("produces the same MSISDN,Telco,Status shape as the client export", async () => {
    mockedPrisma.messageRecipient.findMany.mockResolvedValue([
      { phoneNumber: "2348031234567", carrier: "MTN", deliveryStatus: "DELIVERED" },
      { phoneNumber: "2347011234567", carrier: "AIRTEL", deliveryStatus: "FAILED" },
    ] as never);

    const res = await callRoute("campaign-1");
    const text = await res.text();

    expect(text).toBe(
      ["MSISDN,Telco,Status", "2348031234567,MTN,DELIVERED", "2347011234567,AIRTEL,FAILED"].join("\n")
    );
  });

  it("sets CSV content type and a download filename", async () => {
    const res = await callRoute("campaign-1");

    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="campaign-campaign-1-report.csv"');
  });

  it("scopes rows to only this campaign's recipients, ordered by creation", async () => {
    await callRoute("campaign-1");

    expect(mockedPrisma.messageRecipient.findMany).toHaveBeenCalledWith({
      where: { campaignId: "campaign-1" },
      orderBy: { createdAt: "asc" },
    });
  });
});
