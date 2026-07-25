/**
 * Next.js instrumentation hook — runs once when the server process starts,
 * before it accepts any requests. See:
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Two responsibilities:
 *  1. Validate required environment variables at boot (fail fast and loud)
 *     instead of discovering a missing MESAJ_API_TOKEN or
 *     PAYSTACK_SECRET_KEY deep inside whatever request happens to need it
 *     first.
 *  2. Initialize Sentry for whichever runtime this process is (Node or
 *     edge) — see sentry.server.config.ts / sentry.edge.config.ts. Without
 *     this, a 500 in production is only visible if a client happens to
 *     report it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("./lib/env");
    validateEnv();
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Next.js calls this for any error surfaced during a request that isn't
// already handled by a route's own try/catch (e.g. an uncaught throw in a
// server component). Sentry's captureRequestError attaches the request
// context (path, method) automatically.
export async function onRequestError(...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>) {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
}
