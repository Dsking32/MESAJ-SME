-- Automated per-MSISDN delivery reports, gated behind admin approval
-- before a client can see them.
--
-- Adds:
--   1. DeliveryStatus enum
--   2. MessageRecipient table — one row per recipient number in a
--      campaign, created at send time and updated as Mesaj's delivery
--      webhook events arrive (see src/app/api/mesaj/webhook/route.ts).
--   3. Campaign.reportApprovedAt / reportApprovedByAdminId — the
--      visibility gate a client's dashboard checks before showing the
--      report (see src/app/api/admin/campaigns/[id]/approve-report).
--   4. An RLS policy for MessageRecipient, matching the pattern the
--      2026-07-27 RLS migration set for every other table. Left out, this
--      table would default to NO row-level security at all (not
--      default-deny — genuinely unrestricted), which would be the one
--      unprotected table in an otherwise fully-covered schema. Policy
--      shape follows CampaignCarrierBatch: scoped via a parent join,
--      since MessageRecipient also carries a denormalized tenantId
--      directly, we scope on that column instead — simpler and avoids an
--      extra join.

-- === DeliveryStatus enum ====================================================
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXPIRED');

-- === Campaign: report approval gate ========================================
ALTER TABLE "Campaign"
  ADD COLUMN "reportApprovedAt" TIMESTAMP(3),
  ADD COLUMN "reportApprovedByAdminId" TEXT;

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_reportApprovedByAdminId_fkey"
  FOREIGN KEY ("reportApprovedByAdminId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- === MessageRecipient ========================================================
CREATE TABLE "MessageRecipient" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "carrierBatchId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "carrier" "Carrier" NOT NULL,
  "shortcodeUsed" TEXT NOT NULL,
  "mesajReference" TEXT,
  "gatewayAccepted" BOOLEAN NOT NULL,
  "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MessageRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageRecipient_mesajReference_key" ON "MessageRecipient"("mesajReference");
CREATE INDEX "MessageRecipient_tenantId_idx" ON "MessageRecipient"("tenantId");
CREATE INDEX "MessageRecipient_campaignId_idx" ON "MessageRecipient"("campaignId");
CREATE INDEX "MessageRecipient_phoneNumber_shortcodeUsed_deliveryStatus_idx"
  ON "MessageRecipient"("phoneNumber", "shortcodeUsed", "deliveryStatus");

ALTER TABLE "MessageRecipient"
  ADD CONSTRAINT "MessageRecipient_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessageRecipient"
  ADD CONSTRAINT "MessageRecipient_carrierBatchId_fkey"
  FOREIGN KEY ("carrierBatchId") REFERENCES "CampaignCarrierBatch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- === RLS =====================================================================
-- Mirrors the pattern from the 2026-07-27 RLS migration: SELECT-only,
-- tenant-scoped or admin. Writes still go entirely through Prisma (which
-- connects as the RLS-bypassing table owner), same as every other table —
-- see that migration's header comment for the full rationale, including
-- the rolbypassrls verification query worth re-running after this ships.
ALTER TABLE "MessageRecipient" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_recipient_tenant_or_admin ON "MessageRecipient";
CREATE POLICY message_recipient_tenant_or_admin ON "MessageRecipient"
  FOR SELECT USING ("tenantId" = app_current_tenant_id() OR app_is_admin());
