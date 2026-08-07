import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    tenant: { update: vi.fn() },
    senderId: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
  RATE_LIMITS: { SENDER_ID_REQUEST: { limit: 5, windowMs: 60_000 } },
}));
vi.mock("@/lib/cacDocument", () => ({
  validateCacDocument: vi.fn(),
  uploadCacDocument: vi.fn(),
  deleteCacDocument: vi.fn(),
  buildCacDocumentPath: vi.fn(() => "tenant-1/sender-1.jpg"),
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { validateCacDocument, uploadCacDocument, deleteCacDocument } from "@/lib/cacDocument";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCreateClient = vi.mocked(createClient);
const mockedCheckRateLimit = vi.mocked(checkRateLimit);
const mockedValidateCacDocument = vi.mocked(validateCacDocument);
const mockedUploadCacDocument = vi.mocked(uploadCacDocument);
const mockedDeleteCacDocument = vi.mocked(deleteCacDocument);

const USER = { id: "user-1", tenantId: "tenant-1" };

function mockAuthedUser() {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockedPrisma.user.findUnique.mockResolvedValue(USER as never);
}

const VALID_FIELDS = {
  requestedName: "Venix",
  businessName: "Venix Partners Ltd",
  cacNumber: "RC1234567",
  sector: "Retail",
};

function makeFile(overrides: Partial<{ name: string; type: string; content: string }> = {}) {
  const { name = "cac.jpg", type = "image/jpeg", content = "fake-image-bytes" } = overrides;
  return new File([content], name, { type });
}

function callRoute(fields: Record<string, string> = VALID_FIELDS, file: File | null = makeFile()) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  if (file) formData.set("cacDocument", file);

  const req = new NextRequest("https://example.test/api/sender-id/request", {
    method: "POST",
    body: formData,
  });
  return POST(req);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthedUser();
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, limit: 5, remaining: 4, resetAt: new Date() });
  mockedPrisma.tenant.update.mockResolvedValue({} as never);
  mockedPrisma.senderId.create.mockResolvedValue({ id: "sender-1", requestedName: "Venix" } as never);
  mockedPrisma.senderId.update.mockResolvedValue({ id: "sender-1", requestedName: "Venix" } as never);
  mockedValidateCacDocument.mockReturnValue(null); // valid by default
  mockedUploadCacDocument.mockResolvedValue("tenant-1/sender-1.jpg");
  mockedDeleteCacDocument.mockResolvedValue(undefined);
});

describe("POST /api/sender-id/request — access control", () => {
  it("returns 401 when not authenticated", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await callRoute();

    expect(res.status).toBe(401);
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("returns 400 when the authenticated user has no tenant", async () => {
    mockedCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } } })) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "user-1", tenantId: null } as never);

    const res = await callRoute();

    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited, scoped per tenant (not per user)", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, limit: 5, remaining: 0, resetAt: new Date() });

    const res = await callRoute();

    expect(res.status).toBe(429);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.stringContaining("tenant-1"), 5, 60_000);
  });
});

describe("POST /api/sender-id/request — field validation", () => {
  it("rejects an empty requestedName via the shared zod schema", async () => {
    const res = await callRoute({ ...VALID_FIELDS, requestedName: "" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("rejects a missing businessName", async () => {
    const { businessName: _drop, ...withoutBusinessName } = VALID_FIELDS;
    void _drop;

    const res = await callRoute(withoutBusinessName);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/sender-id/request — CAC document validation", () => {
  it("rejects when no file is attached at all", async () => {
    const res = await callRoute(VALID_FIELDS, null);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/CAC document/i);
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("rejects when validateCacDocument flags the file (wrong type/too large/etc.)", async () => {
    mockedValidateCacDocument.mockReturnValue("CAC document must be a JPG, PNG, WEBP, or PDF file.");

    const res = await callRoute(VALID_FIELDS, makeFile({ type: "application/zip", name: "cac.zip" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/JPG, PNG, WEBP, or PDF/);
    expect(mockedPrisma.senderId.create).not.toHaveBeenCalled();
  });

  it("accepts a PDF as well as image types", async () => {
    const res = await callRoute(VALID_FIELDS, makeFile({ type: "application/pdf", name: "cac.pdf" }));

    expect(res.status).toBe(201);
    expect(mockedUploadCacDocument).toHaveBeenCalled();
  });
});

describe("POST /api/sender-id/request — success path", () => {
  it("updates the tenant's KYC fields (businessName, cacNumber, sector) with what was submitted", async () => {
    await callRoute();

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { businessName: "Venix Partners Ltd", cacNumber: "RC1234567", sector: "Retail" },
    });
  });

  it("creates the Sender ID with all 4 carrier statuses PENDING", async () => {
    await callRoute();

    expect(mockedPrisma.senderId.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          requestedName: "Venix",
          carrierStatuses: {
            create: [
              { carrier: "MTN", status: "PENDING" },
              { carrier: "AIRTEL", status: "PENDING" },
              { carrier: "GLO", status: "PENDING" },
              { carrier: "MOBILE9", status: "PENDING" },
            ],
          },
        }),
      })
    );
  });

  it("uploads the CAC document scoped to the tenant and this senderId, then attaches the path", async () => {
    await callRoute();

    expect(mockedUploadCacDocument).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", senderIdId: "sender-1" })
    );
    expect(mockedPrisma.senderId.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sender-1" },
        data: expect.objectContaining({
          cacDocumentPath: "tenant-1/sender-1.jpg",
          cacDocumentContentType: "image/jpeg",
        }),
      })
    );
  });

  it("returns 201 with the created record", async () => {
    const res = await callRoute();
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.id).toBe("sender-1");
  });
});

describe("POST /api/sender-id/request — upload failure after the request row was created", () => {
  it("returns 502, includes the senderIdId so support can follow up, and cleans up any partial upload", async () => {
    mockedUploadCacDocument.mockRejectedValue(new Error("network blip"));

    const res = await callRoute();
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.senderIdId).toBe("sender-1");
    expect(mockedDeleteCacDocument).toHaveBeenCalled();
  });
});
