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
 * GET /api/saved-messages — list the caller's tenant's saved message
 * bodies, most recent first. Capped at 100 — this is a quick-reuse list
 * for composing, not an archive; a tenant hitting that ceiling should be
 * deleting old ones, not scrolling through hundreds.
 */
export async function GET() {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const messages = await prisma.savedMessage.findMany({
    where: { tenantId: user.tenantId! },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json(messages);
}

/**
 * POST /api/saved-messages
 * Body: { body: string }
 */
export async function POST(req: NextRequest) {
  const user = await requireTenantUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const rl = await checkRateLimit(
    `saved-message-create:${user.tenantId}`,
    RATE_LIMITS.SAVED_MESSAGE_CREATE.limit,
    RATE_LIMITS.SAVED_MESSAGE_CREATE.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = await req.json();
  const parsed = parseOrError(createSavedMessageSchema, body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const saved = await prisma.savedMessage.create({
    data: { tenantId: user.tenantId!, body: parsed.data.body },
  });

  return NextResponse.json(saved, { status: 201 });
}
