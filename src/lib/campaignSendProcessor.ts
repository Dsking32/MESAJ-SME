import * as Sentry from "@sentry/nextjs";
import { prisma } from "./prisma";
import { sendCampaignAcrossCarriers, batchStatusFromResult, type CarrierBatchInput } from "./mesajClient";
import type { Carrier } from "./numbers";
import { PRICE_PER_SMS } from "./pricing";
import { notifyCampaignSent } from "./notifications";
import { recordMessageRecipients } from "./messageRecipients";

/**
 * Resumable campaign sending.
 *
 * Replaces the old approach of sending every approved carrier in a single
 * synchronous loop inside the admin's HTTP request — that leaned on
 * Vercel's execution-time limit by design (a campaign with several
 * carriers, each with a large recipient list, could take minutes, all
 * inside one request the admin's browser was waiting on).
 *
 * Instead: each call to processNextCampaignBatch() does AT MOST one
 * carrier's worth of sending, then either triggers the next carrier via a
 * fresh serverless invocation (see triggerNextBatch) or finalizes the
 * campaign if that was the last one. "Which carriers are already done" is
 * derived from which carriers already have a CampaignCarrierBatch row for
 * this campaign — no separate progress column needed, and it's exactly
 * what makes this resumable: calling this function again for a
 * campaign that's already partway done just picks up the next
 * unprocessed carrier, whether that's the normal next hop in the chain or
 * a recovery sweep picking up a stalled one.
 *
 * Callers: the approve route (first carrier, via after()), the internal
 * continuation route (every subsequent carrier), and the recovery cron
 * (any campaign whose chain appears to have stalled).
 */

type CampaignWithSendContext = NonNullable<Awaited<ReturnType<typeof loadCampaignForProcessing>>>;

async function loadCampaignForProcessing(campaignId: string) {
  return prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      tenant: true,
      senderId: { include: { carrierStatuses: true } },
      carrierBatches: true,
    },
  });
}

/**
 * Same carrier-eligibility logic as the old synchronous approve route:
 * only carriers the Sender ID is APPROVED on, with a non-empty validated
 * recipient list, are eligible at all. Then further filtered down to
 * carriers that don't already have a CampaignCarrierBatch row — i.e. the
 * work this specific invocation still needs to do.
 */
/**
 * Which carriers this campaign COULD send to at all: Sender ID approved on
 * that carrier, with a non-empty validated recipient list. Exported
 * separately from computeRemainingBatches so the approve route can run
 * this same check before claiming the campaign, without needing the
 * carrierBatches include (nothing's been sent yet at that point anyway).
 */
export function computeEligibleCarrierBatches(campaign: {
  validatedNumbersJson: string;
  senderId: { carrierStatuses: { carrier: Carrier; status: string; approvedShortcode: string | null }[] };
}): CarrierBatchInput[] {
  const validatedNumbers: Record<Carrier, string[]> = JSON.parse(campaign.validatedNumbersJson);

  const eligible: CarrierBatchInput[] = [];
  for (const carrierStatus of campaign.senderId.carrierStatuses) {
    if (carrierStatus.status !== "APPROVED" || !carrierStatus.approvedShortcode) continue;
    const recipients = validatedNumbers[carrierStatus.carrier] ?? [];
    if (recipients.length === 0) continue;
    eligible.push({ carrier: carrierStatus.carrier, shortCode: carrierStatus.approvedShortcode, recipients });
  }
  return eligible;
}

function computeRemainingBatches(campaign: CampaignWithSendContext): CarrierBatchInput[] {
  const eligible = computeEligibleCarrierBatches(campaign);
  const alreadyProcessed = new Set(campaign.carrierBatches.map((b) => b.carrier));
  return eligible.filter((b) => !alreadyProcessed.has(b.carrier));
}

/**
 * Fires an authenticated internal HTTP request to trigger the next hop —
 * a genuinely fresh serverless invocation with its own full time budget,
 * not just a continued in-process loop. Awaited only long enough for the
 * target route to acknowledge receipt (it schedules its own work via
 * after() and responds immediately) — NOT awaited for that carrier's
 * send to actually finish, which would recreate the exact
 * one-long-request problem this whole design avoids.
 */
