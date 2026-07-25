import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { update: vi.fn() },
    walletTransaction: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";

const mockedPrisma = vi.mocked(prisma, { deep: true });

const SECRET = "test-paystack-secret";

function signedRequest(body: object, opts: { secret?: string } = {}): NextRequest {
  const rawBody = JSON.stringify(body);
  const signature = crypto
    .createHmac("sha512", opts.secret ?? SECRET)
    .update(rawBody)
    .digest("hex");

  return new NextRequest("https://example.test/api/wallet/paystack/webhook", {
    method: "POST",
    headers: { "x-paystack-signature": signature },
    body: rawBody,
  });
}

const CHARGE_SUCCESS_EVENT = {
  event: "charge.success",
  data: {
    reference: "ref-123",
    amount: 500000, // kobo -> 5000 naira
    metadata: { tenantId: "tenant-1" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  // Default happy path: $transaction resolves as if both statements committed.
  mockedPrisma.$transaction.mockResolvedValue([{}, {}] as never);
});

describe("POST /api/wallet/paystack/webhook", () => {
  it("rejects a request with a missing/invalid signature", async () => {
    const res = await POST(signedRequest(CHARGE_SUCCESS_EVENT, { secret: "wrong-secret" }));

    expect(res.status).toBe(401);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("credits the wallet and records the transaction on a valid charge.success event", async () => {
    const res = await POST(signedRequest(CHARGE_SUCCESS_EVENT));

    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "tenant-1" },
      data: { walletBalance: { increment: 5000 } },
    });
    expect(mockedPrisma.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        type: "TOPUP",
        amount: 5000,
        paymentReference: "ref-123",
      }),
    });
  });

  it("ignores events with no tenantId in metadata rather than crediting nothing/nobody", async () => {
    const event = {
      event: "charge.success",
      data: { reference: "ref-456", amount: 100000, metadata: {} },
    };

    const res = await POST(signedRequest(event));

    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("treats a duplicate delivery (unique constraint violation) as already-processed, not an error", async () => {
    // Simulates the second of two concurrent/duplicate webhook deliveries
    // for the same reference: the DB unique constraint on paymentReference
    // rejects the insert, both statements in the $transaction roll back,
    // and the handler should swallow this rather than double-crediting or
    // 500ing (a 500 would make Paystack retry indefinitely).
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["paymentReference"] },
    });
    mockedPrisma.$transaction.mockRejectedValueOnce(p2002);

    const res = await POST(signedRequest(CHARGE_SUCCESS_EVENT));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  it("still surfaces non-idempotency errors so Paystack retries", async () => {
    mockedPrisma.$transaction.mockRejectedValueOnce(new Error("connection reset"));

    await expect(POST(signedRequest(CHARGE_SUCCESS_EVENT))).rejects.toThrow("connection reset");
  });
});
