import { prisma } from "../src/db/client";
import { generateActivationCode } from "../src/auth/service";

async function main() {
  const planTier = (process.argv[2] || "BASICO").toUpperCase() as "BASICO" | "EMPRENDEDOR" | "NEGOCIO";
  const code = generateActivationCode();

  await prisma.activationKey.create({ data: { code, planTier } });
  console.log(`Clave generada para plan ${planTier}: ${code}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
