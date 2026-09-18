import { prisma } from "../db/client";
import { downloadMediaBytes } from "../media/s3";
import { unsendableReason } from "../media/oversizedMedia";
import { uploadMediaToWhatsapp, WHATSAPP_MEDIA_TTL_DAYS, type WhatsappCredentials } from "./outbound";

// EL ARCHIVO VIAJA UNA VEZ, HACIA META (2026-09-17).
//
// Hasta hoy, mandar una foto era darle a Meta la URL firmada de nuestro S3 para que la descargara. Ese
// paso es el unico de toda la cadena que no controlamos, y cuando falla Meta contesta 131053
// ("Downloading media from weblink failed with http code 500"): la foto NUNCA llega, el envio ya habia
// devuelto un wamid, y el error recien aparece horas despues por el webhook de estados. Tres veces en
// siete dias contra clientes reales, sin que nadie se enterara.
//
// Subiendo el archivo desaparece la clase entera de falla:
//   - Si algo sale mal, sale mal ACA, de forma sincrona, y se puede degradar en el acto.
//   - Meta guarda el archivo y devuelve un id reusable 30 dias, asi que la misma foto de catalogo no se
//     sube de nuevo en cada envio: se sube una vez y despues viaja un id.
//   - S3 deja de estar en el camino critico de cada envio.
//
// Si la subida falla por lo que sea, se devuelve la URL de siempre y el envio sigue como antes. Este
// mecanismo solo puede mejorar la entrega, nunca impedirla.

/** Un id cacheado sirve si no vencio Y si lo subio la misma linea de WhatsApp que va a enviarlo. */
export function cachedMediaIdIsUsable(
  row: { whatsappMediaId: string | null; whatsappMediaAt: Date | null; whatsappMediaPhoneId: string | null },
  phoneNumberId: string,
  now: Date = new Date()
): boolean {
  if (!row.whatsappMediaId || !row.whatsappMediaAt) return false;
  if (row.whatsappMediaPhoneId !== phoneNumberId) return false;
  const edadDias = (now.getTime() - row.whatsappMediaAt.getTime()) / (24 * 60 * 60 * 1000);
  return edadDias < WHATSAPP_MEDIA_TTL_DAYS;
}

/**
 * El resultado de preparar un archivo para enviarlo: o hay algo que mandarle a Meta (un id ya subido, o
 * la URL de respaldo), o este archivo no se puede enviar y el motivo es para que lo lea una persona.
 *
 * Es un resultado y no una excepcion porque "esta foto pesa de mas" no es un error del sistema: es un
 * dato del catalogo que alguien tiene que arreglar, y quien llama necesita poder contarlo (E17).
 */
export type SendableMedia = { ok: true; value: string } | { ok: false; reason: string };

/** La fila del catalogo de este archivo, o null si no es un medio del catalogo (o si la base fallo). */
async function findCatalogRow(s3Key: string) {
  try {
    return await prisma.productMedia.findFirst({
      where: { s3Key },
      select: {
        id: true,
        type: true,
        bytes: true,
        whatsappMediaId: true,
        whatsappMediaAt: true,
        whatsappMediaPhoneId: true,
      },
    });
  } catch (error) {
    console.error(`No se pudo leer el medio del catalogo (${s3Key}):`, error);
    return null;
  }
}

/**
 * Lo que hay que mandarle a Meta para este archivo: un id ya subido, o la URL de respaldo.
 *
 * `s3Key` identifica la fila de ProductMedia, que es donde vive el cache. Un medio que no este en el
 * catalogo (el comprobante que mando un cliente, por ejemplo) no tiene fila: se sube igual, sin cachear,
 * porque igual se manda una sola vez.
 *
 * ANTES DE INTENTAR NADA SE MIRA EL PESO (E17, 2026-09-18). Un archivo cargado antes del tope del
 * 2026-09-16 pesa de mas y WhatsApp lo rechaza siempre; con el respaldo de aca abajo eso terminaba en el
 * camino viejo (Meta descarga la URL) y volvia a fallar asincrono, sin que nadie se enterara. Un archivo
 * que no se puede enviar no llega a Meta por ningun camino.
 *
 * El peso tambien se COMPLETA aca: para subirle el archivo a Meta ya hay que bajarlo de S3, asi que
 * medirlo no cuesta una sola llamada extra. Por eso el catalogo viejo se mide solo, a medida que se
 * manda, sin que nadie tenga que acordarse de correr nada.
 */
export async function resolveSendableMedia(
  credentials: WhatsappCredentials,
  media: { url: string; s3Key: string }
): Promise<SendableMedia> {
  const row = await findCatalogRow(media.s3Key);

  if (row) {
    const yaMedido = unsendableReason(row);
    if (yaMedido) return { ok: false, reason: yaMedido };
    if (cachedMediaIdIsUsable(row, credentials.phoneNumberId)) return { ok: true, value: row.whatsappMediaId! };
  }

  try {
    const { buffer, contentType } = await downloadMediaBytes(media.s3Key);

    if (row) {
      const recienMedido = unsendableReason({ type: row.type, bytes: buffer.length });
      if (row.bytes !== buffer.length) {
        await prisma.productMedia.update({ where: { id: row.id }, data: { bytes: buffer.length } });
      }
      // El peso queda guardado aunque el archivo no sirva - sobre todo si no sirve: es lo que hace que el
      // panel pueda marcar esa foto sin esperar a que alguien intente mandarla otra vez.
      if (recienMedido) return { ok: false, reason: recienMedido };
    }

    const mediaId = await uploadMediaToWhatsapp(credentials, buffer, contentType, media.s3Key.split("/").pop() || "media");

    if (row) {
      await prisma.productMedia.update({
        where: { id: row.id },
        data: { whatsappMediaId: mediaId, whatsappMediaAt: new Date(), whatsappMediaPhoneId: credentials.phoneNumberId },
      });
    }
    return { ok: true, value: mediaId };
  } catch (error) {
    // Nunca bloqueante: el camino viejo (Meta descarga la URL) sigue existiendo y es el respaldo. Un
    // archivo que YA se sabe que pesa de mas no llega hasta aca, asi que este respaldo no puede volver a
    // producir el 131053 por tamano.
    console.error(`No se pudo subir el medio a WhatsApp (${media.s3Key}), se manda por link:`, error);
    return { ok: true, value: media.url };
  }
}

/**
 * Invalida el id cacheado de un archivo. Lo llama la capa de salida cuando Meta rechaza un envio por el
 * medio: un id vencido o borrado del lado de Meta se cura solo en el proximo envio, que lo vuelve a subir.
 */
export async function forgetWhatsappMediaId(s3Key: string): Promise<void> {
  try {
    await prisma.productMedia.updateMany({
      where: { s3Key },
      data: { whatsappMediaId: null, whatsappMediaAt: null, whatsappMediaPhoneId: null },
    });
  } catch (error) {
    console.error(`No se pudo limpiar el id de medio de WhatsApp (${s3Key}):`, error);
  }
}
