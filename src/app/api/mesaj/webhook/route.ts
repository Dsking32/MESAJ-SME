import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/mesaj/webhook
 *
 * Mesaj is our single direct upstream client relationship — every tenant's
 * traffic goes through our one MESAJ_API_TOKEN, so this is the one shared
 * webhook URL for delivery events across ALL tenants. Attribution back to
 * the right tenant/campaign happens entirely through the MessageRecipient
 * row we created at send time (see lib/messageRecipients.ts), matched here
 * by `mesajReference` — never trust anything in this payload to say which
 * tenant it belongs to.
 *
 * Sample payload (confirmed from Mesaj, 2026-07-28):
 * {
 *   "data": {
 *     "error": null, "amount": 5.5, "status": "DELIVERED",
 *     "message": "...", "clientId": "...", "errorCode": "",
 *     "messageId": "...",      // NOT unique per recipient — shared across
 *                               // an entire send request, do not match on this
 *     "recipient": "2349060594869",
 *     "reference": "...",      // per-recipient — this is what we match on
 *     "shortCode": "TURNAJFLEX",
 *     "dateTimeSent": 1761152074735,
 *     "errorMessage": "",
 *     "transactionId": "...",  // observed identical to `reference` so far
 *     "dateTimeFailed": null,
 *     "dateTimeDelivered": 1761135881000
 *   },
 *   "event": "SMS_DELIVERED",
 *   "timestamp": "..."
 * }
 *
 * Configure this URL with Mesaj as your delivery-report webhook endpoint.
 */

interface MesajWebhookPayload {
  event: string;
  data: {
    status: string;
    recipient: string;
    shortCode: string;
    reference: string;
    transactionId: string;
    messageId: string;
    errorCode: string | null;
    errorMessage: string | null;
    dateTimeDelivered: number | null;
    dateTimeFailed: number | null;
  };
}

function toDeliveryStatus(status: string): "DELIVERED" | "FAILED" | "EXPIRED" {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "EXPIRED") return "EXPIRED";
  return "FAILED"; // covers FAILED, UNDELIVERED, or any status we don't explicitly recognize
}

export async function POST(req: NextRequest) {
  // TODO: confirm the actual auth scheme with Mesaj (signed header? shared
  // secret in a query param? IP allowlist?) and replace this placeholder.
  // As written, this only checks a shared secret if one is configured —
  // NOT safe to rely on for production until confirmed with Mesaj.
  const configuredSecret = process.env.MESAJ_WEBHOOK_SECRET;
  if (configuredSecret) {
    const provided = req.headers.get("x-webhook-secret");
    if (provided !== configuredSecret) {
      return NextResponse.json({ error: "Invalid webhook credentials" }, { status: 401 });
    }
  }

  const body = (await req.json().catch(() => null)) as MesajWebhookPayload | null;
  if (!body?.data) {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  const { status, recipient, shortCode, reference, transactionId } = body.data;
  const matchReference = reference || transactionId;
  const deliveryStatus = toDeliveryStatus(status);

  // Primary match: mesajReference, set at send time from the per-recipient
  // response entry. Falls back to (phoneNumber, shortcodeUsed, PENDING) —
  // oldest match first — for the rare case a row's reference didn't get
  // captured at send time (see parseSendResponse in lib/mesajClient.ts).
  const match = matchReference
    ? await prisma.messageRecipient.findUnique({ where: { mesajReference: matchReference } })
    : null;

  const fallbackMatch =
    !match && recipient && shortCode
      ? await prisma.messageRecipient.findFirst({
          where: { phoneNumber: recipient, shortcodeUsed: shortCode, deliveryStatus: "PENDING" },
          orderBy: { createdAt: "asc" },
        })
      : null;

  const target = match ?? fallbackMatch;

  if (!target) {
    // Not necessarily a bug — could be a duplicate webhook delivery for an
    // already-terminal row, or a payload for a send this app didn't
    // originate. Worth visibility either way rather than a silent 200.
    Sentry.captureMessage("Mesaj webhook: no matching MessageRecipient found", {
      level: "warning",
      extra: { event: body.event, recipient, shortCode, reference: matchReference },
    });
    return NextResponse.json({ received: true, matched: false });
  }

  await prisma.messageRecipient.update({
    where: { id: target.id },
    data: {
      deliveryStatus,
      mesajReference: target.mesajReference ?? matchReference ?? undefined,
      errorCode: body.data.errorCode || null,
      errorMessage: body.data.errorMessage || null,
      deliveredAt: body.data.dateTimeDelivered ? new Date(body.data.dateTimeDelivered) : null,
      failedAt:
        deliveryStatus !== "DELIVERED"
          ? body.data.dateTimeFailed
            ? new Date(body.data.dateTimeFailed)
            : new Date()
          : null,
    },
  });

  return NextResponse.json({ received: true, matched: true });
}
