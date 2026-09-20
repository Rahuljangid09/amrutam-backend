import bcrypt from "bcryptjs";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { emailSchema, passwordSchema } from "../common/schemas";

// Bootstraps the first admin (there is deliberately no public endpoint that can create one).
// Usage: npx tsx src/scripts/createAdmin.ts <email> <password>
async function main() {
  const [emailArg, passwordArg] = process.argv.slice(2);
  const email = emailSchema.safeParse(emailArg);
  const password = passwordSchema.safeParse(passwordArg);
  if (!email.success || !password.success) {
    console.error("Usage: npx tsx src/scripts/createAdmin.ts <email> <password>");
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password.data, env.BCRYPT_ROUNDS);
  const user = await prisma.user.upsert({
    where: { email: email.data },
    update: { role: "ADMIN", passwordHash, isActive: true },
    create: { email: email.data, passwordHash, role: "ADMIN", profile: { create: { fullName: "Administrator" } } },
    select: { id: true, email: true, role: true },
  });
  await prisma.auditLog.create({ data: { actorId: user.id, actorRole: "ADMIN", action: "ADMIN_BOOTSTRAPPED", entityType: "user", entityId: user.id } });
  console.log(`Admin ready: ${user.email} (${user.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
