/**
 * Sentry init for the Node.js server runtime (API routes, server
 * components, everything except the edge runtime and the browser).
 *
 * Safe to load with SENTRY_DSN unset — Sentry.init() no-ops without a DSN
 * rather than throwing, so local dev without a Sentry project configured
 * still works exactly as before. See lib/env.ts for the startup warning
 * that flags this as a recommended-but-missing var.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Keep this low rather than 1.0 — this is a small app, and Sentry's
  // free/starter tiers price on event volume. 10% of requests still gives
  // a representative performance picture without paying for every request.
  tracesSampleRate: 0.1,

  // Default is already off, but explicit here: don't attach request
  // headers/cookies/IP by default. Clients' phone numbers and business
  // data pass through these routes — no reason to widen what Sentry
  // captures beyond the error itself unless a specific incident needs it.
  sendDefaultPii: false,
});
