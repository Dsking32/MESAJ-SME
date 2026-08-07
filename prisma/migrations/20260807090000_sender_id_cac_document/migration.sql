-- Sender ID requests now require a CAC document upload (the certificate
-- clients send to prove the business is registered, which the admin then
-- forwards to the telco alongside the Sender ID request itself — this was
-- already a manual step outside the app, now it's part of the request).
--
-- WHERE THE FILE ITSELF LIVES
-- Not in Postgres — it goes to a private Supabase Storage bucket,
-- `cac-documents`, created below. This table only stores the object path
-- (see SenderId.cacDocumentPath in schema.prisma), never the file bytes
-- and never a public URL. Admin access goes through a signed URL minted
-- on demand by /api/admin/sender-id/[id]/cac-document using the service
-- role key — same "server-side privileged access, nothing public" shape
-- as everything else in this app.
--
-- WHY NULLABLE
-- Existing SenderId rows predate this requirement and have no document —
-- backfilling isn't possible (the files were never collected). New
-- requests are required to include one at the application layer (see
-- src/lib/validation.ts + src/app/api/sender-id/request/route.ts); this
-- column stays nullable in the DB so historical rows aren't broken by a
-- NOT NULL constraint they can never satisfy.

ALTER TABLE "SenderId" ADD COLUMN IF NOT EXISTS "cacDocumentPath" TEXT;
ALTER TABLE "SenderId" ADD COLUMN IF NOT EXISTS "cacDocumentContentType" TEXT;
ALTER TABLE "SenderId" ADD COLUMN IF NOT EXISTS "cacDocumentUploadedAt" TIMESTAMP(3);

-- === Storage bucket =========================================================
-- Supabase Storage buckets are just rows in storage.buckets — creating one
-- via migration means it exists the moment this migration is applied,
-- with no separate manual "create the bucket in the dashboard" step to
-- forget. `public = false` is the actual access control: this bucket has
-- no storage.objects RLS policies (intentionally — see below), and
-- Supabase denies all access by default to any role without an explicit
-- policy. Only the service role (which bypasses storage RLS the same way
-- the `postgres` role bypasses table RLS — see the enable_row_level_security
-- migration) can read or write here. That's deliberate: uploads happen
-- server-side in the sender-id/request route using the service role key,
-- never directly from the browser, so there's no legitimate anon/
-- authenticated access pattern to write a policy for.
--
-- Guarded behind an existence check because storage.buckets only exists
-- on real Supabase-managed Postgres, not on a vanilla Postgres instance
-- (e.g. CI's postgres:16 Docker container, or a local `docker run
-- postgres` for testing) — this keeps the migration a harmless no-op
-- there instead of failing the whole migration on an unrelated table
-- that was never going to exist outside Supabase.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('cac-documents', 'cac-documents', false)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
