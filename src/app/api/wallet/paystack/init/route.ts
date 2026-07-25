import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/wallet/paystack/init
 * Body: { amountNaira: number }
 *
 * Initializes a Paystack transaction and returns the authorization_url for
 * the client to complete payment. Wallet is credited on confirmed webhook
 * (see /api/wallet/paystack/webhook), not here — never trust the client
 * redirect alone to confirm payment.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user || !user.tenantId) {
    return NextResponse.json({ error: "No tenant associated with this user" }, { status: 400 });
  }

  const rl = await checkRateLimit(
    `wallet-topup-init:${user.tenantId}`,
    RATE_LIMITS.WALLET_TOPUP_INIT.limit,
    RATE_LIMITS.WALLET_TOPUP_INIT.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { amountNaira } = await req.json();
  if (!amountNaira || amountNaira <= 0) {
    return NextResponse.json({ error: "amountNaira must be a positive number" }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: tenant.contactEmail,
      amount: amountNaira * 100, // Paystack expects kobo
      metadata: { tenantId: tenant.id },
      callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet`,
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.status) {
    return NextResponse.json({ error: "Failed to initialize Paystack transaction" }, { status: 502 });
  }

  return NextResponse.json({
    authorizationUrl: data.data.authorization_url,
    reference: data.data.reference,
  });
}
