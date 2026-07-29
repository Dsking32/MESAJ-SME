# Delivery report automation — changes in this update

## What this adds
Per-MSISDN/telco/status delivery reports, automated end-to-end, gated
behind admin approval before a client can see them.

## Files changed/added

**Schema**
- `prisma/schema.prisma` — `DeliveryStatus` enum, `MessageRecipient` model,
  `Campaign.reportApprovedAt`/`reportApprovedByAdminId`
- `prisma/migrations/20260728120000_message_recipient_delivery_reports/migration.sql`
  — hand-written, following this repo's existing convention (see the two
  prior hand-written migrations). **Not run/validated against a real DB in
  this sandbox** (no network egress to a Postgres instance here) — review
  it, then run `npx prisma migrate dev` yourself to apply and let Prisma
  confirm it matches the schema exactly.

**Sending — capturing per-recipient references**
- `src/lib/mesajClient.ts` — `sendCarrierBatch` now returns
  `recipientResults`, zipping `recipients[i]` to `response[i].reference`
  (NOT `messageId` — see comments for why). Falls back to `null`
  references if the response shape doesn't match what's expected.
- `src/lib/mesajClient.test.ts` — added 3 tests covering the zip/fallback
  logic against real response shapes you shared. All 13 original tests
  still pass unmodified.
- `src/lib/messageRecipients.ts` (new) — shared helper, persists
  `MessageRecipient` rows from a send result.
- `src/app/api/admin/campaigns/approve/route.ts` and
  `src/app/api/admin/tenants/[id]/campaigns/send/route.ts` — both now call
  the helper after creating each `CampaignCarrierBatch`.

**Receiving — the webhook**
- `src/app/api/mesaj/webhook/route.ts` (new) — matches inbound delivery
  events on `reference`, falls back to `(phoneNumber, shortCode, PENDING)`.
  Auth is a placeholder shared-secret header check — **confirm the real
  scheme with Mesaj** before relying on this.
- `src/lib/env.ts`, `.env.example` — added `MESAJ_WEBHOOK_SECRET`.

**Admin approval gate**
- `src/app/api/admin/campaigns/[id]/approve-report/route.ts` (new)
- `src/app/admin/campaigns/reports/page.tsx` + `ReportQueue.tsx` (new) —
  queue of SENT campaigns awaiting report approval, with live
  delivered/failed/pending counts
- `src/components/AppShell.tsx` — added "Delivery reports" nav item

**Client-facing report**
- `src/app/dashboard/campaigns/[id]/report/page.tsx` (new) — shows
  "still being reviewed" until approved, then the paginated MSISDN/
  telco/status table
- `src/app/api/campaigns/[id]/report.csv/route.ts` (new) — CSV export,
  tenant-scoped, gated on approval
- `src/app/dashboard/page.tsx` — added a "Report" column/link on SENT
  campaigns
- `src/components/ui/Badge.tsx` — added DELIVERED/EXPIRED status colors

**Notifications**
- `src/lib/notifications.ts` — added `notifyReportReady`, sent when admin
  approves

**Docs**
- `README.md` — updated to reflect this is no longer a manual gap, and
  flags the two things still needing confirmation from Mesaj

## Two things to confirm with Mesaj before production
1. Is the send response array (`/client/sms/send/bulk`) guaranteed to be
   in the same order as the request's `recipients` array? Matching
   currently depends on this (see `parseSendResponse` in
   `lib/mesajClient.ts`).
2. What's the actual webhook auth scheme (signed header? shared secret?
   IP allowlist?) — the current check is a placeholder.

## Verification done in this environment
- `npx vitest run src/lib/mesajClient.test.ts` — 13 original + 3 new
  tests, all passing
- Manually reviewed the full `schema.prisma` and migration SQL against
  the existing baseline's column types/naming for consistency
- Could NOT run `prisma generate`/`validate`/`migrate dev` here — this
  sandbox has no network access to Prisma's engine-binary host. Run these
  yourself before merging:
  ```
  npx prisma generate
  npx prisma migrate dev
  npm run build   # or your usual typecheck/build command
  ```
