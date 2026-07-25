import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { PRICE_PER_SMS } from "@/lib/pricing";

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

  const event = JSON.parse(rawBody);

  if (event.event === "charge.success") {
    const { metadata, amount, reference } = event.data;
    const tenantId = metadata?.tenantId;
    const amountNaira = amount / 100;

    if (tenantId) {
      // Idempotency guard: skip if we've already recorded this reference.
      const existing = await prisma.walletTransaction.findFirst({
        where: { paymentReference: reference },
      });

      if (!existing) {
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
      }
    }
  }

  return NextResponse.json({ received: true });
}