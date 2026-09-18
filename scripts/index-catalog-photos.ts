import { prisma } from "../src/db/client";
import { indexProductMedia, pendingProductMedia } from "../src/ai/photoIndex";

// Le calcula la ficha visual a las fotos del catalogo que todavia no la tienen (E12b paso 2).
//
// Por que hace falta: desde el 2026-09-18 cada foto que se sube al panel se indexa sola, pero las que
// ya estaban cargadas antes no tienen ficha, y sin ficha no participan del emparejamiento por foto - una
// clienta que manda la captura de un producto viejo del catalogo no lo encuentra.
//
// Cuesta una llamada de vision por foto (~USD 0.01) y se paga UNA vez por foto, no una por consulta.
// Es idempotente: solo toca las que tienen visionDescription en null, asi que se puede correr de nuevo
// sin volver a pagar por las ya indexadas.
//
//   npx tsx scripts/index-catalog-photos.ts
//   npx tsx scripts/index-catalog-photos.ts <businessId>     # solo ese negocio
//
// Necesita las mismas variables de entorno que el servidor (DeepSeek y AWS).

async function main(): Promise<void> {
  const businessId = process.argv[2];
  const pendientes = await pendingProductMedia(businessId);

  if (pendientes.length === 0) {
    console.log("Todas las fotos del catalogo ya tienen ficha visual. Nada que hacer.");
    await prisma.$disconnect();
    return;
  }

  console.log(`${pendientes.length} foto(s) sin ficha visual. Cuesta una llamada de vision por cada una.\n`);
  let listas = 0;
  let fallidas = 0;
  for (const [i, media] of pendientes.entries()) {
    const ok = await indexProductMedia(media.id);
    if (ok) listas++;
    else fallidas++;
    console.log(`  [${i + 1}/${pendientes.length}] ${ok ? "ok " : "FALLO"} ${media.productName}`);
  }

  console.log(`\nIndexadas ${listas}. Sin indexar ${fallidas} (se pueden reintentar corriendo esto de nuevo).`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
