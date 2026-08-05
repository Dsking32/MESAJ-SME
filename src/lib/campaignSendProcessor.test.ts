import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("./prisma", () => ({
  prisma: {
    campaign: { findUnique: vi.fn(), update: vi.fn() },
    campaignCarrierBatch: { create: vi.fn(), update: vi.fn() },
    messageRecipient: { count: vi.fn() },
    tenant: { update: vi.fn() },
    walletTransaction: { create: vi.fn() },
  },
}));
vi.mock("./mesajClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mesajClient")>();
  return { ...actual, sendCampaignAcrossCarriers: vi.fn() };
});
vi.mock("./notifications", () => ({
  notifyCampaignSent: vi.fn(),
}));
vi.mock("./messageRecipients", () => ({
  recordMessageRecipients: vi.fn(),
}));

import { processNextCampaignBatch, computeEligibleCarrierBatches } from "./campaignSendProcessor";
import { prisma } from "./prisma";
import { sendCampaignAcrossCarriers } from "./mesajClient";
import { notifyCampaignSent } from "./notifications";
import { recordMessageRecipients } from "./messageRecipients";
import * as Sentry from "@sentry/nextjs";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedSend = vi.mocked(sendCampaignAcrossCarriers);
const mockedNotify = vi.mocked(notifyCampaignSent);
const mockedRecordRecipients = vi.mocked(recordMessageRecipients);
const mockedCaptureException = vi.mocked(Sentry.captureException);
const mockedCaptureMessage = vi.mocked(Sentry.captureMessage);

const TENANT = { id: "tenant-1", contactEmail: "biz@example.test", businessName: "Biz Co" };

function carrierStatus(carrier: string, overrides: Partial<{ status: string; approvedShortcode: string | null }> = {}) {
  return { carrier, status: "APPROVED", approvedShortcode: `${carrier}-CODE`, ...overrides };
}

function baseCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "campaign-1",
    tenantId: "tenant-1",
    status: "APPROVED",
    messageBody: "20% off!",
    recipientCount: 4,
    validatedNumbersJson: JSON.stringify({
      MTN: ["234800000001", "234800000002"],
      AIRTEL: ["234800000003", "234800000004"],
      GLO: [],
      MOBILE9: [],
    }),
    tenant: TENANT,
    senderId: { carrierStatuses: [carrierStatus("MTN"), carrierStatus("AIRTEL")] },
    carrierBatches: [],
    ...overrides,
  };
}

function fullSuccessResult(carrier: string, shortCode: string, recipients: string[]) {
  return {
    carrier,
    shortCode,
    recipientCount: recipients.length,
    result: {
      success: true,
      raw: { ok: true },
      sentRecipients: recipients,
      failedRecipients: [],
      recipientResults: recipients.map((phoneNumber) => ({ phoneNumber, accepted: true, reference: `ref-${phoneNumber}` })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.campaignCarrierBatch.create.mockImplementation(
    (async ({ data }: { data: { carrier: string; [key: string]: unknown } }) => ({
      id: `batch-${data.carrier}`,
      ...data,
    })) as unknown as typeof prisma.campaignCarrierBatch.create
  );
  mockedPrisma.campaignCarrierBatch.update.mockImplementation(
    (async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })) as unknown as typeof prisma.campaignCarrierBatch.update
  );
  global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
});

describe("computeEligibleCarrierBatches", () => {
  it("includes only carriers that are APPROVED, have a shortcode, and have validated recipients", () => {
    const campaign = baseCampaign({
      senderId: {
        carrierStatuses: [
          carrierStatus("MTN"),
          carrierStatus("AIRTEL", { status: "PENDING" }),
          carrierStatus("GLO", { approvedShortcode: null }),
          carrierStatus("MOBILE9"), // approved, but zero validated recipients per validatedNumbersJson above
        ],
      },
    });

    const result = computeEligibleCarrierBatches(campaign as never);

    expect(result.map((b) => b.carrier)).toEqual(["MTN"]);
  });
});

