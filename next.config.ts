import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
};

export default withSentryConfig(nextConfig, {
  // These two are needed to upload source maps so Sentry can show real
  // file/line info in stack traces instead of minified bundle positions.
  // Both come from your Sentry project settings (Settings -> General for
  // org slug, the project's own settings page for project slug) — not
  // secrets, safe to commit.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // SENTRY_AUTH_TOKEN (an actual secret — from Settings -> Auth Tokens)
  // must be set wherever this builds (Vercel env vars, not .env.local
  // committed anywhere) for source map upload to run. Without it, the
  // build still succeeds — Sentry just falls back to unminified stack
  // traces, so this isn't a blocking requirement to deploy, just worth
  // adding when convenient.

  silent: true, // suppress Sentry CLI build logs — keeps `next build` output readable
  widenClientFileUpload: true,
  // Note: disableLogger/automaticVercelMonitors are intentionally omitted.
  // Both are webpack-only options and this project runs on Turbopack (see
  // the "▲ Next.js ... (Turbopack)" line in `next dev`/`next build` output)
  // — they'd only produce a deprecation warning with no actual effect.
});
