import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/stats", () => ({
  computeOpsStats: vi.fn(),
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { computeOpsStats } from "@/lib/stats";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedComputeOpsStats = vi.mocked(computeOpsStats);

function mockAuth(authenticated: boolean, role: "ADMIN" | "CLIENT" = "ADMIN") {
  mockedCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: authenticated ? { id: "auth-1" } : null } })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(authenticated ? ({ id: "u1", role } as never) : null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/stats", () => {
  it("returns 403 when not authenticated", async () => {
    mockAuth(false);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockedComputeOpsStats).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin user", async () => {
    mockAuth(true, "CLIENT");
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockedComputeOpsStats).not.toHaveBeenCalled();
  });

  it("returns the computed stats for an admin", async () => {
    mockAuth(true, "ADMIN");
    const fakeStats = { revenue: { totalSpent: 1000 } };
    mockedComputeOpsStats.mockResolvedValue(fakeStats as never);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(fakeStats);
  });
});
