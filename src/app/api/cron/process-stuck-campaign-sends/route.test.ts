import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((cb: () => unknown) => cb()) };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaign: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/internalAuth", () => ({
  verifyInternalSecret: vi.fn(),
}));
vi.mock("@/lib/campaignSendProcessor", () => ({
  processNextCampaignBatch: vi.fn(),
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { verifyInternalSecret } from "@/lib/internalAuth";
import { processNextCampaignBatch } from "@/lib/campaignSendProcessor";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedVerify = vi.mocked(verifyInternalSecret);
const mockedProcessNext = vi.mocked(processNextCampaignBatch);

function getRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;
  return new NextRequest("https://example.test/api/cron/process-stuck-campaign-sends", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/cron/process-stuck-campaign-sends", () => {
  it("returns the auth-layer response when the secret check fails", async () => {
    mockedVerify.mockReturnValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) as never);

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mockedPrisma.campaign.findMany).not.toHaveBeenCalled();
  });

  it("finds APPROVED campaigns past the stalled threshold and resumes each one", async () => {
    mockedVerify.mockReturnValue(null);
    mockedPrisma.campaign.findMany.mockResolvedValue([{ id: "campaign-1" }, { id: "campaign-2" }] as never);

    const res = await GET(getRequest("Bearer secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stalledCampaignsFound).toBe(2);
    expect(mockedPrisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "APPROVED" }),
      })
    );
    expect(mockedProcessNext).toHaveBeenCalledWith("campaign-1");
    expect(mockedProcessNext).toHaveBeenCalledWith("campaign-2");
  });

  it("responds with zero found and does nothing further when nothing is stalled", async () => {
    mockedVerify.mockReturnValue(null);
    mockedPrisma.campaign.findMany.mockResolvedValue([] as never);

    const res = await GET(getRequest("Bearer secret"));
    const body = await res.json();

    expect(body.stalledCampaignsFound).toBe(0);
    expect(mockedProcessNext).not.toHaveBeenCalled();
  });
});
