/**
 * Verifies the assumption the RLS migration depends on: that DATABASE_URL
 * connects as a role which bypasses Row-Level Security (Supabase's default
 * `postgres` role does, via rolbypassrls or rolsuper).
 *
 * Why this matters: prisma/migrations/20260727100000_enable_row_level_security
 * enables RLS on every tenant-scoped table. That's safe ONLY because Prisma
 * (via DATABASE_URL) connects as a role that bypasses RLS — if it didn't,
 * every existing route would start silently returning empty results instead
 * of real data, since Prisma's queries carry no `auth.uid()` for RLS's
 * policies to match against.
 *
 * The migration's own comments say to check this by hand with:
 *   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
 * This script runs that same check programmatically, so it can be run
 * before a deploy (or wired into CI) instead of relying on someone
 * remembering to run it manually.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/verify-rls.ts
 *
 * Exit code 0 = safe (bypasses RLS as expected). Exit code 1 = NOT safe —
 * do not deploy the RLS migration against this DATABASE_URL until this
 * passes, or every tenant-scoped query will start returning nothing.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const rows = await prisma.$queryRawUnsafe<
      { rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]
    >(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;`);

    const row = rows[0];
    if (!row) {
      console.error("Could not resolve current_user against pg_roles — unexpected, investigate manually.");
      process.exit(1);
    }

    console.log(`Connected as role: ${row.rolname}`);
    console.log(`  rolbypassrls: ${row.rolbypassrls}`);
    console.log(`  rolsuper:     ${row.rolsuper}`);

    if (row.rolbypassrls || row.rolsuper) {
      console.log(
        "\n✅ Safe: this role bypasses RLS, so the RLS migration only restricts anon/authenticated " +
          "access (e.g. direct PostgREST/supabase-js calls) — the app's own Prisma queries are unaffected."
      );
      process.exit(0);
    }

    console.error(
      "\n❌ NOT SAFE: this role does NOT bypass RLS. Enabling RLS on tenant tables will make every " +
        "existing Prisma-backed route start returning empty results instead of real data. Either point " +
        "DATABASE_URL at a role that bypasses RLS (Supabase's default `postgres` role does), or add " +
        "explicit policies granting this role access before relying on the RLS migration."
    );
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("verify-rls failed:", err);
  process.exit(1);
});