async function triggerNextBatch(campaignId: string): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const secret = process.env.CRON_SECRET ?? "";

  try {
    await fetch(`${baseUrl}/api/internal/campaigns/process-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ campaignId }),
    });
  } catch (err) {
    // If this fetch itself fails (network blip, cold start timeout, a
    // deploy landing mid-chain), the chain just stops here — the campaign
    // stays APPROVED with some carriers done and some not. That's exactly
    // the stalled state the recovery cron (process-stuck-campaign-sends)
    // is built to find and resume, so this is deliberately not fatal.
    Sentry.captureException(err, {
      level: "warning",
      tags: { area: "campaign-send-processor" },
      extra: { campaignId, step: "trigger-next-batch" },
    });
  }
}

/**
 * Attempts one carrier's send and records the result. A thrown error here
 * (per mesajClient.ts: missing/invalid MESAJ_API_TOKEN, or any other
 * failure before per-chunk retry logic even runs) means NONE of this
 * carrier's recipients were sent — recorded as a FAILED batch row so it
 * counts as "done" (won't be retried forever) and shows up in the
 * per-carrier breakdown, exactly like a carrier Mesaj itself rejected
 * outright. No wallet refund happens here — see finalizeCampaignSend for
 * why doing it there instead, once, is what avoids a double-refund.
 */
async function processSingleCarrierBatch(campaign: CampaignWithSendContext, next: CarrierBatchInput): Promise<void> {
  let sendResults;
  try {
    sendResults = await sendCampaignAcrossCarriers(campaign.messageBody, [next]);
  } catch (err) {
    Sentry.captureException(err, {
      level: "error",
      tags: { area: "campaign-send-processor" },
      extra: { campaignId: campaign.id, carrier: next.carrier },
    });
    await prisma.campaignCarrierBatch.create({
      data: {
        campaignId: campaign.id,
        carrier: next.carrier,
        shortcodeUsed: next.shortCode,
        recipientCount: next.recipients.length,
        mesajResponseStatus: "FAILED",
        mesajResponseRaw: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        sentAt: null,
      },
    });
    return;
  }

  for (const r of sendResults) {
    const carrierBatch = await prisma.campaignCarrierBatch.create({
      data: {
        campaignId: campaign.id,
        carrier: r.carrier,
        shortcodeUsed: r.shortCode,
        recipientCount: r.recipientCount,
        mesajResponseStatus: batchStatusFromResult(r.result),
        mesajResponseRaw: JSON.stringify(r.result.raw),
        sentAt: new Date(),
      },
    });
    await recordMessageRecipients({
      campaignId: campaign.id,
      carrierBatchId: carrierBatch.id,
      tenantId: campaign.tenantId,
      carrier: r.carrier,
      shortCode: r.shortCode,
      recipientResults: r.result.recipientResults,
    });
  }
}

/**
 * Runs once all carriers have a CampaignCarrierBatch row (whether SUCCESS,
 * PARTIAL, or FAILED — "done" either way). Computes totalSent from
 * persisted MessageRecipient rows rather than from in-memory results,
 * since those results were produced across however many separate
 * invocations this campaign's chain took — there's no single place in
 * memory holding all of them.
 *
 * The refund is computed exactly once, here, as
 * (recipientCount reserved at submit time) - (recipientCount actually
 * sent) — covering every way a shortfall could have happened (a carrier
 * that threw outright, a carrier Mesaj partially rejected, one that fully
 * rejected) in one calculation, regardless of which carriers took the
 * throw path vs the normal path. Doing any refunding earlier, per
 * carrier, would double-count against this.
 */
async function finalizeCampaignSend(campaign: CampaignWithSendContext): Promise<void> {
  const totalSent = await prisma.messageRecipient.count({
    where: { campaignId: campaign.id, gatewayAccepted: true },
  });

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: totalSent > 0 ? "SENT" : "FAILED" },
  });

  if (totalSent === 0) {
    Sentry.captureMessage("Campaign fully failed to send — every carrier batch failed", {
      level: "error",
      extra: { campaignId: campaign.id, tenantId: campaign.tenantId, recipientCount: campaign.recipientCount },
    });
  }

  const reservedCost = campaign.recipientCount * PRICE_PER_SMS;
  const actualCost = totalSent * PRICE_PER_SMS;
  const refund = reservedCost - actualCost;

  if (refund > 0) {
    await prisma.tenant.update({
      where: { id: campaign.tenantId },
      data: { walletBalance: { increment: refund } },
    });
    await prisma.walletTransaction.create({
      data: {
        tenantId: campaign.tenantId,
        type: "REFUND",
        amount: refund,
        units: refund / PRICE_PER_SMS,
      },
    });
  }

  await notifyCampaignSent({
    to: campaign.tenant.contactEmail,
    businessName: campaign.tenant.businessName,
    messageBody: campaign.messageBody,
    recipientCount: campaign.recipientCount,
    totalSent,
    refundedAmount: refund > 0 ? refund : 0,
  });
}

/**
 * The entry point every caller (approve route, internal continuation
 * route, recovery cron) calls the same way. Safe to call more than once
 * for the same campaign — if it's not APPROVED (already SENT/FAILED, or
 * somehow still PENDING_APPROVAL) this is a no-op, which is what makes it
 * safe for the recovery cron to call speculatively on anything that looks
 * stalled without first re-deriving whether it actually still needs work.
 */
export async function processNextCampaignBatch(campaignId: string): Promise<void> {
  try {
    const campaign = await loadCampaignForProcessing(campaignId);
    if (!campaign || campaign.status !== "APPROVED") return;

    const remaining = computeRemainingBatches(campaign);

    if (remaining.length === 0) {
      await finalizeCampaignSend(campaign);
      return;
    }

    await processSingleCarrierBatch(campaign, remaining[0]);

    if (remaining.length > 1) {
      await triggerNextBatch(campaign.id);
    } else {
      const refreshed = await loadCampaignForProcessing(campaignId);
      if (refreshed) await finalizeCampaignSend(refreshed);
    }
  } catch (err) {
    // An unexpected failure OUTSIDE the per-carrier handling above (e.g. a
    // DB hiccup reading the campaign) — deliberately does NOT touch the
    // campaign's status or wallet. Guessing at a refund here could easily
    // be wrong given carriers may have already succeeded in earlier hops;
    // leaving it APPROVED lets the recovery cron retry cleanly instead.
    Sentry.captureException(err, {
      level: "error",
      tags: { area: "campaign-send-processor" },
      extra: { campaignId },
    });
  }
}
