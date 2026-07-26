/**
 * Promotes an existing user to ADMIN by email, so the very first admin
 * (and any admin recovery scenario — e.g. every admin account locked out)
 * doesn't require hand-editing the database directly.
 *
 * The user must already exist (i.e. they've signed up through the normal
 * /signup flow) — this script only changes their role, it doesn't create
 * an account or set a password. That's deliberate: account creation stays
 * on the one path that goes through Supabase Auth properly.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/bootstrap-admin.ts someone@example.com
 *
 * Requires explicit confirmation before writing, and prints exactly what
 * it's about to change so this can't silently promote the wrong account
 * from a typo.
 */
import "dotenv/config";
import * as readline from "node:readline/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const email = process.argv[2];

  if (!email) {
    console.error("Usage: npx tsx scripts/bootstrap-admin.ts <email>");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to guess which database to connect to.");
    process.exit(1);
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      console.error(
        `No user found with email "${email}". They need to sign up through the app first — ` +
          `this script only changes an existing account's role, it doesn't create one.`
      );
      process.exit(1);
    }

    if (user.role === "ADMIN") {
      console.log(`"${email}" is already an ADMIN. Nothing to do.`);
      return;
    }

    console.log(`About to promote this user to ADMIN:`);
    console.log(`  id:    ${user.id}`);
    console.log(`  email: ${user.email}`);
    console.log(`  role:  ${user.role} -> ADMIN`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Type 'yes' to confirm: ");
    rl.close();

    if (answer.trim().toLowerCase() !== "yes") {
      console.log("Not confirmed — no changes made.");
      return;
    }

    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    console.log(`✔ "${email}" is now an ADMIN.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
