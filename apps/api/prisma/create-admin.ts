import { PrismaClient, Role } from "@prisma/client";
import * as argon2 from "argon2";
import { PasswordSchema } from "@vexlyx/shared";

/**
 * Creates the initial admin user for a production install (F5.1).
 * Reads VEXLYX_ADMIN_EMAIL / VEXLYX_ADMIN_PASSWORD / VEXLYX_ADMIN_NAME from
 * the environment. Unlike prisma/seed.ts (dev-only, always resets the
 * password), this script only ever creates — if a user with that email
 * already exists, it is left untouched so re-running the installer never
 * resets an existing admin's credentials.
 */
const prisma = new PrismaClient();

async function main() {
  const email = process.env.VEXLYX_ADMIN_EMAIL;
  const password = process.env.VEXLYX_ADMIN_PASSWORD;
  const name = process.env.VEXLYX_ADMIN_NAME || "Admin";

  if (!email || !password) {
    throw new Error(
      "VEXLYX_ADMIN_EMAIL and VEXLYX_ADMIN_PASSWORD must be set",
    );
  }

  const checked = PasswordSchema.safeParse(password);
  if (!checked.success) {
    throw new Error(`VEXLYX_ADMIN_PASSWORD is not acceptable: ${checked.error.issues[0]?.message}`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin user already exists (${email}) — skipping.`);
    return;
  }

  const hashedPassword = await argon2.hash(password, { type: argon2.argon2id });

  const admin = await prisma.user.create({
    data: {
      email,
      name,
      password: hashedPassword,
      role: Role.ADMIN,
    },
  });

  console.log(`Created admin user: ${admin.email} (id: ${admin.id})`);
}

main()
  .catch((error: unknown) => {
    console.error("Admin user creation failed:", error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
