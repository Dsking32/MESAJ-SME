-- Enforce idempotency for Paystack webhook deliveries at the database
-- level. The application previously guarded against duplicate credits with
-- a findFirst-then-create check, which has a race window: two concurrent
-- webhook deliveries for the same reference (Paystack does redeliver) could
-- both pass the findFirst check before either insert committed, resulting
-- in a double credit.
--
-- Postgres unique constraints allow multiple NULLs, so this does not
-- affect MANUAL_ADJUST rows (which have no paymentReference).
--
-- NOTE: if any existing WalletTransaction rows already share a duplicate
-- paymentReference, this migration will fail to apply. Run the following
-- first to check before deploying:
--
--   SELECT "paymentReference", count(*)
--   FROM "WalletTransaction"
--   WHERE "paymentReference" IS NOT NULL
--   GROUP BY "paymentReference"
--   HAVING count(*) > 1;
--
-- If that returns any rows, resolve them manually (keep the correct credit,
-- reverse the duplicate with an explicit REFUND transaction) before this
-- migration is applied.

CREATE UNIQUE INDEX "WalletTransaction_paymentReference_key"
  ON "WalletTransaction"("paymentReference");
