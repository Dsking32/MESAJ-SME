/**
 * Sentry init for the Edge runtime. This app doesn't currently run
 * anything on the edge runtime, but Next.js loads this file if it exists
 * whenever middleware/edge routes are present, and Sentry's setup expects
 * it to exist alongside sentry.server.config.ts — kept in sync with it
 * rather than omitted, so nothing silently goes unmonitored if an edge
 * route gets added later.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