describe("processNextCampaignBatch", () => {
  it("is a no-op when the campaign doesn't exist", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(null);

    await processNextCampaignBatch("missing");

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("is a no-op when the campaign isn't APPROVED (already finalized, or not there yet)", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(baseCampaign({ status: "SENT" }) as never);

    await processNextCampaignBatch("campaign-1");

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("processes one carrier, then triggers the next hop via an internal fetch when more remain", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(baseCampaign() as never);
    mockedSend.mockResolvedValue([fullSuccessResult("MTN", "MTN-CODE", ["234800000001", "234800000002"])] as never);

    await processNextCampaignBatch("campaign-1");

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledWith("20% off!", [
      expect.objectContaining({ carrier: "MTN", shortCode: "MTN-CODE" }),
    ]);
    expect(mockedPrisma.campaignCarrierBatch.create).toHaveBeenCalledTimes(1);
    expect(mockedRecordRecipients).toHaveBeenCalledTimes(1);
    // Two carriers total, one just processed -> one remains -> should
    // trigger the next hop rather than finalize.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/internal/campaigns/process-send"),
      expect.objectContaining({ method: "POST" })
    );
    expect(mockedPrisma.campaign.update).not.toHaveBeenCalled();
  });

  it("skips carriers that already have a batch row (resumability)", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(
      baseCampaign({ carrierBatches: [{ carrier: "MTN" }] }) as never
    );
    mockedSend.mockResolvedValue([fullSuccessResult("AIRTEL", "AIRTEL-CODE", ["234800000003", "234800000004"])] as never);

    await processNextCampaignBatch("campaign-1");

    expect(mockedSend).toHaveBeenCalledWith("20% off!", [
      expect.objectContaining({ carrier: "AIRTEL" }),
    ]);
  });

  it("finalizes as SENT with no refund when every carrier fully succeeded", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(
      baseCampaign({ carrierBatches: [{ carrier: "MTN" }] }) as never // only AIRTEL remains -> last hop
    );
    mockedSend.mockResolvedValue([fullSuccessResult("AIRTEL", "AIRTEL-CODE", ["234800000003", "234800000004"])] as never);
    mockedPrisma.messageRecipient.count.mockResolvedValue(4); // all 4 recipients accepted across both carriers

    await processNextCampaignBatch("campaign-1");

    expect(mockedPrisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SENT" } })
    );
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
    expect(mockedPrisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(mockedNotify).toHaveBeenCalledWith(expect.objectContaining({ totalSent: 4, refundedAmount: 0 }));
  });

  it("refunds the shortfall exactly once when some recipients were never accepted", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(
      baseCampaign({ carrierBatches: [{ carrier: "MTN" }] }) as never
    );
    mockedSend.mockResolvedValue([fullSuccessResult("AIRTEL", "AIRTEL-CODE", ["234800000003", "234800000004"])] as never);
    // Only 3 of the campaign's 4 reserved recipients actually got accepted.
    mockedPrisma.messageRecipient.count.mockResolvedValue(3);

    await processNextCampaignBatch("campaign-1");

    expect(mockedPrisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { walletBalance: { increment: expect.any(Number) } } })
    );
    expect(mockedPrisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "REFUND", tenantId: "tenant-1" }) })
    );
  });

  it("finalizes as FAILED and captures a Sentry message when totalSent is zero", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(
      baseCampaign({ carrierBatches: [{ carrier: "MTN" }] }) as never
    );
    mockedSend.mockResolvedValue([fullSuccessResult("AIRTEL", "AIRTEL-CODE", ["234800000003", "234800000004"])] as never);
    mockedPrisma.messageRecipient.count.mockResolvedValue(0);

    await processNextCampaignBatch("campaign-1");

    expect(mockedPrisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } })
    );
    expect(mockedCaptureMessage).toHaveBeenCalled();
  });

  it("claims the carrier as PENDING before sending, then updates it to FAILED when the send throws outright, and still continues the chain", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(baseCampaign() as never);
    mockedSend.mockRejectedValue(new Error("MESAJ_API_TOKEN missing"));

    await processNextCampaignBatch("campaign-1");

    // The claim happens before the send is even attempted — this is what
    // makes the CampaignCarrierBatch(campaignId, carrier) unique
    // constraint actually prevent a double-send, not just a double DB row.
    expect(mockedPrisma.campaignCarrierBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ carrier: "MTN", mesajResponseStatus: "PENDING", sentAt: null }),
      })
    );
    expect(mockedCaptureException).toHaveBeenCalled();
    expect(mockedPrisma.campaignCarrierBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mesajResponseStatus: "FAILED", sentAt: null }),
      })
    );
    // No immediate wallet touch for the thrown carrier — refund happens
    // once, at finalize, based on persisted MessageRecipient rows.
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
    // Two carriers total, one just handled (via the throw path) -> one
    // remains -> chain continues.
    expect(global.fetch).toHaveBeenCalled();
  });

  it("does not call Mesaj at all when claiming the carrier loses the unique-constraint race (another invocation already has it)", async () => {
    mockedPrisma.campaign.findUnique.mockResolvedValue(baseCampaign() as never);
    mockedPrisma.campaignCarrierBatch.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    await processNextCampaignBatch("campaign-1");

    // This is the actual guarantee the fix provides: a lost claim race
    // must stop BEFORE the real send, since sendCampaignAcrossCarriers
    // triggers a genuine SMS through Mesaj — a duplicate call there costs
    // real money and sends a real duplicate text, and can't be undone by
    // anything that happens afterward.
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedPrisma.campaignCarrierBatch.update).not.toHaveBeenCalled();
    expect(mockedCaptureException).not.toHaveBeenCalled();
  });

  it("swallows an unexpected top-level error (e.g. a DB read failure) without touching campaign status or the wallet", async () => {
    mockedPrisma.campaign.findUnique.mockRejectedValue(new Error("connection reset"));

    await expect(processNextCampaignBatch("campaign-1")).resolves.toBeUndefined();

    expect(mockedCaptureException).toHaveBeenCalled();
    expect(mockedPrisma.campaign.update).not.toHaveBeenCalled();
    expect(mockedPrisma.tenant.update).not.toHaveBeenCalled();
  });
});
