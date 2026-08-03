-- Row-Level Security: defense-in-depth for tenant isolation.
--
-- WHY THIS EXISTS
-- Every tenant-scoped query in the app (see src/app/api/**/route.ts) is
-- written to filter by tenantId, e.g.:
--   prisma.savedMessage.findFirst({ where: { id, tenantId: user.tenantId } })
-- That's correct everywhere it was checked, but it's an app-layer
-- discipline with no structural backstop: it depends on every current and
-- future route remembering to add the filter. This migration adds that
-- backstop at the database itself, so a route that forgets the tenantId
-- filter fails closed (returns nothing) instead of leaking another
-- tenant's data — IF that query ever runs under Supabase's anon/
-- authenticated roles (e.g. direct PostgREST access, or a future
-- supabase-js call added to the client bundle).
--
-- WHAT THIS DOES NOT CHANGE
-- This app's actual data access goes entirely through Prisma using
-- DATABASE_URL — Supabase's standard pooled Postgres connection string,
-- which connects as the `postgres` role. On Supabase, `postgres` owns the
-- tables and bypasses RLS by design (this is standard Supabase behavior,
-- not something configured here). That means:
--   - Every existing route in this app keeps working exactly as before.
--   - RLS only takes effect for connections using Supabase's `anon` /
--     `authenticated` roles — i.e. direct table access via Supabase's
--     auto-generated REST/Data API or the JS client, which this app
--     doesn't currently use for data (only for auth). Today those roles
--     have no policies at all on these tables, meaning if the project's
--     anon/public key were ever exposed or misused, every row in every
--     table is readable through Supabase's REST API with zero query-level
--     protection. This migration closes that gap.
--
-- VERIFY BEFORE RELYING ON THIS
-- Confirm the role DATABASE_URL actually connects as bypasses RLS, since
-- if it doesn't, this migration would make every existing route start
-- returning empty results instead of real data:
--   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
-- rolbypassrls (or rolsuper) should be `t`. This is Supabase's default for
-- the `postgres` role — true unless DATABASE_URL was deliberately pointed
-- at a custom, more restricted role.
--
-- WHAT'S INTENTIONALLY NOT HERE
-- Policies below are SELECT-only. The app never writes tenant data via
-- Supabase's client-side API today (all writes go through Prisma, which
-- bypasses RLS as the table owner) — so there's nothing to protect on the
-- write path yet, and adding permissive INSERT/UPDATE/DELETE policies now
-- would just be unused surface area. If a future feature adds direct
-- supabase-js writes from the client, add matching WITH CHECK policies
-- for that table at that time.
--
-- FORCE ROW LEVEL SECURITY is deliberately NOT used anywhere below — that
-- would apply RLS even to the table owner, which is exactly the role
-- Prisma connects as, and would break the app.

-- === Helper functions ======================================================
-- SECURITY DEFINER: these run with the privileges of the function's owner
-- (the migration-executing role), not the caller's. That's required here —
-- without it, resolving "who is the current user" would itself need to
-- read the User table, which has RLS enabled below, causing the check to
-- recurse into itself. SET search_path pins name resolution to `public` so
-- a malicious search_path on the calling session can't redirect these
-- functions to a different, attacker-controlled function of the same name.

CREATE OR REPLACE FUNCTION app_is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User"
    WHERE "authUserId" = auth.uid()::text AND role = 'ADMIN'
  );
$$;

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT "tenantId" FROM "User" WHERE "authUserId" = auth.uid()::text;
$$;

-- === User ===================================================================
-- A user can see their own row; admins can see everyone's. No write
-- policy — role changes go through /api/admin/users/[id]/role via Prisma.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_self_or_admin ON "User";
CREATE POLICY user_self_or_admin ON "User"
  FOR SELECT
  USING ("authUserId" = auth.uid()::text OR app_is_admin());

-- === Tenant ==================================================================
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self_or_admin ON "Tenant";
CREATE POLICY tenant_self_or_admin ON "Tenant"
  FOR SELECT
  USING (id = app_current_tenant_id() OR app_is_admin());

-- === Directly tenant-scoped tables (own tenantId column) ===================
ALTER TABLE "SenderId" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS senderid_tenant_or_admin ON "SenderId";
CREATE POLICY senderid_tenant_or_admin ON "SenderId"
  FOR SELECT USING ("tenantId" = app_current_tenant_id() OR app_is_admin());

ALTER TABLE "WalletTransaction" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallettxn_tenant_or_admin ON "WalletTransaction";
CREATE POLICY wallettxn_tenant_or_admin ON "WalletTransaction"
  FOR SELECT USING ("tenantId" = app_current_tenant_id() OR app_is_admin());

ALTER TABLE "ContactList" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contactlist_tenant_or_admin ON "ContactList";
CREATE POLICY contactlist_tenant_or_admin ON "ContactList"
  FOR SELECT USING ("tenantId" = app_current_tenant_id() OR app_is_admin());

ALTER TABLE "SavedMessage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS savedmessage_tenant_or_admin ON "SavedMessage";
CREATE POLICY savedmessage_tenant_or_admin ON "SavedMessage"
  FOR SELECT USING ("tenantId" = app_current_tenant_id() OR app_is_admin());

ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_tenant_or_admin ON "Campaign";
CREATE POLICY campaign_tenant_or_admin ON "Campaign"
  FOR SELECT USING ("tenantId" = app_current_tenant_id() OR app_is_admin());

-- === Tables scoped via a parent join (no tenantId column of their own) ====
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_tenant_or_admin ON "Contact";
CREATE POLICY contact_tenant_or_admin ON "Contact"
  FOR SELECT USING (
    app_is_admin() OR EXISTS (
      SELECT 1 FROM "ContactList" cl
      WHERE cl.id = "Contact"."contactListId" AND cl."tenantId" = app_current_tenant_id()
    )
  );

ALTER TABLE "SenderIdCarrierStatus" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sender_id_carrier_status_tenant_or_admin ON "SenderIdCarrierStatus";
CREATE POLICY sender_id_carrier_status_tenant_or_admin ON "SenderIdCarrierStatus"
  FOR SELECT USING (
    app_is_admin() OR EXISTS (
      SELECT 1 FROM "SenderId" si
      WHERE si.id = "SenderIdCarrierStatus"."senderIdId" AND si."tenantId" = app_current_tenant_id()
    )
  );

ALTER TABLE "CampaignCarrierBatch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_carrier_batch_tenant_or_admin ON "CampaignCarrierBatch";
CREATE POLICY campaign_carrier_batch_tenant_or_admin ON "CampaignCarrierBatch"
  FOR SELECT USING (
    app_is_admin() OR EXISTS (
      SELECT 1 FROM "Campaign" c
      WHERE c.id = "CampaignCarrierBatch"."campaignId" AND c."tenantId" = app_current_tenant_id()
    )
  );

-- === Internal / operational tables — no tenant should ever see these ======
-- RLS enabled with zero policies below means: fully inaccessible to the
-- anon/authenticated roles (default-deny), reachable only by the
-- RLS-bypassing owner role Prisma connects as.
ALTER TABLE "RateLimitHit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminAuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PortedNumberOverride" ENABLE ROW LEVEL SECURITY;
