import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encryptSecret, isEncrypted } from "../src/crypto/secretBox";

// Fase 8, punto 2 del plan maestro (2026-09-15): re-cifra las filas que ya existen. El codigo nuevo
// cifra todo lo que escribe (ver src/db/client.ts), pero los tokens guardados ANTES de este cambio
// siguen en texto plano en la base hasta que alguien los pase por aca.
//
// Usa un PrismaClient SIN la extension de cifrado a proposito: leer por el cliente extendido
// devolveria el token ya descifrado y no habria forma de distinguir una fila pendiente de una ya
// migrada.
//
// Es idempotente: una fila que ya empieza con el prefijo de version se salta. Correrlo dos veces no
// hace dano y no vuelve a cifrar sobre lo cifrado.
//
//   npx tsx scripts/encrypt-whatsapp-tokens.ts

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  const rows = await prisma.business.findMany({
    where: { whatsappAccessToken: { not: null } },
    select: { id: true, name: true, whatsappAccessToken: true },
  });

  let encrypted = 0;
  let alreadyDone = 0;
  for (const row of rows) {
    const token = row.whatsappAccessToken!;
    if (isEncrypted(token)) {
      alreadyDone += 1;
      continue;
    }
    await prisma.business.update({ where: { id: row.id }, data: { whatsappAccessToken: encryptSecret(token) } });
    encrypted += 1;
    console.log(`Cifrado el token de ${row.name} (${row.id})`);
  }

  console.log(`Listo: ${encrypted} cifrado(s), ${alreadyDone} ya estaba(n) cifrado(s), ${rows.length} fila(s) con token.`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Fallo la migracion de cifrado de tokens:", error);
  process.exit(1);
});
