import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/adminAuth";
import { createCacDocumentSignedUrl } from "@/lib/cacDocument";

/**
 * GET /api/admin/sender-id/[id]/cac-document
 *
 * Admin-only. Looks up the SenderId's stored document path, mints a
 * fresh 60-second signed URL (see lib/cacDocument.ts for why it's minted
 * per-request rather than cached), and redirects to it — so an admin
 * clicking "View CAC document" gets the file directly, but nothing
 * long-lived or reusable ends up embedded in the admin page's HTML.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const senderId = await prisma.senderId.findUnique({
    where: { id },
    select: { cacDocumentPath: true },
  });

  if (!senderId) {
    return NextResponse.json({ error: "Sender ID request not found" }, { status: 404 });
  }
  if (!senderId.cacDocumentPath) {
    return NextResponse.json({ error: "No CAC document was uploaded with this request" }, { status: 404 });
  }

  try {
    const signedUrl = await createCacDocumentSignedUrl(senderId.cacDocumentPath);
    return NextResponse.redirect(signedUrl);
  } catch (err) {
    return NextResponse.json(
      { error: "Could not generate a link for this document", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
