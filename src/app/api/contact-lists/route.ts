import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { checkContentLength, checkContactListSize } from "@/lib/limits";
import { createContactListSchema, parseOrError } from "@/lib/validation";
import { cleanAndSortNumbers } from "@/lib/numbers";
import { loadCarrierOverrides } from "@/lib/portedNumbers";

async function requireTenantUser() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return null;

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) return null;
  return user;
}

/**
 * GET /api/contact-lists — list the caller's tenant's saved contact lists
 * with a contact count each (not the full numbers — see
 * GET /api/contact-lists/[id] for that, fetched only when a list is
 * actually loaded into a compose form).
 */
export async function GET() {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const lists = await prisma.contactList.findMany({
    where: { tenantId: user.tenantId! },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { contacts: true } } },
  });

  return NextResponse.json(
    lists.map((l) => ({ id: l.id, name: l.name, createdAt: l.createdAt, contactCount: l._count.contacts }))
  );
}

/**
 * POST /api/contact-lists
 * Body: { name: string, numbers: string[] }
 *
 * Numbers are cleaned/validated/deduped exactly like a campaign submission
 * (see lib/numbers.ts + lib/portedNumbers.ts) — only valid, deduplicated
 * numbers are actually saved. Invalid numbers are silently dropped rather
 * than blocking the save, since the list is re-validated again anyway the
 * next time it's loaded into a campaign; the response tells the caller how
 * many were skipped so the UI can surface that.
 */
export async function POST(req: NextRequest) {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const rl = await checkRateLimit(
    `contact-list-create:${user.tenantId}`,
    RATE_LIMITS.CONTACT_LIST_CREATE.limit,
    RATE_LIMITS.CONTACT_LIST_CREATE.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const sizeError = checkContentLength(req);
  if (sizeError) return NextResponse.json({ error: sizeError }, { status: 413 });

  const body = await req.json();
  const parsed = parseOrError(createContactListSchema, body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { name, numbers } = parsed.data;

  const countError = checkContactListSize(numbers);
  if (countError) return NextResponse.json({ error: countError }, { status: 400 });

  const overrides = await loadCarrierOverrides(numbers);
  const cleaned = cleanAndSortNumbers(numbers, overrides);

  const flatValidNumbers = Object.entries(cleaned.validByCarrier).flatMap(([carrier, nums]) =>
    nums.map((phoneNumber) => ({ phoneNumber, carrier: carrier as "MTN" | "AIRTEL" | "GLO" | "MOBILE9" }))
  );

  if (flatValidNumbers.length === 0) {
    return NextResponse.json(
      { error: "None of the numbers provided were valid — nothing was saved." },
      { status: 400 }
    );
  }

  const list = await prisma.contactList.create({
    data: {
      tenantId: user.tenantId!,
      name,
      contacts: { createMany: { data: flatValidNumbers } },
    },
    include: { _count: { select: { contacts: true } } },
  });

  return NextResponse.json(
    {
      id: list.id,
      name: list.name,
      createdAt: list.createdAt,
      contactCount: list._count.contacts,
      totalInput: cleaned.totalInput,
      totalInvalid: cleaned.totalInvalid,
      totalDuplicates: cleaned.totalDuplicates,
    },
    { status: 201 }
  );
}
