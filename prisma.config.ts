// Prisma 7 moved CLI-facing configuration (connection URL, schema path,
// migrations path) out of schema.prisma and into this file. The CLI
// (`prisma generate`, `prisma migrate`, `prisma studio`, …) reads this;
// the application's own PrismaClient (src/lib/prisma.ts) is configured
// separately via a driver adapter and does NOT read this file.
//
// shadowDatabaseUrl: Prisma 7 removed the `--shadow-database-url` CLI flag
// from `prisma migrate diff`/`migrate dev` — the shadow DB connection now
// has to be declared here instead. SHADOW_DATABASE_URL is unset in local
// dev (Prisma auto-creates/drops a shadow DB next to DATABASE_URL when
// none is configured) and only set explicitly in CI, where the
// migration-check job points it at a disposable ci_shadow database.
//
// Deliberately process.env.SHADOW_DATABASE_URL here, NOT the env() helper:
// env() throws immediately if the var is missing, and prisma.config.ts is
// loaded by every Prisma CLI command (generate, validate, etc.), not just
// the ones that need a shadow DB. Using env() here would break `prisma
// generate` in every job that doesn't happen to set SHADOW_DATABASE_URL.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
