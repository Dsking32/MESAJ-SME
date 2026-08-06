import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { VALIDATE_NUMBERS: { limit: 20, windowMs: 60_000 } },
}));
vi.mock("@/lib/portedNumbers", () => ({
  loadCarrierOverrides: vi.fn(async () => ({})),
}));

import { POST } from "./route";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { loadCarrierOverrides } from "@/lib/portedNumbers";

const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedLoadOverrides = vi.mocked(loadCarrierOverrides);

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function validateRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/campaigns/validate-numbers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 20, remaining: 19, resetAt: new Date() });
  mockedLoadOverrides.mockResolvedValue({});
});

describe("POST /api/campaigns/validate-numbers — access control", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await POST(validateRequest({ numbers: ["08031234567"] }));

    expect(res.status).toBe(401);
    expect(mockedLoadOverrides).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited, scoped per authenticated user", async () => {
    mockAuthedUser();
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 20, remaining: 0, resetAt: new Date() });

    const res = await POST(validateRequest({ numbers: ["08031234567"] }));

    expect(res.status).toBe(429);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.stringContaining("auth-user-1"), 20, 60_000);
  });
});

describe("POST /api/campaigns/validate-numbers — validation", () => {
  it("rejects a non-array numbers field", async () => {
    mockAuthedUser();
    const res = await POST(validateRequest({ numbers: "08031234567" }));
    expect(res.status).toBe(400);
  });

  it("rejects a recipient list over the configured limit", async () => {
    mockAuthedUser();
    const tooMany = Array.from({ length: 100_000 }, (_, i) => `0803${String(i).padStart(7, "0")}`);

    const res = await POST(validateRequest({ numbers: tooMany }));

    expect(res.status).toBe(400);
    expect(mockedLoadOverrides).not.toHaveBeenCalled();
  });
});

describe("POST /api/campaigns/validate-numbers — success path", () => {
  it("splits valid numbers by carrier and reports invalid/duplicate counts", async () => {
    mockAuthedUser();

    const res = await POST(
      validateRequest({ numbers: ["08031234567", "08031234567", "not-a-number", "08021234567"] })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.totalInput).toBe(4);
    expect(json.totalDuplicates).toBe(1); // 08031234567 repeated
    expect(json.totalInvalid).toBeGreaterThanOrEqual(1); // "not-a-number"
    expect(json.countsByCarrier.MTN).toBe(1); // 08031234567 (deduped)
    expect(json.countsByCarrier.AIRTEL).toBe(1); // 08021234567
  });

  it("caps invalidSamples at 20 entries even for a much larger invalid list", async () => {
    mockAuthedUser();
    const junk = Array.from({ length: 50 }, (_, i) => `garbage-${i}`);

    const res = await POST(validateRequest({ numbers: junk }));
    const json = await res.json();

    expect(json.invalidSamples.length).toBeLessThanOrEqual(20);
  });

  it("passes the raw input numbers to loadCarrierOverrides (ported-number lookups need the originals, not the cleaned set)", async () => {
    mockAuthedUser();

    await POST(validateRequest({ numbers: ["08031234567"] }));

    expect(mockedLoadOverrides).toHaveBeenCalledWith(["08031234567"]);
  });

  it("does not create any database record — this is a read-only pre-check, actual submission happens at /api/campaigns/submit", async () => {
    mockAuthedUser();

    const res = await POST(validateRequest({ numbers: ["08031234567"] }));

    // No prisma mock is even wired up in this test file — if the route
    // tried to touch the database, this would throw rather than silently
    // pass, which is the point: it documents that this route is read-only.
    expect(res.status).toBe(200);
  });
});
