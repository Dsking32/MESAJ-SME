import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    campaign: { findFirst: vi.fn() },
    messageRecipient: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);

const USER = { id: "user-1", tenantId: "tenant-1" };
const APPROVED_CAMPAIGN = { id: "campaign-1", tenantId: "tenant-1", reportApprovedAt: new Date("2026-08-01") };

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

function callRoute(campaignId: string) {
  const req = new NextRequest(`https://example.test/api/campaigns/${campaignId}/report.csv`, { method: "GET" });
  return GET(req, { params: Promise.resolve({ id: campaignId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  mockedPrisma.campaign.findFirst.mockResolvedValue(APPROVED_CAMPAIGN as never);
  mockedPrisma.messageRecipient.findMany.mockResolvedValue([]);
});

describe("GET /api/campaigns/[id]/report.csv — access control", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(401);
  });

  it("returns 403 when the authenticated user has no tenant", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: null } as never);

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(403);
  });

  it("returns 404 (not another tenant's data) when the campaign belongs to a different tenant — scoped query, not a post-fetch check", async () => {
    mockedPrisma.campaign.findFirst.mockResolvedValue(null);

    const res = await callRoute("someone-elses-campaign");

    expect(res.status).toBe(404);
    expect(mockedPrisma.campaign.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-elses-campaign", tenantId: "tenant-1" } })
    );
    expect(mockedPrisma.messageRecipient.findMany).not.toHaveBeenCalled();
  });

  it("returns 409 when the report hasn't been approved yet — same gate as the on-screen report", async () => {
    mockedPrisma.campaign.findFirst.mockResolvedValue({ ...APPROVED_CAMPAIGN, reportApprovedAt: null } as never);

    const res = await callRoute("campaign-1");

    expect(res.status).toBe(409);
    expect(mockedPrisma.messageRecipient.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/campaigns/[id]/report.csv — output", () => {
  it("returns a CSV with the correct header row and Content-Type/Content-Disposition", async () => {
    const res = await callRoute("campaign-1");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="campaign-campaign-1-report.csv"');
    expect(text.split("\n")[0]).toBe("MSISDN,Telco,Status");
  });

  it("includes one row per recipient with phone/carrier/status", async () => {
    mockedPrisma.messageRecipient.findMany.mockResolvedValue([
      { phoneNumber: "2348031234567", carrier: "MTN", deliveryStatus: "DELIVERED" },
      { phoneNumber: "2348021234567", carrier: "AIRTEL", deliveryStatus: "FAILED" },
    ] as never);

    const res = await callRoute("campaign-1");
    const lines = (await res.text()).split("\n");

    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toBe("2348031234567,MTN,DELIVERED");
    expect(lines[2]).toBe("2348021234567,AIRTEL,FAILED");
  });

  it("escapes a formula-injection-triggering value via csvEscape rather than writing it raw", async () => {
    // phoneNumber is system-generated and can't actually start with '=' in
    // practice, but this confirms the escaping mechanism itself is wired
    // up correctly end-to-end, not just unit-tested in isolation.
    mockedPrisma.messageRecipient.findMany.mockResolvedValue([
      { phoneNumber: "=2+2", carrier: "MTN", deliveryStatus: "DELIVERED" },
    ] as never);

    const res = await callRoute("campaign-1");
    const lines = (await res.text()).split("\n");

    expect(lines[1]).not.toBe("=2+2,MTN,DELIVERED");
    expect(lines[1].startsWith("'=")).toBe(true);
  });

  it("returns just the header row (no crash) for a campaign with zero recipients", async () => {
    mockedPrisma.messageRecipient.findMany.mockResolvedValue([]);

    const res = await callRoute("campaign-1");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toBe("MSISDN,Telco,Status");
  });
});
