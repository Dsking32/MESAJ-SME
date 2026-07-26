import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit } from "../rateLimit";
import { prisma } from "../prisma";

const TEST_KEY_PREFIX = "integration-test-rate-limit";

beforeEach(async () => {
  await prisma.rateLimitHit.deleteMany({ where: { key: { startsWith: TEST_KEY_PREFIX } } });
});

describe("checkRateLimit (real DB)", () => {
  it("allows requests up to the limit, then blocks the next one", async () => {
    const key = `${TEST_KEY_PREFIX}:sequential`;
    const limit = 3;
    const windowMs = 60_000;

    const results = [];
    for (let i = 0; i < limit + 1; i++) {
      results.push(await checkRateLimit(key, limit, windowMs));
    }

    expect(results.slice(0, limit).every((r) => r.allowed)).toBe(true);
    expect(results[limit].allowed).toBe(false);
  });

  it("race-safely counts concurrent hits in the same window instead of losing increments", async () => {
    // This is the scenario a naive read-then-write counter gets wrong:
    // many requests landing in the same window at (near) the same instant.
    // The upsert + atomic increment in checkRateLimit should mean every
    // single one is counted, with none silently lost to a race.
    const key = `${TEST_KEY_PREFIX}:concurrent`;
    const limit = 5;
    const windowMs = 60_000;
    const concurrentRequests = 10;

    const results = await Promise.all(
      Array.from({ length: concurrentRequests }, () => checkRateLimit(key, limit, windowMs))
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const blockedCount = results.filter((r) => !r.allowed).length;

    // Exactly `limit` should have been allowed — not more (would mean the
    // limit doesn't actually hold under concurrency) and not fewer (would
    // mean increments were lost to a race and the count under-reports).
    expect(allowedCount).toBe(limit);
    expect(blockedCount).toBe(concurrentRequests - limit);

    const row = await prisma.rateLimitHit.findFirst({ where: { key } });
    expect(row?.count).toBe(concurrentRequests);
  });

  it("keeps different keys independent — one caller's usage doesn't affect another's", async () => {
    const keyA = `${TEST_KEY_PREFIX}:tenant-a`;
    const keyB = `${TEST_KEY_PREFIX}:tenant-b`;
    const limit = 2;
    const windowMs = 60_000;

    await checkRateLimit(keyA, limit, windowMs);
    await checkRateLimit(keyA, limit, windowMs);
    const aBlocked = await checkRateLimit(keyA, limit, windowMs);
    const bStillAllowed = await checkRateLimit(keyB, limit, windowMs);

    expect(aBlocked.allowed).toBe(false);
    expect(bStillAllowed.allowed).toBe(true);
  });
});
