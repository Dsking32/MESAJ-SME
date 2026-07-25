/**
 * Shared request rate limiting.
 *
 * Why Postgres and not in-memory: this app runs as serverless functions
 * (Vercel), where each invocation can land on a different, ephemeral
 * instance — an in-memory counter would only ever limit requests that
 * happen to hit the same warm instance, which isn't a real limit at all
 * under actual traffic. There's no Redis/Upstash in this stack yet, and
 * Postgres is already the durable store everything else uses, so a
 * fixed-window counter table there is the correct choice without adding
 * new infra. See RateLimitHit in prisma/schema.prisma.
 *
 * Fixed window, not sliding: a client can send up to `limit` requests near
 * the end of one window and another `limit` near the start of the next
 * (worst case ~2x limit over a short span). That's an accepted tradeoff for
 * simplicity — every route calling this is guarding against sustained abuse
 * (credential stuffing, submit-spam, hammering the Mesaj API), not
 * enforcing an exact quota, so the boundary edge case doesn't matter here.
 * Revisit with a sliding-window or token-bucket approach if that changes.
 */

import { prisma } from "./prisma";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** When the current window ends and the caller's count resets. */
  resetAt: Date;
}

/**
 * Checks and records one hit against `key` under a `limit`-per-`windowMs`
 * fixed window. Every caller in the same window races safely against the
 * same row via upsert + atomic increment — no read-then-write gap.
 *
 * `key` should already be scoped to both the caller (user/tenant/admin id)
 * and the route/action, e.g. `campaign-submit:user_abc123`. Two different
 * routes sharing an unscoped key would rate-limit each other, which is
 * almost never what you want.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);

  const hit = await prisma.rateLimitHit.upsert({
    where: { key_windowStart: { key, windowStart } },
    create: { key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  // Opportunistic cleanup instead of a cron job: on a small fraction of
  // calls, delete rows well outside any window that could still matter.
  // Cheap, self-healing, and doesn't block the request holding it up.
  if (Math.random() < 0.01) {
    const cutoff = new Date(Date.now() - windowMs * 10);
    prisma.rateLimitHit.deleteMany({ where: { windowStart: { lt: cutoff } } }).catch(() => {
      // Best-effort — a failed cleanup pass just means the table stays a
      // little larger until the next one succeeds; never worth failing
      // the actual request over.
    });
  }

  return {
    allowed: hit.count <= limit,
    limit,
    remaining: Math.max(0, limit - hit.count),
    resetAt,
  };
}

/**
 * Standard 429 response for a rate-limited request, with Retry-After and
 * the usual X-RateLimit-* headers so a well-behaved client can back off
 * correctly instead of retrying immediately.
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  return new Response(
    JSON.stringify({ error: "Too many requests — please slow down and try again shortly." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    }
  );
}

/**
 * Per-route limits, centralized for the same reason lib/limits.ts and
 * lib/pricing.ts are: one place to tune instead of magic numbers scattered
 * across route files. Limits are deliberately generous for normal use —
 * these exist to stop sustained abuse/scripting, not to constrain a
 * legitimate admin or client working normally.
 */
export const RATE_LIMITS = {
  // Client, one-time-ish actions — generous but not unlimited.
  ONBOARDING: { limit: 5, windowMs: 10 * 60_000 },
  SENDER_ID_REQUEST: { limit: 10, windowMs: 60 * 60_000 },
  WALLET_TOPUP_INIT: { limit: 10, windowMs: 60_000 },

  // Client, used interactively while composing — needs headroom for
  // re-checking a list after edits, but still caps scripted abuse.
  VALIDATE_NUMBERS: { limit: 60, windowMs: 60_000 },
  CAMPAIGN_SUBMIT: { limit: 20, windowMs: 60_000 },

  // Client, saved-message/contact-list writes. Split by resource and by
  // create-vs-delete (rather than one shared SAVED_ITEMS bucket) so, e.g.,
  // a burst of deleting old saved messages while tidying up can't eat into
  // the quota for saving a new contact list in the same minute — they're
  // unrelated actions and shouldn't compete for the same allowance.
  SAVED_MESSAGE_CREATE: { limit: 20, windowMs: 60_000 },
  SAVED_MESSAGE_DELETE: { limit: 30, windowMs: 60_000 },
  CONTACT_LIST_CREATE: { limit: 20, windowMs: 60_000 },
  CONTACT_LIST_DELETE: { limit: 30, windowMs: 60_000 },

  // Admin actions — higher ceiling since a busy admin session can
  // legitimately fire off many of these in a row, but still bounded.
  ADMIN_ACTION: { limit: 60, windowMs: 60_000 },
  // Tighter: each call sends a real SMS via Mesaj or moves real money,
  // where a scripting bug or runaway retry loop is more costly.
  ADMIN_SEND: { limit: 30, windowMs: 60_000 },
} as const;
