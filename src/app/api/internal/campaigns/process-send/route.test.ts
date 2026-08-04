import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((cb: () => unknown) => cb()) };
});
vi.mock("@/lib/internalAuth", () => ({
  verifyInternalSecret: vi.fn(),
}));
vi.mock("@/lib/campaignSendProcessor", () => ({
  processNextCampaignBatch: vi.fn(),
}));

import { POST } from "./route";
import { after } from "next/server";
import { verifyInternalSecret } from "@/lib/internalAuth";
import { processNextCampaignBatch } from "@/lib/campaignSendProcessor";

const mockedVerify = vi.mocked(verifyInternalSecret);
const mockedProcessNext = vi.mocked(processNextCampaignBatch);
const mockedAfter = vi.mocked(after);

function postRequest(body: unknown, authHeader?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;
  return new NextRequest("https://example.test/api/internal/campaigns/process-send", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/internal/campaigns/process-send", () => {
  it("returns the auth-layer response when the secret check fails", async () => {
    mockedVerify.mockReturnValue(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) as never);

    const res = await POST(postRequest({ campaignId: "campaign-1" }));

    expect(res.status).toBe(401);
    expect(mockedProcessNext).not.toHaveBeenCalled();
  });

  it("returns 400 when campaignId is missing", async () => {
    mockedVerify.mockReturnValue(null);

    const res = await POST(postRequest({}, "Bearer secret"));

    expect(res.status).toBe(400);
    expect(mockedProcessNext).not.toHaveBeenCalled();
  });

  it("schedules processNextCampaignBatch via after() and responds immediately", async () => {
    mockedVerify.mockReturnValue(null);

    const res = await POST(postRequest({ campaignId: "campaign-1" }, "Bearer secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(mockedAfter).toHaveBeenCalledWith(expect.any(Function));
    expect(mockedProcessNext).toHaveBeenCalledWith("campaign-1");
  });
});
