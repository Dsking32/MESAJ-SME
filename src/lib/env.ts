/**
 * Validates environment variables at process startup, not deep inside
 * whatever request happens to touch a missing one first.
 *
 * Wired in via src/instrumentation.ts, which Next.js runs once when the
 * server process boots (before it starts serving requests) — see
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Two tiers, not one:
 *  - REQUIRED_VARS: the app cannot serve a single page without these
 *    (DB connection, Supabase auth). Missing one of these means nothing
 *    works, so we crash the boot loudly rather than let every request fail
 *    mysteriously.
 *  - RECOMMENDED_VARS: needed for specific features (sending SMS, wallet
 *    top-ups) but the rest of the app — signup, dashboard, browsing —
 *    works fine without them. Crashing local dev because Paystack isn't
 *    configured yet is worse than the problem it solves, so these only
 *    warn. The warning still fires at boot, so it's still "found out
 *    immediately," just not "server refuses to start."
 *
 * Deliberately NOT imported by every route — importing it once from
 * instrumentation.ts is what makes this "checked at boot" instead of
 * "fails on first request that needs the var."
 */

interface EnvVar {
  name: string;
  /** Short reason, shown in the startup message, so whoever's debugging a
   * deploy knows what breaks without it. */
  usedFor: string;
}

const REQUIRED_VARS: EnvVar[] = [
  { name: "DATABASE_URL", usedFor: "Postgres connection (Prisma) — nothing works without this" },
  { name: "NEXT_PUBLIC_SUPABASE_URL", usedFor: "Supabase project URL (auth) — nothing works without this" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", usedFor: "Supabase anon key (auth) — nothing works without this" },
];

const RECOMMENDED_VARS: EnvVar[] = [
  { name: "MESAJ_API_TOKEN", usedFor: "Mesaj bulk SMS API bearer token (sending will fail)" },
  {
    name: "MESAJ_WEBHOOK_SECRET",
    usedFor:
      "shared secret to verify inbound Mesaj delivery-report webhooks (see README — confirm the exact header/scheme with Mesaj; without this set, webhook auth is skipped entirely, which is NOT safe for production)",
  },
  { name: "PAYSTACK_SECRET_KEY", usedFor: "Paystack webhook verification + wallet funding (top-ups will fail)" },
  { name: "NEXT_PUBLIC_APP_URL", usedFor: "Paystack callback_url after wallet top-up; also the base URL the campaign-send background chain calls back into itself (see lib/campaignSendProcessor.ts) — without it, campaign approval will claim the campaign but the send chain won't start" },
  {
    name: "CRON_SECRET",
    usedFor:
      "auth for the campaign-send background chain's internal continuation calls and the recovery cron (see lib/internalAuth.ts) — without it, /api/internal/campaigns/process-send and /api/cron/process-stuck-campaign-sends refuse every request, so approved campaigns will get stuck after their first carrier. Vercel auto-provisions this once vercel.json has a crons entry; set it manually for local dev.",
  },
  { name: "RESEND_API_KEY", usedFor: "client email notifications — Sender ID status, campaign rejection (emails silently won't send)" },
  { name: "EMAIL_FROM", usedFor: "the From address on client notification emails (emails silently won't send)" },
  { name: "SENTRY_DSN", usedFor: "server-side error reporting (errors will happen silently — you won't know until a client reports one)" },
  { name: "NEXT_PUBLIC_SENTRY_DSN", usedFor: "browser-side error reporting (same as SENTRY_DSN, but for client-side errors)" },
];

export function validateEnv(): void {
  const missingRequired = REQUIRED_VARS.filter((v) => !process.env[v.name]);

  if (missingRequired.length > 0) {
    const lines = missingRequired.map((v) => `  - ${v.name}  (${v.usedFor})`).join("\n");
    throw new Error(
      `Missing required environment variable(s):\n${lines}\n\nSet these before starting the server — see README.md "Environment variables".`
    );
  }

  const missingRecommended = RECOMMENDED_VARS.filter((v) => !process.env[v.name]);
  if (missingRecommended.length > 0) {
    const lines = missingRecommended.map((v) => `  - ${v.name}  (${v.usedFor})`).join("\n");
    // eslint-disable-next-line no-console
    console.warn(
      `[startup] Missing recommended environment variable(s) — the app will boot, but these features won't work until they're set:\n${lines}`
    );
  }
}
