/**
 * True for a Prisma unique-constraint violation (error code P2002).
 * Duck-typed on `.code` rather than `instanceof Prisma.PrismaClientKnownRequestError`
 * so this check doesn't need the real `Prisma` runtime export — P2002 is a
 * stable, documented Prisma error code, so this is safe and one less
 * runtime dependency for a single-purpose check.
 * https://www.prisma.io/docs/orm/reference/error-reference#p2002
 *
 * Originally lived only in the Paystack webhook route (paymentReference
 * idempotency); extracted here so the campaign submit route's
 * idempotencyKey handling can use the exact same check instead of a
 * second copy drifting out of sync.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}
