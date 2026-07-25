import { NextRequest, NextResponse } from "next/server";
import { cleanAndSortNumbers } from "@/lib/numbers";
import { loadCarrierOverrides } from "@/lib/portedNumbers";
import { checkContentLength, checkRecipientCount } from "@/lib/limits";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";

/**
 * POST /api/campaigns/validate-numbers
 * Body: { numbers: string[] }
 *
 * Runs the client's uploaded/entered numbers through cleaning + validation
 * and returns a summary the frontend uses to render the "X numbers were
 * invalid and will be excluded — Agree to proceed?" confirmation pop-up.
 *
 * This does NOT create a campaign yet — it's a pre-check step. The actual
 * validated, carrier-sorted numbers are re-derived server-side again at
 * submit time (see /api/campaigns/submit) rather than trusted from the
 * client, in case the list changes between check and submit.
 *
 * Requires an authenticated session — otherwise this is an open endpoint
 * that runs DB queries (loadCarrierOverrides) off unauthenticated input,
 * inconsistent with every other campaign route.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const rl = await checkRateLimit(
    `validate-numbers:${authUser.id}`,
    RATE_LIMITS.VALIDATE_NUMBERS.limit,
    RATE_LIMITS.VALIDATE_NUMBERS.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const sizeError = checkContentLength(req);
  if (sizeError) {
    return NextResponse.json({ error: sizeError }, { status: 413 });
  }

  const { numbers } = await req.json();

  if (!Array.isArray(numbers)) {
    return NextResponse.json({ error: "numbers must be an array of strings" }, { status: 400 });
  }

  const countError = checkRecipientCount(numbers);
  if (countError) {
    return NextResponse.json({ error: countError }, { status: 400 });
  }

  const overrides = await loadCarrierOverrides(numbers);
  const result = cleanAndSortNumbers(numbers, overrides);

  return NextResponse.json({
    totalInput: result.totalInput,
    totalValid: result.totalValid,
    totalInvalid: result.totalInvalid,
    totalDuplicates: result.totalDuplicates,
    countsByCarrier: {
      MTN: result.validByCarrier.MTN.length,
      AIRTEL: result.validByCarrier.AIRTEL.length,
      GLO: result.validByCarrier.GLO.length,
      MOBILE9: result.validByCarrier.MOBILE9.length,
    },
    invalidSamples: result.invalid.slice(0, 20), // cap payload size for large lists
  });
}
