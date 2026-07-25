import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { checkContentLength, checkContactListSize } from "@/lib/limits";
import { cleanAndSortNumbers } from "@/lib/numbers";
import { loadCarrierOverrides } from "@/lib/portedNumbers";
import { z } from "zod";

const appendContactsSchema = z.object({
  numbers: z.array(z.string()).min(1, "Add at least one number"),
});

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
 * GET /api/contact-lists/[id]
 *
 * Returns the list's contacts (phone number + carrier), capped at 5,000 in
 * the response so a huge list doesn't blow up either caller — the compose
 * picker (which just needs the numbers) or the list detail page (which
 * renders them as a table). Campaigns beyond that size should be built
 * from a fresh CSV upload rather than a saved list at that scale.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;

  const list = await prisma.contactList.findFirst({
    where: { id, tenantId: user.tenantId! },
    include: {
      contacts: { orderBy: { createdAt: "asc" }, take: 5000 },
      _count: { select: { contacts: true } },
    },
  });

  if (!list) {
    return NextResponse.json({ error: "Contact list not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: list.id,
    name: list.name,
    createdAt: list.createdAt,
    contactCount: list._count.contacts,
    truncated: list._count.contacts > list.contacts.length,
    contacts: list.contacts.map((c) => ({ id: c.id, phoneNumber: c.phoneNumber, carrier: c.carrier })),
  });
}

/**
 * PATCH /api/contact-lists/[id]
 * Body: { numbers: string[] }
 *
 * Appends more contacts to an existing list instead of forcing a whole new
 * list for a handful of additional numbers. Runs the same clean/validate
 * pass as creating a list, then also drops anything that's already in
 * this specific list (phoneNumber has no DB-level unique constraint —
 * dedup here is app-level, scoped to this list, not global).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;

  const existingList = await prisma.contactList.findFirst({
    where: { id, tenantId: user.tenantId! },
    include: { contacts: { select: { phoneNumber: true } }, _count: { select: { contacts: true } } },
  });
  if (!existingList) {
    return NextResponse.json({ error: "Contact list not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = appendContactsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { numbers } = parsed.data;

  const countError = checkContactListSize(numbers);
  if (countError) return NextResponse.json({ error: countError }, { status: 400 });

  const overrides = await loadCarrierOverrides(numbers);
  const cleaned = cleanAndSortNumbers(numbers, overrides);

  const alreadyInList = new Set(existingList.contacts.map((c) => c.phoneNumber));
  const newContacts = Object.entries(cleaned.validByCarrier).flatMap(([carrier, nums]) =>
    nums
      .filter((phoneNumber) => !alreadyInList.has(phoneNumber))
      .map((phoneNumber) => ({ phoneNumber, carrier: carrier as "MTN" | "AIRTEL" | "GLO" | "MOBILE9" }))
  );
  const totalAlreadyInList = cleaned.totalValid - newContacts.length;

  if (newContacts.length > 0) {
    await prisma.contact.createMany({ data: newContacts.map((c) => ({ ...c, contactListId: id })) });
  }

  const updated = await prisma.contactList.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { contacts: true } } },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    contactCount: updated._count.contacts,
    added: newContacts.length,
    totalInput: cleaned.totalInput,
    totalInvalid: cleaned.totalInvalid,
    totalDuplicates: cleaned.totalDuplicates,
    totalAlreadyInList,
  });
}

/**
 * DELETE /api/contact-lists/[id]
 *
 * Deletes the list's contacts first, then the list itself, in a
 * transaction — there's no DB-level cascade on the Contact -> ContactList
 * foreign key (see prisma/schema.prisma), so deleting the parent first
 * would fail on the FK constraint. The transaction keeps the two deletes
 * atomic rather than risking an orphaned list with a failed contacts
 * delete, or vice versa.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const rl = await checkRateLimit(
    `contact-list-delete:${user.tenantId}`,
    RATE_LIMITS.CONTACT_LIST_DELETE.limit,
    RATE_LIMITS.CONTACT_LIST_DELETE.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;

  const list = await prisma.contactList.findFirst({ where: { id, tenantId: user.tenantId! } });
  if (!list) {
    return NextResponse.json({ error: "Contact list not found" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.contact.deleteMany({ where: { contactListId: id } }),
    prisma.contactList.delete({ where: { id } }),
  ]);

  return NextResponse.json({ deleted: true });
}
