import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    messageRecipient: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

import { POST } from "./route";
import { prisma } from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedCaptureMessage = vi.mocked(Sentry.captureMessage);

const ORIGINAL_SECRET = process.env.MESAJ_WEBHOOK_SECRET;

function webhookRequest(body: unknown, query = ""): NextRequest {
  return new NextRequest(`https://example.test/api/mesaj/webhook${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function payload(overrides: Partial<{
  event: string;
  status: string;
  recipient: string;
  shortCode: string;
  reference: string;
  transactionId: string;
  errorCode: string | null;
  errorMessage: string | null;
  dateTimeDelivered: number | null;
  dateTimeFailed: number | null;
}> = {}) {
  const {
    event = "SMS_DELIVERED",
    status = "DELIVERED",
    recipient = "2347041748361",
    shortCode = "NEKINGXS",
    reference = "ref-1",
    transactionId = "ref-1",
    errorCode = "",
    errorMessage = "",
    dateTimeDelivered = 1785930037492,
    dateTimeFailed = null,
  } = overrides;
  return {
    event,
    data: { status, recipient, shortCode, reference, transactionId, messageId: "shared-msg-id", errorCode, errorMessage, dateTimeDelivered, dateTimeFailed },
    timestamp: "2026-08-05T11:40:38.213Z",
  };
}

const PENDING_ROW = {
  id: "recipient-1",
  deliveryStatus: "PENDING",
  mesajReference: "ref-1",
  phoneNumber: "2347041748361",
  shortcodeUsed: "NEKINGXS",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MESAJ_WEBHOOK_SECRET = "test-secret";
  vi.stubEnv("NODE_ENV", "test");
  mockedPrisma.messageRecipient.findUnique.mockResolvedValue(null);
  mockedPrisma.messageRecipient.findFirst.mockResolvedValue(null);
});

afterEach(() => {
  process.env.MESAJ_WEBHOOK_SECRET = ORIGINAL_SECRET;
  vi.unstubAllEnvs();
});

describe("POST /api/mesaj/webhook — auth", () => {
  it("rejects with 401 when the secret query param is missing", async () => {
    const res = await POST(webhookRequest(payload()));
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when the secret query param is wrong", async () => {
    const res = await POST(webhookRequest(payload(), "?secret=wrong"));
    expect(res.status).toBe(401);
  });

  it("rejects with 401 for a same-length wrong guess (exercises the timingSafeEqual path, not just the length-mismatch fast path)", async () => {
    // "test-secret" is 11 chars; this guess is also 11 chars, differing
    // only in the last character — the length-mismatch fast path can't
    // short-circuit this one, so it actually calls timingSafeEqual.
    const res = await POST(webhookRequest(payload(), "?secret=test-secre1"));
    expect(res.status).toBe(401);
  });

  it("accepts when the secret query param matches", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(PENDING_ROW as never);
    const res = await POST(webhookRequest(payload(), "?secret=test-secret"));
    expect(res.status).toBe(200);
  });

  it("fails closed with 503 in production when MESAJ_WEBHOOK_SECRET isn't configured", async () => {
    delete process.env.MESAJ_WEBHOOK_SECRET;
    vi.stubEnv("NODE_ENV", "production");

    const res = await POST(webhookRequest(payload()));

    expect(res.status).toBe(503);
    expect(mockedCaptureMessage).toHaveBeenCalled();
  });

  it("passes through unauthenticated outside production when the secret isn't configured (local dev)", async () => {
    delete process.env.MESAJ_WEBHOOK_SECRET;
    vi.stubEnv("NODE_ENV", "test");
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(PENDING_ROW as never);

    const res = await POST(webhookRequest(payload()));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/mesaj/webhook — payload handling", () => {
  it("returns 400 for a malformed body", async () => {
    const req = new NextRequest("https://example.test/api/mesaj/webhook?secret=test-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("regression test: SMS_SENT (status SENT) must NOT be treated as FAILED — this exact bug already shipped once", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(PENDING_ROW as never);

    const res = await POST(webhookRequest(payload({ event: "SMS_SENT", status: "SENT" }), "?secret=test-secret"));
    const json = await res.json();

    expect(json).toEqual(expect.objectContaining({ matched: true, terminal: false }));
    expect(mockedPrisma.messageRecipient.update).not.toHaveBeenCalled();
  });

  it("maps DELIVERED to a terminal update with deliveredAt set", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(PENDING_ROW as never);

    await POST(webhookRequest(payload({ status: "DELIVERED", dateTimeDelivered: 1785930037492 }), "?secret=test-secret"));

    expect(mockedPrisma.messageRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "recipient-1" },
        data: expect.objectContaining({ deliveryStatus: "DELIVERED", failedAt: null }),
      })
    );
  });

  it("maps an unrecognized terminal status (e.g. UNDELIVERED) to FAILED", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(PENDING_ROW as never);

    await POST(webhookRequest(payload({ status: "UNDELIVERED" }), "?secret=test-secret"));

    expect(mockedPrisma.messageRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliveryStatus: "FAILED" }) })
    );
  });

  it("matches primarily by mesajReference, not the fallback", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(PENDING_ROW as never);

    await POST(webhookRequest(payload({ reference: "ref-1" }), "?secret=test-secret"));

    expect(mockedPrisma.messageRecipient.findUnique).toHaveBeenCalledWith({ where: { mesajReference: "ref-1" } });
    expect(mockedPrisma.messageRecipient.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to (phoneNumber, shortCode, PENDING) when no reference match exists", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue(null);
    mockedPrisma.messageRecipient.findFirst.mockResolvedValue(PENDING_ROW as never);

    const res = await POST(webhookRequest(payload({ reference: "unknown-ref" }), "?secret=test-secret"));
    const json = await res.json();

    expect(mockedPrisma.messageRecipient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phoneNumber: "2347041748361", shortcodeUsed: "NEKINGXS", deliveryStatus: "PENDING" } })
    );
    expect(json.matched).toBe(true);
  });

  it("acknowledges with matched:false and logs to Sentry when no row matches at all", async () => {
    const res = await POST(webhookRequest(payload({ reference: "nobody-has-this" }), "?secret=test-secret"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.matched).toBe(false);
    expect(mockedCaptureMessage).toHaveBeenCalled();
    expect(mockedPrisma.messageRecipient.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/mesaj/webhook — downgrade guard", () => {
  it("ignores a conflicting terminal event when the row is already terminal, and logs it", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue({
      ...PENDING_ROW,
      deliveryStatus: "DELIVERED",
    } as never);

    const res = await POST(webhookRequest(payload({ status: "FAILED" }), "?secret=test-secret"));
    const json = await res.json();

    expect(json).toEqual(expect.objectContaining({ terminal: true, applied: false }));
    expect(mockedPrisma.messageRecipient.update).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("conflicting"),
      expect.anything()
    );
  });

  it("no-ops on a true duplicate (same terminal status arriving twice) without logging", async () => {
    mockedPrisma.messageRecipient.findUnique.mockResolvedValue({
      ...PENDING_ROW,
      deliveryStatus: "DELIVERED",
    } as never);

    const res = await POST(webhookRequest(payload({ status: "DELIVERED" }), "?secret=test-secret"));
    const json = await res.json();

    expect(json).toEqual(expect.objectContaining({ terminal: true, applied: false }));
    expect(mockedPrisma.messageRecipient.update).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });
});
