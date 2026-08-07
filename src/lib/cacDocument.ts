/**
 * Shared helpers for the CAC document that must accompany a Sender ID
 * request. Kept separate from the route handlers so the upload path
 * (POST /api/sender-id/request) and the admin download path
 * (GET /api/admin/sender-id/[id]/cac-document) build the same object path
 * and talk to the same bucket, rather than two independently-typed copies
 * drifting out of sync.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { CAC_DOCUMENT_ALLOWED_TYPES, CAC_DOCUMENT_MAX_BYTES } from "@/lib/limits";

export const CAC_DOCUMENT_BUCKET = "cac-documents";

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Validates a File pulled off incoming FormData. Returns an error message
 * (safe to send straight back to the client) or null if it's fine.
 * Deliberately checked server-side even though the form's `accept`
 * attribute already restricts this client-side — that's trivially
 * bypassed by anyone calling the API directly.
 */
export function validateCacDocument(file: File | null): string | null {
  if (!file || file.size === 0) {
    return "A CAC document (image or PDF) is required.";
  }
  if (!CAC_DOCUMENT_ALLOWED_TYPES.includes(file.type as (typeof CAC_DOCUMENT_ALLOWED_TYPES)[number])) {
    return "CAC document must be a JPG, PNG, WEBP, or PDF file.";
  }
  if (file.size > CAC_DOCUMENT_MAX_BYTES) {
    return `CAC document is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max is ${CAC_DOCUMENT_MAX_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

/**
 * Builds the object path a document for this tenant/senderId/file-type
 * would live at — split out from uploadCacDocument so callers (the route's
 * cleanup-on-failure path, in particular) know exactly what to delete
 * without duplicating or guessing the naming scheme.
 */
export function buildCacDocumentPath(params: { tenantId: string; senderIdId: string; contentType: string }): string {
  const extension = EXTENSION_BY_TYPE[params.contentType] ?? "bin";
  return `${params.tenantId}/${params.senderIdId}.${extension}`;
}

/**
 * Uploads an already-validated file to the private bucket, scoped under
 * the tenant so one tenant's documents are never path-adjacent to
 * another's in a way that invites guessing (not that guessing helps
 * without the service-role key, but defense in depth is cheap here).
 * Returns the object path to store on the SenderId row.
 */
export async function uploadCacDocument(params: {
  tenantId: string;
  senderIdId: string;
  file: File;
}): Promise<string> {
  const { tenantId, senderIdId, file } = params;
  const path = buildCacDocumentPath({ tenantId, senderIdId, contentType: file.type });

  const supabase = createAdminClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error } = await supabase.storage.from(CAC_DOCUMENT_BUCKET).upload(path, bytes, {
    contentType: file.type,
    upsert: true, // a re-submitted request for the same senderIdId (rare, but harmless) overwrites rather than erroring
  });

  if (error) {
    throw new Error(`Failed to upload CAC document: ${error.message}`);
  }

  return path;
}

/** Best-effort cleanup if the DB write after a successful upload fails — avoids an orphaned file with no DB row pointing at it. */
export async function deleteCacDocument(path: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase.storage.from(CAC_DOCUMENT_BUCKET).remove([path]);
}

/**
 * Mints a short-lived signed URL for admin viewing/download. Deliberately
 * generated fresh on every request rather than cached or stored — a
 * signed URL is a bearer credential for the file until it expires, so the
 * fewer places it exists and the shorter it lives, the better. 60 seconds
 * is enough time for the browser to follow the redirect and start the
 * download/render; it doesn't need to survive longer than that.
 */
export async function createCacDocumentSignedUrl(path: string): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(CAC_DOCUMENT_BUCKET).createSignedUrl(path, 60);

  if (error || !data) {
    throw new Error(`Failed to create signed URL for CAC document: ${error?.message ?? "unknown error"}`);
  }

  return data.signedUrl;
}
