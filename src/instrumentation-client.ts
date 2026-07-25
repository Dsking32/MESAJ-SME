/**
 * Sentry init for the browser. Next.js auto-loads a file at exactly this
 * path (src/instrumentation-client.ts, mirroring src/instrumentation.ts
 * for the server) — no manual import needed anywhere.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});

// Required by Next.js for router transition instrumentation.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
