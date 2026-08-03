-- Missing indexes on foreign-key columns that nearly every route in this
-- app filters on directly.
--
-- Prisma (unlike some ORMs, and unlike MySQL's own default behavior) does
-- NOT automatically create an index for a relation's scalar foreign-key
-- column on Postgres — an index only exists if @@index/@@unique says so.
-- These five foreign keys never got one, even though tenantId is the
-- primary filter on almost every tenant-scoped query in src/app/api/**
-- (and is also what the RLS policies in the enable_row_level_security
-- migration filter on for every SELECT). Two more (Contact.contactListId,
-- CampaignCarrierBatch.campaignId) are equally hot lookup paths — the
-- contacts drill-in view and the admin campaign-batch queries — and were
-- missing for the same reason.
--
-- Harmless at today's data volume; without these, every one of the
-- queries below degrades to a sequential scan as tenants accumulate
-- campaigns/contacts/messages, which is exactly the kind of thing that
-- looks fine in dev and then shows up as a slow dashboard in production.
--
-- NOTE ON APPLYING THIS AGAINST A LIVE TABLE WITH REAL DATA:
-- Plain CREATE INDEX takes a lock that blocks writes for the duration of
-- the build. Fine here (new project, small tables) — but if this is ever
-- run against a table with meaningful production traffic, use
-- `CREATE INDEX CONCURRENTLY` instead (which cannot run inside a
-- transaction, so it needs to be applied outside Prisma's normal
-- migrate flow — see Prisma's docs on customizing migrations for
-- concurrent indexes).

CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");
CREATE INDEX "SenderId_tenantId_idx" ON "SenderId"("tenantId");
CREATE INDEX "WalletTransaction_tenantId_idx" ON "WalletTransaction"("tenantId");
CREATE INDEX "ContactList_tenantId_idx" ON "ContactList"("tenantId");
CREATE INDEX "Contact_contactListId_idx" ON "Contact"("contactListId");
CREATE INDEX "SavedMessage_tenantId_idx" ON "SavedMessage"("tenantId");
CREATE INDEX "Campaign_tenantId_idx" ON "Campaign"("tenantId");
CREATE INDEX "Campaign_senderIdId_idx" ON "Campaign"("senderIdId");
CREATE INDEX "CampaignCarrierBatch_campaignId_idx" ON "CampaignCarrierBatch"("campaignId");
