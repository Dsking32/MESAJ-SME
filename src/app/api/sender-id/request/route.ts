import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { senderIdRequestSchema, parseOrError } from "@/lib/validation";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rateLimit";
import { validateCacDocument, uploadCacDocument, deleteCacDocument, buildCacDocumentPath } from "@/lib/cacDocument";

const CARRIERS = ["MTN", "AIRTEL", "GLO", "MOBILE9"] as const;

/**
 * POST /api/sender-id/request
 * multipart/form-data with fields: requestedName, businessName, cacNumber,
 * sector, cacDocument (File — image or PDF of the CAC certificate).
 *
 * The CAC document is a hard requirement for a Sender ID request — it's
 * what the admin forwards to the telco alongside the request itself (see
 * README "Admin flow"). multipart/form-data instead of JSON because this
 * now includes a file; every other field is validated exactly as before
 * via the same zod schema, just read from FormData instead of a JSON body.
 *
 * Creates a Sender ID request plus a PENDING carrier-status row for each of
 * the 4 telcos. Admin updates each one manually as approvals come back
 * (see /api/admin/sender-id/update-status) — there's no automated telco
 * feed for this in v1.
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
    `sender-id-request:${user.tenantId}`,
    RATE_LIMITS.SENDER_ID_REQUEST.limit,
    RATE_LIMITS.SENDER_ID_REQUEST.windowMs
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a cacDocument file." }, { status: 400 });
  }

  const body = {
    requestedName: formData.get("requestedName"),
    businessName: formData.get("businessName"),
    cacNumber: formData.get("cacNumber"),
    sector: formData.get("sector"),
  };
  const parsed = parseOrError(senderIdRequestSchema, body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { requestedName, businessName, cacNumber, sector } = parsed.data;

  const cacDocumentEntry = formData.get("cacDocument");
  const cacDocument = cacDocumentEntry instanceof File ? cacDocumentEntry : null;
  const fileError = validateCacDocument(cacDocument);
  if (fileError || !cacDocument) {
    return NextResponse.json({ error: fileError ?? "A CAC document (image or PDF) is required." }, { status: 400 });
  }
  const file = cacDocument;

  // Keep the tenant's KYC fields current with what was submitted.
  await prisma.tenant.update({
    where: { id: user.tenantId },
    data: { businessName, cacNumber, sector },
  });

  const senderId = await prisma.senderId.create({
    data: {
      tenantId: user.tenantId,
      requestedName,
      carrierStatuses: {
        create: CARRIERS.map((carrier) => ({ carrier, status: "PENDING" as const })),
      },
    },
    include: { carrierStatuses: true },
  });

  // Upload after the row exists (path is keyed by senderId.id), then attach
  // the path. If this fails, the SenderId request itself still went
  // through — better than losing the whole request over a storage hiccup —
  // but the admin won't have a document to work with, so surface the
  // failure clearly rather than silently returning 201 as if all went well.
  try {
    const path = await uploadCacDocument({ tenantId: user.tenantId, senderIdId: senderId.id, file });
    const updated = await prisma.senderId.update({
      where: { id: senderId.id },
      data: { cacDocumentPath: path, cacDocumentContentType: file.type, cacDocumentUploadedAt: new Date() },
      include: { carrierStatuses: true },
    });
    return NextResponse.json(updated, { status: 201 });
  } catch (err) {
    // Best-effort: if the upload itself succeeded but the DB update after
    // it failed, don't leave an orphaned file with nothing pointing at it.
    // Deleting a path that was never actually written (upload itself
    // failed) is a harmless no-op — Storage's remove() doesn't error on a
    // missing key.
    const attemptedPath = buildCacDocumentPath({ tenantId: user.tenantId, senderIdId: senderId.id, contentType: file.type });
    await deleteCacDocument(attemptedPath).catch(() => {});
    return NextResponse.json(
      {
        error: "Sender ID request was created, but the CAC document failed to upload. Please contact support.",
        senderIdId: senderId.id,
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
