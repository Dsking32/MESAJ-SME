import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import crypto from "crypto";
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

// Mesaj calls this webhook multiple times over a message's lifecycle —
// e.g. SMS_SENT first ("handed to carrier, outcome unknown yet"), then
// later SMS_DELIVERED or a failure event with the real terminal outcome.
// Our DeliveryStatus enum only models PENDING/DELIVERED/FAILED/EXPIRED —
// there's no "in transit" state — so any non-terminal status (SENT,
// QUEUED, etc.) must be ignored here rather than folded into FAILED.
// Returning null means "no terminal outcome yet, leave the row as PENDING
// and wait for a later webhook call."
function toDeliveryStatus(status: string): "DELIVERED" | "FAILED" | "EXPIRED" | null {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "SENT" || status === "QUEUED" || status === "PENDING") return null;
  return "FAILED"; // covers FAILED, UNDELIVERED, REJECTED, or any status we don't explicitly recognize
}

export async function POST(req: NextRequest) {
  // Mesaj doesn't support a signing scheme or custom headers — it just POSTs
  // directly to whatever URL is configured on their side (confirmed:
  // Mesaj's platform only lets an integrator register a callback URL, no
  // signing option exists to eventually adopt). So the secret has to live
  // IN the URL itself (query string), since that's the only thing
  // guaranteed to come back on every request. The webhook URL configured
  // in Mesaj's dashboard must be:
  //   https://<your-domain>/api/mesaj/webhook?secret=<MESAJ_WEBHOOK_SECRET>
  // Weaker than HMAC signing, but far better than an open endpoint — anyone
  // who doesn't know the secret can't hit this meaningfully. Since this is
  // confirmed permanent (not a stopgap awaiting a future signing scheme),
  // the comparison below is timing-safe — same reasoning as the Paystack
  // webhook's signature check and the internal cron secret: a plain `!==`
  // returns as soon as it finds a mismatched byte, leaking how many
  // leading characters of a guess were correct via response-time
  // differences. In practice this secret's entropy already makes brute
  // force infeasible regardless, but there's no reason not to close this
  // too now that it's not going away.
  const configuredSecret = process.env.MESAJ_WEBHOOK_SECRET;
  if (configuredSecret) {
    const provided = req.nextUrl.searchParams.get("secret") ?? "";
    const providedBuffer = Buffer.from(provided, "utf8");
    const expectedBuffer = Buffer.from(configuredSecret, "utf8");
    const valid =
      providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    if (!valid) {
      return NextResponse.json({ error: "Invalid webhook credentials" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Fail closed in production: an unset secret used to mean "skip the
    // check entirely," which left this endpoint open to anyone who found
    // the URL — they could forge delivery reports and mark any recipient
    // DELIVERED/FAILED at will. validateEnv() already warns about this at
    // boot (see lib/env.ts), but a missed warning shouldn't mean an open
    // webhook. Dev/staging without the var set still passes through
    // unauthenticated so local testing isn't blocked before a secret
    // exists yet.
    Sentry.captureMessage("Mesaj webhook: rejected — MESAJ_WEBHOOK_SECRET not configured in production", {
      level: "error",
    });
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
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

  // Non-terminal status (e.g. SMS_SENT): acknowledge receipt but leave the
  // row as-is. Overwriting it here would clobber whatever terminal status
  // a later webhook call sets, and there's nothing meaningful to record yet.
  if (deliveryStatus === null) {
    return NextResponse.json({ received: true, matched: true, terminal: false });
  }

  // Guard against out-of-order/duplicate terminal events: if this row
  // already has a terminal outcome (DELIVERED/FAILED/EXPIRED) and a new
  // event disagrees with it, don't blindly overwrite. Webhooks aren't
  // guaranteed to arrive in the order the underlying events happened —
  // a delayed/retried FAILED could land after a genuine DELIVERED already
  // did, and silently flipping a correct DELIVERED to FAILED (or the
  // reverse) would corrupt billing/reporting on data that was already
  // right. Same status arriving twice (a true duplicate webhook) is fine
  // to no-op past this guard too, since there's nothing new to write.
  const alreadyTerminal = target.deliveryStatus !== "PENDING";
  if (alreadyTerminal && target.deliveryStatus !== deliveryStatus) {
    Sentry.captureMessage("Mesaj webhook: conflicting terminal status ignored", {
      level: "warning",
      extra: {
        recipientId: target.id,
        existingStatus: target.deliveryStatus,
        incomingStatus: deliveryStatus,
        event: body.event,
      },
    });
    return NextResponse.json({ received: true, matched: true, terminal: true, applied: false });
  }
  if (alreadyTerminal) {
    // Same terminal status arriving again — true duplicate, nothing to do.
    return NextResponse.json({ received: true, matched: true, terminal: true, applied: false });
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

  return NextResponse.json({ received: true, matched: true, terminal: true, applied: true });
}