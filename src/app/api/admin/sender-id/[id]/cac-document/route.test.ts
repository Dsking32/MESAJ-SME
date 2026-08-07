import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    senderId: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/adminAuth", () => ({
  requireAdminApi: vi.fn(),
}));
vi.mock("@/lib/cacDocument", () => ({
  createCacDocumentSignedUrl: vi.fn(),
}));

import { GET } from "./route";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { createCacDocumentSignedUrl } from "@/lib/cacDocument";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRequireAdminApi = vi.mocked(requireAdminApi);
const mockedCreateSignedUrl = vi.mocked(createCacDocumentSignedUrl);

function callRoute(id: string) {
  const req = new NextRequest(`https://example.test/api/admin/sender-id/${id}/cac-document`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireAdminApi.mockResolvedValue({ ok: true, admin: { id: "admin-1" } } as never);
});

describe("GET /api/admin/sender-id/[id]/cac-document — access control", () => {
  it("returns the admin auth failure response when not an admin", async () => {
    const deniedResponse = new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 });
    mockedRequireAdminApi.mockResolvedValue({ ok: false, response: deniedResponse } as never);

    const res = await callRoute("sender-1");

    expect(res.status).toBe(403);
    expect(mockedPrisma.senderId.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/sender-id/[id]/cac-document — lookups", () => {
  it("returns 404 when the Sender ID request doesn't exist", async () => {
    mockedPrisma.senderId.findUnique.mockResolvedValue(null);

    const res = await callRoute("missing");

    expect(res.status).toBe(404);
    expect(mockedCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("returns 404 when the Sender ID request exists but has no CAC document on file", async () => {
    mockedPrisma.senderId.findUnique.mockResolvedValue({ cacDocumentPath: null } as never);

    const res = await callRoute("sender-1");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/no cac document/i);
    expect(mockedCreateSignedUrl).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/sender-id/[id]/cac-document — success path", () => {
  it("redirects to a freshly minted signed URL for the stored path", async () => {
    mockedPrisma.senderId.findUnique.mockResolvedValue({ cacDocumentPath: "tenant-1/sender-1.jpg" } as never);
    mockedCreateSignedUrl.mockResolvedValue("https://signed.example/tenant-1/sender-1.jpg?token=abc");

    const res = await callRoute("sender-1");

    expect(mockedCreateSignedUrl).toHaveBeenCalledWith("tenant-1/sender-1.jpg");
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get("location")).toBe("https://signed.example/tenant-1/sender-1.jpg?token=abc");
  });
});

describe("GET /api/admin/sender-id/[id]/cac-document — signed URL failure", () => {
  it("returns 502 when minting the signed URL throws", async () => {
    mockedPrisma.senderId.findUnique.mockResolvedValue({ cacDocumentPath: "tenant-1/sender-1.jpg" } as never);
    mockedCreateSignedUrl.mockRejectedValue(new Error("storage unavailable"));

    const res = await callRoute("sender-1");

    expect(res.status).toBe(502);
  });
});
