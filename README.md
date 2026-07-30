# Mesaj SME v2

Self-serve, multi-tenant bulk SMS platform for Nigerian SMEs. Clients sign up,
request Sender ID whitelisting, fund a wallet, and send their own promotional
campaigns — routed through Mesaj's client API.

See `mesaj-sme-v2-development-guide.md` (in the parent deliverable) for the
full product/technical spec this code implements.

## Stack

- Next.js (App Router, TypeScript, Tailwind)
- Supabase (Auth + Postgres)
- Prisma (ORM)
- Paystack (wallet funding)
- Mesaj client API (actual SMS sending)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Environment variables**
   Copy `.env.example` to `.env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     from your Supabase project settings
   - `DATABASE_URL` — Supabase's Postgres connection string (Project Settings -> Database)
   - `MESAJ_API_TOKEN` — your Mesaj client Bearer token
   - `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` — from your Paystack dashboard
   - `RESEND_API_KEY` / `EMAIL_FROM` — for transactional email (Sender ID
     status changes, campaign rejection reasons — sent automatically from
     the relevant admin routes, see `lib/notifications.ts`)
   - `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` — from your Sentry project's
     Client Keys (DSN) settings page (usually the same DSN value for both).
     `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` are optional —
     only needed for source map upload so stack traces show real file/line
     info; the app runs fine without them, source maps just won't upload

3. **Database**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

   Schema changes should go through `npx prisma migrate dev --name <what-changed>`
   from here on, not `db push` — see `prisma/migrations/` for the baseline.
   `db push` has no history and nothing to roll back if a change goes wrong;
   fine for early solo development, not once there's real client data.

   **Before deploying the RLS migration** (`enable_row_level_security`)
   against a given `DATABASE_URL`, run:
   ```bash
   npm run verify-rls
   ```
   This confirms Prisma's connection role bypasses RLS (Supabase's default
   `postgres` role does). If it doesn't, every tenant-scoped route will
   start returning empty results instead of real data the moment RLS is
   enabled — see the migration file's own comments for why.

4. **Supabase Auth**
   - Enable email/password auth in your Supabase project
   - Set the site URL / redirect URLs to match `NEXT_PUBLIC_APP_URL`

5. **Run locally**
   ```bash
   npm run dev
   ```

6. **Error monitoring**
   Sentry is wired in (`sentry.server.config.ts`, `sentry.edge.config.ts`,
   `src/instrumentation-client.ts`, `src/instrumentation.ts`,
   `src/app/global-error.tsx`) but needs a Sentry account + project to
   actually report anywhere — see step 2 for the env vars. Without them set,
   the app runs identically, it just doesn't report errors anywhere.

## How the pieces fit together

- **Client flow:** `/signup` -> `/onboarding` (creates Tenant + User) ->
  `/dashboard` -> request Sender ID (`/dashboard/sender-id`) -> top up
  (`/dashboard/wallet`) -> compose & send (`/dashboard/compose`, with
  quick-reuse pickers for saved messages/contact lists). Manage saved
  content directly at `/dashboard/contacts` (standalone create, CSV
  upload, append-to-an-existing-list, a drill-in view of every number in a
  list, single/bulk delete, pagination) and `/dashboard/messages` (same,
  plus edit-in-place) — both link back into compose via `?contactListId=`
  / `?savedMessageId=` for one-click reuse. Rate limits for these are
  split per resource and per create-vs-delete (`SAVED_MESSAGE_CREATE`,
  `SAVED_MESSAGE_DELETE`, `CONTACT_LIST_CREATE`, `CONTACT_LIST_DELETE` in
  `lib/rateLimit.ts`) so deleting old items can't eat into the quota for
  saving new ones.
- **Admin flow:** `/admin/sender-ids` (manually update per-telco approval
  status + shortCode), `/admin/campaigns` (approve/reject pending
  campaigns — approval triggers the actual carrier-split send to Mesaj),
  and `/admin/users` (promote/demote a user's role)

The very first admin still has to be set by hand — `role: ADMIN` directly
in the database (or a Prisma seed script) — since there's no user to grant
that access before one exists. From there, any admin can promote further
users to ADMIN (or demote back to CLIENT) via `/admin/users`.

## Key design decisions (matching the agreed logic)

- **Number validation happens before anything reaches Mesaj.** Mesaj's API
  fails the entire batch if one number is invalid, so `lib/numbers.ts`
  validates, normalizes, and carrier-sorts everything client-side (for the
  confirmation pop-up) and again server-side (for the actual submit) before
  a campaign is ever created.
- **One send request per carrier**, since Mesaj's API takes a single
  `shortCode` per request and each carrier may approve a different shortCode
  format for the same Sender ID.
- **Admin approves message body only** — carrier splitting and unapproved-carrier
  exclusion happen automatically on approval, not as separate admin steps.
- **Sender ID status is manually managed by admin** per carrier — there's no
  live telco/Mesaj feed wired up yet (a Mesaj webhook reportedly exists but
  wasn't scoped for v1).
- **Delivery reports are automated, admin-gated.** `MessageRecipient` rows
  (one per number in a campaign) are created from Mesaj's send response at
  send time, then updated as delivery webhooks arrive at
  `/api/mesaj/webhook` (see that route's doc comment — matching is on
  `reference`, NOT `messageId`, which is shared across recipients in the
  same send). Clients can't see the per-MSISDN/telco/status report until
  an admin explicitly approves it at `/admin/campaigns/reports` (see
  `/api/admin/campaigns/[id]/approve-report`) — same "admin reviews before
  client sees it" shape as message-content approval, just gating the
  report instead of the send.
  **Not yet confirmed with Mesaj:** whether the send response array is
  reliably in the same order as the request's `recipients` array (matching
  currently depends on this — see `parseSendResponse` in
  `lib/mesajClient.ts`), and the actual webhook auth scheme (currently a
  placeholder shared-secret header, see `MESAJ_WEBHOOK_SECRET`). Confirm
  both with Mesaj before relying on this in production. Note: with
  `NODE_ENV=production`, the webhook now refuses all requests (503) if
  `MESAJ_WEBHOOK_SECRET` isn't set, rather than silently skipping auth —
  so this can't go live half-configured, but you still need the real
  scheme confirmed with Mesaj to know what to check against.

## Before taking real customer money

Things that are code-complete but need account-level action outside this
repo before a real launch:

- **Paystack, end to end, for real.** `PAYSTACK_SECRET_KEY` needs to
  actually be set in whatever hosts this in production, then do one real
  (small) top-up through the live Paystack flow and confirm: the webhook
  fires, the wallet credits, and a duplicate webhook delivery doesn't
  double-credit (see `/api/wallet/paystack/webhook` — it's idempotent on
  `paymentReference`, but that's only proven by an actual test, not by
  reading the code).
- **Confirm Supabase backups are actually on.** Point-in-time recovery
  isn't necessarily included by default on every Supabase tier — check
  Project Settings -> Backups, not just assume it's covered.
- **Migration baseline.** See the Database section above — `db push` has
  gotten this project to today, but every schema change from here on
  should go through `prisma migrate dev` so there's a reviewable,
  revertible history once real tenant/wallet/campaign data exists.
- **Sentry account.** The code side is done (see step 6 above) — just
  needs a Sentry project created and its DSN dropped into env vars
  wherever this is hosted.

## Still to build (deferred past this scaffold)

- Mesaj webhook integration for automated Sender ID status (delivery
  reports are now automated — see above; Sender ID status is still manual)
- SMS notifications (email notifications are wired in; SMS would need its
  own approved Sender ID with each carrier first — see `lib/notifications.ts`)
- Further production-grade error handling and input sanitization beyond
  what's shown here (rate limiting is already in place — see `lib/rateLimit.ts`)
