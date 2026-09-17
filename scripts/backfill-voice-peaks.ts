import { prisma } from "../src/db/client";
import { downloadMediaBytes } from "../src/media/s3";
import { extractPeaks } from "../src/media/voiceNote";

// Rellena Message.mediaPeaks en las notas de voz que se guardaron ANTES de que el servidor calculara la
// onda (ver la migracion media_peaks). Sin esto esas notas siguen mostrando la barra plana para siempre:
// el panel solo puede calcularlas si logra descargarse el audio con fetch, que es justamente lo que el
// CORS del bucket puede impedir.
//
//   tsx scripts/backfill-voice-peaks.ts                 -> solo mira y cuenta, NO escribe
//   tsx scripts/backfill-voice-peaks.ts --apply         -> escribe
//   tsx scripts/backfill-voice-peaks.ts --apply --limit=50
//
// De a uno y en orden a proposito: son descargas de S3 y llamadas a ffmpeg sobre un servidor que al mismo
// tiempo esta atendiendo conversaciones. Rellenar rapido no vale interrumpir una venta.

const APLICAR = process.argv.includes("--apply");
const LIMITE = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0;

/** Una pausa corta entre audios: deja respirar al proceso que esta atendiendo WhatsApp. */
const PAUSA_MS = 150;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pendientes = await prisma.message.findMany({
    where: { mediaType: "AUDIO", mediaPeaks: null, mediaS3Key: { not: null } },
    select: { id: true, mediaS3Key: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    ...(LIMITE > 0 ? { take: LIMITE } : {}),
  });

  console.log(`Notas de voz sin onda: ${pendientes.length}`);
  if (!APLICAR) {
    console.log("Modo de solo lectura. Volve a correrlo con --apply para escribir.");
    await prisma.$disconnect();
    return;
  }
  if (pendientes.length === 0) {
    await prisma.$disconnect();
    return;
  }

  let rellenadas = 0;
  let sinOnda = 0;
  let fallidas = 0;

  for (const [indice, mensaje] of pendientes.entries()) {
    try {
      const { buffer } = await downloadMediaBytes(mensaje.mediaS3Key as string);
      const picos = await extractPeaks(buffer);
      if (!picos) {
        // El archivo esta pero ffmpeg no le encontro audio (truncado, o un formato que no lee). Se deja
        // en null y se sigue: es exactamente lo que pasa con un audio nuevo que tampoco se puede leer.
        sinOnda += 1;
      } else {
        await prisma.message.update({ where: { id: mensaje.id }, data: { mediaPeaks: picos } });
        rellenadas += 1;
      }
    } catch (error) {
      // El caso mas comun es que el objeto ya no este en S3 (borrado, o de un bucket viejo). Un audio que
      // no se puede bajar no puede frenar a los que si.
      fallidas += 1;
      console.error(`  ${mensaje.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if ((indice + 1) % 20 === 0 || indice + 1 === pendientes.length) {
      console.log(`  ${indice + 1}/${pendientes.length} - rellenadas ${rellenadas}, sin onda ${sinOnda}, fallidas ${fallidas}`);
    }
    await esperar(PAUSA_MS);
  }

  console.log(`Listo. Rellenadas ${rellenadas}, sin onda ${sinOnda}, fallidas ${fallidas}.`);
  await prisma.$disconnect();
}

main();
