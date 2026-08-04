-- Adds an idempotency key to Campaign so POST /api/campaigns/submit is
-- safe to retry: a double-click, a client-side retry-on-timeout, or two
-- browser tabs submitting at once with the same Idempotency-Key header
-- will hit this unique constraint on the second attempt instead of
-- creating a second campaign and deducting the wallet twice.
--
-- Nullable, and only unique in combination with tenantId: rows with no
-- idempotency key (older campaigns, or any client that doesn't send the
-- header) are unaffected — Postgres does not enforce uniqueness across
-- rows where either column in a compound unique index is NULL, so any
-- number of NULL-idempotencyKey campaigns can coexist per tenant, same as
-- today.
ALTER TABLE "Campaign" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Campaign_tenantId_idempotencyKey_key" ON "Campaign"("tenantId", "idempotencyKey");
