// Prisma 7 moved CLI-facing configuration (connection URL, schema path,
// migrations path) out of schema.prisma and into this file. The CLI
// (`prisma generate`, `prisma migrate`, `prisma studio`, …) reads this;
// the application's own PrismaClient (src/lib/prisma.ts) is configured
// separately via a driver adapter and does NOT read this file.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
