import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "../src/db/client";
import { env } from "../src/config/env";
import type { MediaType } from "@prisma/client";
import { excessBytes, isOversized, maxBytesFor } from "../src/media/oversizedMedia";

// Lista los medios YA guardados que superan el tope de WhatsApp, con su producto y su negocio.
//
// Por que hace falta: el tope por tipo (MAX_BYTES_BY_KIND en src/media/s3.ts) frena las subidas nuevas
// desde el 2026-09-16, pero los archivos cargados ANTES siguen en S3 pesando de mas. WhatsApp los
// rechaza en cada intento de envio ("Image file has size 6303812 bytes but must be atmost 5242880 bytes
// and non-empty", repetido en el log de produccion del 2026-09-16): el cliente nunca ve la foto de ese
// producto, y la duena no se entera porque el panel ya se la mostro como cargada.
//
// SOLO LEE. No borra ni modifica nada, ni en S3 ni en la base: una consulta a la base y un HeadObject
// por archivo (que devuelve el tamaño sin descargar el contenido). Que hacer con cada archivo - recortar,
// reemplazar, borrar - lo decide el dueño con esta lista delante.
//
//   npx tsx scripts/list-oversized-media.ts
//   npx tsx scripts/list-oversized-media.ts <businessId>     # solo ese negocio
//
// Necesita AWS_REGION / AWS_S3_BUCKET / credenciales en el entorno, igual que el servidor.

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  if (!env.aws.region || !env.aws.bucket) {
    console.error("Faltan AWS_REGION / AWS_S3_BUCKET en el entorno.");
    process.exit(1);
  }

  const businessId = process.argv[2];
  const media = await prisma.productMedia.findMany({
    where: businessId ? { product: { businessId } } : undefined,
    select: {
      id: true,
      type: true,
      s3Key: true,
      product: { select: { id: true, name: true, business: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Medios en la base: ${media.length}${businessId ? ` (negocio ${businessId})` : ""}`);
  console.log("Consultando el tamaño de cada uno en S3 (HeadObject, solo lectura)...\n");

  const s3 = new S3Client({
    region: env.aws.region,
    credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
  });

  const pasados: { negocio: string; producto: string; tipo: MediaType; bytes: number; exceso: number; s3Key: string }[] = [];
  const sinArchivo: string[] = [];

  for (const item of media) {
    let bytes: number;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: env.aws.bucket, Key: item.s3Key }));
      bytes = head.ContentLength ?? 0;
    } catch {
      // El archivo esta en la base pero no en S3. Es otro problema, y tambien conviene verlo.
      sinArchivo.push(`${item.product.business.name} | ${item.product.name} | ${item.s3Key}`);
      continue;
    }

    if (!isOversized({ type: item.type, bytes })) continue;
    pasados.push({
      negocio: item.product.business.name,
      producto: item.product.name,
      tipo: item.type,
      bytes,
      exceso: excessBytes({ type: item.type, bytes }),
      s3Key: item.s3Key,
    });
  }

  if (pasados.length === 0) {
    console.log("Ningun medio supera el tope. Nada que decidir.");
  } else {
    console.log(`=== ${pasados.length} MEDIOS QUE WHATSAPP RECHAZA AL ENVIAR ===\n`);
    // Por negocio: la decision la toma el dueño de cada catalogo, no una lista mezclada.
    const porNegocio = new Map<string, typeof pasados>();
    for (const p of pasados) {
      const lista = porNegocio.get(p.negocio) ?? [];
      lista.push(p);
      porNegocio.set(p.negocio, lista);
    }
    for (const [negocio, lista] of porNegocio) {
      console.log(`${negocio} (${lista.length})`);
      for (const p of lista) {
        console.log(`  ${p.tipo}  ${mb(p.bytes)} (tope ${mb(maxBytesFor(p.tipo))}, sobra ${mb(p.exceso)})`);
        console.log(`    producto: ${p.producto}`);
        console.log(`    s3Key:    ${p.s3Key}`);
      }
      console.log("");
    }
  }

  if (sinArchivo.length > 0) {
    console.log(`=== ${sinArchivo.length} MEDIOS SIN ARCHIVO EN S3 (no se pudo leer el tamaño) ===`);
    for (const linea of sinArchivo) console.log(`  ${linea}`);
    console.log("");
  }

  console.log("Este script no borro ni modifico nada.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
