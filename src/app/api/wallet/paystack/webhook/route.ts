import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { PRICE_PER_SMS } from "@/lib/pricing";
import { isUniqueConstraintViolation } from "@/lib/prismaErrors";

/**
 * POST /api/wallet/paystack/webhook
 *
 * Paystack calls this on payment events. We verify the signature, then on
 * a successful "charge.success" event, credit the tenant's wallet. This is
 * the "automatic" funding path described in the development guide — manual
 * admin adjustments are a separate flow (see WalletTransaction.type MANUAL_ADJUST).
 *
 * Configure this URL in the Paystack dashboard:
 *   https://<your-domain>/api/wallet/paystack/webhook
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");

  const expectedSignature = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY ?? "")
    .update(rawBody)
    .digest("hex");

  // Timing-safe comparison — a plain `!==` string check leaks how many
  // leading bytes matched via response-time differences. timingSafeEqual
  // requires equal-length buffers, so guard that first (a missing/malformed
  // header is just an invalid signature, not a crash).
  const signatureBuffer = Buffer.from(signature ?? "", "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const signatureValid =
    signatureBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!signatureValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  interface PaystackChargeEvent {
    event?: string;
    data: { metadata?: { tenantId?: string }; amount: number; reference: string };
  }

  let event: PaystackChargeEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    // Signature already verified above, so this would mean Paystack sent a
    // body that doesn't parse as JSON — not something retrying will fix.
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  if (event.event === "charge.success") {
    const { metadata, amount, reference } = event.data;
    const tenantId = metadata?.tenantId;
    const amountNaira = amount / 100;

    if (tenantId) {
      // Idempotency guard: `paymentReference` has a DB-level unique
      // constraint (see prisma/migrations/..._wallet_transaction_payment_
      // reference_unique). We no longer check-then-insert — a findFirst
      // followed by a create has a race window where two concurrent
      // deliveries for the same reference (Paystack does redeliver) could
      // both pass the check before either insert committed, double-crediting
      // the wallet. Instead we just attempt the credit + insert together,
      // and let the unique constraint reject the second one atomically.
      try {
        await prisma.$transaction([
          prisma.tenant.update({
            where: { id: tenantId },
            data: { walletBalance: { increment: amountNaira } },
          }),
          prisma.walletTransaction.create({
            data: {
              tenantId,
              type: "TOPUP",
              amount: amountNaira,
              units: Math.round(amountNaira / PRICE_PER_SMS), // SMS-unit equivalent of this credit, not a mirror of the naira amount
              paymentReference: reference,
            },
          }),
        ]);
      } catch (err) {
        // P2002 = unique constraint violation on paymentReference, i.e. this
        // exact charge was already credited by an earlier delivery of the
        // same event. Both statements in the $transaction roll back
        // together, so the wallet increment above never applies on a
        // duplicate — nothing further to undo here. Any other error should
        // still surface (Paystack will retry on a non-2xx response).
        if (!isUniqueConstraintViolation(err)) {
          throw err;
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
