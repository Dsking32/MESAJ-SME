import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { ADMIN_ACTION: { limit: 60, windowMs: 60_000 } },
}));

import { PATCH } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/rateLimit";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);

const ADMIN = { id: "admin-1", role: "ADMIN" };
const TARGET_CLIENT = { id: "user-2", email: "client@example.test", role: "CLIENT" };
const TARGET_ADMIN = { id: "user-3", email: "otheradmin@example.test", role: "ADMIN" };

function mockAdminOk() {
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: ADMIN } as never);
}

function roleRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.test/api/admin/users/user-2/role", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callRoute(targetId: string, body: unknown) {
  return PATCH(roleRequest(body), { params: Promise.resolve({ id: targetId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminOk();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetAt: new Date() });
});

describe("PATCH /api/admin/users/[id]/role — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    mockedRequireAdminApi.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) as never,
    });

    const res = await callRoute("user-2", { role: "ADMIN" });

    expect(res.status).toBe(403);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, resetAt: new Date() });

    const res = await callRoute("user-2", { role: "ADMIN" });

    expect(res.status).toBe(429);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/users/[id]/role — validation", () => {
  it("rejects a role value outside CLIENT/ADMIN", async () => {
    const res = await callRoute("user-2", { role: "SUPERUSER" });
    expect(res.status).toBe(400);
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing role", async () => {
    const res = await callRoute("user-2", {});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target user doesn't exist", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await callRoute("nonexistent", { role: "ADMIN" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when the user already has the requested role", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(TARGET_CLIENT as never);

    const res = await callRoute("user-2", { role: "CLIENT" });

    expect(res.status).toBe(409);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/users/[id]/role — self-demotion guard", () => {
  it("rejects an admin trying to change their own role, before even looking up the target", async () => {
    const res = await callRoute("admin-1", { role: "CLIENT" });

    expect(res.status).toBe(400);
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/users/[id]/role — last-admin guard", () => {
  it("blocks demoting the last remaining admin with 409, and never issues the update", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(TARGET_ADMIN as never);
    mockedPrisma.user.count.mockResolvedValue(1); // only this one admin left

    const res = await callRoute("user-3", { role: "CLIENT" });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/last remaining admin/i);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it("allows demoting an admin when at least one other admin exists", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(TARGET_ADMIN as never);
    mockedPrisma.user.count.mockResolvedValue(2); // this one plus at least one more
    mockedPrisma.user.update.mockResolvedValue({ ...TARGET_ADMIN, role: "CLIENT" } as never);

    const res = await callRoute("user-3", { role: "CLIENT" });

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-3" }, data: { role: "CLIENT" } })
    );
  });

  it("never checks admin count at all for a promotion (CLIENT -> ADMIN) — only demotions are gated", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(TARGET_CLIENT as never);
    mockedPrisma.user.update.mockResolvedValue({ ...TARGET_CLIENT, role: "ADMIN" } as never);

    const res = await callRoute("user-2", { role: "ADMIN" });

    expect(res.status).toBe(200);
    expect(mockedPrisma.user.count).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/users/[id]/role — success path", () => {
  it("updates the role and writes an audit log entry recording the transition", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(TARGET_CLIENT as never);
    mockedPrisma.user.update.mockResolvedValue({ ...TARGET_CLIENT, role: "ADMIN" } as never);

    const res = await callRoute("user-2", { role: "ADMIN" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ id: "user-2", email: "client@example.test", role: "ADMIN" });
    expect(mockedPrisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: "admin-1",
          actionType: "USER_ROLE_UPDATE",
          targetType: "User",
          targetId: "user-2",
          notes: expect.stringContaining("CLIENT -> ADMIN"),
        }),
      })
    );
  });
});
