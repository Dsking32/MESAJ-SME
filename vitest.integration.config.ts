import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration tests hit a REAL Postgres database through the real,
 * generated Prisma client — nothing here is mocked. That's the whole
 * point: these exist specifically to catch the class of bug that mocked
 * unit tests structurally cannot, e.g. the paymentReference unique
 * constraint added alongside this config only actually does anything when
 * a real database enforces it — a mocked prisma.walletTransaction.create()
 * would happily "succeed" twice no matter what.
 *
 * Requires DATABASE_URL to point at a disposable database with migrations
 * already applied (`prisma migrate deploy`) before running — see
 * .github/workflows/ci.yml's `integration-test` job, or run locally against
 * a local/throwaway Postgres, never against production.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // No setupFiles here (unlike vitest.config.ts) — these tests want the
    // real env vars pointing at a real test database, not the fake
    // Mesaj/Paystack tokens the unit-test setup file injects.
    testTimeout: 15_000,
    // Integration tests share state in the same DB and can't safely run
    // concurrently against the same rows (e.g. two files both racing the
    // RateLimitHit table). Force sequential execution.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
