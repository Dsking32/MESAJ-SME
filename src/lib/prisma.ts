import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 removed the bundled Rust query engine in favor of driver
// adapters — `new PrismaClient()` with no arguments is no longer valid,
// it must be given an `adapter` (or `accelerateUrl`). We use the
// Postgres driver adapter here since this project connects directly to
// Supabase's Postgres via DATABASE_URL.
//
// Note: prisma.config.ts is a *separate*, CLI-only configuration (used by
// `prisma generate`/`migrate`) and is not read at runtime — the adapter
// below is what the running app actually connects through.
//
// SSL: the old Rust engine accepted Supabase's certificate by default;
// the node-pg adapter is stricter and can reject it (P1010 / self-signed
// certificate errors) unless told not to verify it. Supabase's pooled
// connection is already TLS-terminated at their edge, so this is safe —
// but ONLY for Supabase. A local/CI Postgres container (docker-compose,
// GitHub Actions services.postgres, etc.) has no TLS listener at all, and
// forcing ssl there fails with "the server does not support SSL
// connections". So: force ssl for everything except localhost/127.0.0.1.
function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ...(isLocalDatabase(process.env.DATABASE_URL) ? {} : { ssl: { rejectUnauthorized: false } }),
});

// Standard Next.js singleton pattern to avoid exhausting DB connections
// during dev-mode hot reloads.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
