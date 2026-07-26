/**
 * Load test for /api/campaigns/validate-numbers.
 *
 * WHY THIS ENDPOINT: it requires real auth (like every other campaign
 * route) but never touches money or sends anything — safe to hammer
 * repeatedly without refunds/cleanup. It also runs the same DB-backed rate
 * limiter as every other write route, so it's a fair proxy for how the
 * app behaves under concurrent load in general.
 *
 * WHY PLAYWRIGHT, NOT A BEARER TOKEN: this app's API routes read the
 * Supabase session from cookies via @supabase/ssr's server client — there
 * is no Authorization-header auth path. Logging in through a real browser
 * page is the only reliable way to get a genuinely valid session cookie
 * without reverse-engineering Supabase's SSR cookie encoding by hand.
 *
 * SAFETY: only ever point BASE_URL at localhost or a disposable staging
 * deployment. This intentionally has no production safeguard beyond this
 * comment — you are the safeguard. Running this against a real production
 * URL will burn through real rate-limit quota for a real account and could
 * degrade the app for real users.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   TEST_EMAIL=you@example.com \
 *   TEST_PASSWORD=your-test-password \
 *   npx tsx scripts/load-test.ts
 *
 * Requires: npm install --save-dev playwright autocannon && npx playwright install chromium
 * (both deliberately left out of package.json — this is a manual, opt-in
 * tool, not something `npm ci` should install for every contributor)
 */
import { chromium } from "playwright";
import autocannon from "autocannon";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION ?? 20);
const CONNECTIONS = Number(process.env.LOAD_TEST_CONNECTIONS ?? 10);

const SAMPLE_NUMBERS = Array.from({ length: 50 }, (_, i) => `080300000${String(i).padStart(2, "0")}`);

async function main() {
  if (BASE_URL.includes("vercel.app") || BASE_URL.includes("mesajsme")) {
    console.error(
      `Refusing to run: BASE_URL (${BASE_URL}) looks like it could be a real deployed environment.\n` +
        `Point this at localhost or a disposable staging URL instead.`
    );
    process.exit(1);
  }
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.error("Set TEST_EMAIL and TEST_PASSWORD to a real (test/staging) account before running this.");
    process.exit(1);
  }

  console.log(`Logging in as ${TEST_EMAIL} at ${BASE_URL} via a real browser session...`);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", TEST_EMAIL);
  await page.fill("#password", TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => {
    throw new Error("Login didn't redirect to /dashboard — check TEST_EMAIL/TEST_PASSWORD are valid.");
  });

  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  await browser.close();

  console.log(
    `Authenticated. Running ${CONNECTIONS} concurrent connections against ` +
      `POST ${BASE_URL}/api/campaigns/validate-numbers for ${DURATION_SECONDS}s...`
  );

  const result = await autocannon({
    url: `${BASE_URL}/api/campaigns/validate-numbers`,
    method: "POST",
    connections: CONNECTIONS,
    duration: DURATION_SECONDS,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ numbers: SAMPLE_NUMBERS }),
  });

  console.log("\n--- Results ---");
  console.log(`Requests: ${result.requests.total} total, ${result.requests.average}/sec average`);
  console.log(`Latency: p50=${result.latency.p50}ms  p99=${result.latency.p99}ms  max=${result.latency.max}ms`);
  console.log(`2xx: ${result["2xx"]}  4xx: ${result.non2xx}  errors: ${result.errors}`);
  console.log(
    "\nA healthy result: no 5xx responses, and 429s (rate limited) only appear once you exceed " +
      "the configured per-user limit — check RATE_LIMITS in src/lib/rateLimit.ts for the exact threshold " +
      "this route uses, and compare it to CONNECTIONS × DURATION_SECONDS above."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
