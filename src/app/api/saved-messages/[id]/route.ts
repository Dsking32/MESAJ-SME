import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { createSavedMessageSchema, parseOrError } from "@/lib/validation";

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
 * PATCH /api/saved-messages/[id]
 * Body: { body: string }
 *
 * Edits a saved message's text in place, so fixing a typo or updating a
 * template doesn't mean delete-and-recreate (which would also lose its
 * original createdAt / position in the list).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const rl = await checkRateLimit(
    `saved-message-create:${user.tenantId}`,
    RATE_LIMITS.SAVED_MESSAGE_CREATE.limit,
    RATE_LIMITS.SAVED_MESSAGE_CREATE.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;

  const bodyJson = await req.json();
  const parsed = parseOrError(createSavedMessageSchema, bodyJson);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const existing = await prisma.savedMessage.findFirst({ where: { id, tenantId: user.tenantId! } });
  if (!existing) {
    return NextResponse.json({ error: "Saved message not found" }, { status: 404 });
  }

  const updated = await prisma.savedMessage.update({
    where: { id },
    data: { body: parsed.data.body },
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/saved-messages/[id]
 *
 * Tenant-scoped: a saved message can only be deleted by a user in the same
 * tenant that created it — checked via the where clause below, not just a
 * findUnique-then-check, so this can't be used to probe whether an id from
 * another tenant exists.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const rl = await checkRateLimit(
    `saved-message-delete:${user.tenantId}`,
    RATE_LIMITS.SAVED_MESSAGE_DELETE.limit,
    RATE_LIMITS.SAVED_MESSAGE_DELETE.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;

  const result = await prisma.savedMessage.deleteMany({
    where: { id, tenantId: user.tenantId! },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Saved message not found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
