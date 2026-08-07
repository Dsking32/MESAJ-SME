import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
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

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/whoami", () => {
  it("returns role:null, onboarded:false, and 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({ role: null, onboarded: false });
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns onboarded:false when authenticated but no app-level User row exists yet (between signup and onboarding completion)", async () => {
    mockAuthedUser();
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ role: null, onboarded: false });
  });

  it("returns onboarded:false when a User row exists but has no tenantId yet", async () => {
    mockAuthedUser();
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "CLIENT", tenantId: null } as never);

    const res = await GET();
    const json = await res.json();

    expect(json).toEqual({ role: "CLIENT", onboarded: false });
  });

  it("returns role and onboarded:true for a fully onboarded client", async () => {
    mockAuthedUser();
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "CLIENT", tenantId: "tenant-1" } as never);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ role: "CLIENT", onboarded: true });
  });

  it("returns role:ADMIN for an admin user", async () => {
    mockAuthedUser();
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN", tenantId: null } as never);

    const res = await GET();
    const json = await res.json();

    expect(json.role).toBe("ADMIN");
  });
});
