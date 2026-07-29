/**
 * Persists per-recipient MessageRecipient rows from a Mesaj send result.
 * Shared by both send paths (client campaign approval and admin-initiated
 * send) so the delivery-report pipeline is populated identically either
 * way. See prisma/schema.prisma MessageRecipient doc for the matching
 * strategy this feeds (mesajReference from the send response, later
 * matched against Mesaj's delivery webhook).
 */

import { prisma } from "./prisma";
import type { Carrier } from "./numbers";
import type { RecipientSendResult } from "./mesajClient";

export async function recordMessageRecipients(params: {
  campaignId: string;
  carrierBatchId: string;
  tenantId: string;
  carrier: Carrier;
  shortCode: string;
  recipientResults: RecipientSendResult[];
}) {
  const { campaignId, carrierBatchId, tenantId, carrier, shortCode, recipientResults } = params;

  if (recipientResults.length === 0) return;

  await prisma.messageRecipient.createMany({
    data: recipientResults.map((r) => ({
      campaignId,
      carrierBatchId,
      tenantId,
      phoneNumber: r.phoneNumber,
      carrier,
      shortcodeUsed: shortCode,
      mesajReference: r.reference,
      gatewayAccepted: r.accepted,
      // Only an accepted recipient can ever get a real delivery webhook —
      // a recipient the gateway itself rejected has no DELIVERED/FAILED
      // status coming later, so it's marked FAILED immediately rather than
      // sitting in PENDING forever waiting for an event that won't arrive.
      deliveryStatus: r.accepted ? "PENDING" : "FAILED",
    })),
    // mesajReference has a unique constraint; skip rather than throw if a
    // retry/duplicate send somehow re-submits the exact same reference.
    skipDuplicates: true,
  });
}
