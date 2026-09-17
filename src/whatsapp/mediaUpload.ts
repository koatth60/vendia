import { prisma } from "../db/client";
import { downloadMediaBytes } from "../media/s3";
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
 * Lo que hay que mandarle a Meta para este archivo: un id ya subido, o la URL de respaldo.
 *
 * `s3Key` identifica la fila de ProductMedia, que es donde vive el cache. Un medio que no este en el
 * catalogo (el comprobante que mando un cliente, por ejemplo) no tiene fila: se sube igual, sin cachear,
 * porque igual se manda una sola vez.
 */
export async function resolveSendableMedia(
  credentials: WhatsappCredentials,
  media: { url: string; s3Key: string }
): Promise<string> {
  try {
    const row = await prisma.productMedia.findFirst({
      where: { s3Key: media.s3Key },
      select: { id: true, whatsappMediaId: true, whatsappMediaAt: true, whatsappMediaPhoneId: true },
    });
    if (row && cachedMediaIdIsUsable(row, credentials.phoneNumberId)) return row.whatsappMediaId!;

    const { buffer, contentType } = await downloadMediaBytes(media.s3Key);
    const mediaId = await uploadMediaToWhatsapp(credentials, buffer, contentType, media.s3Key.split("/").pop() || "media");

    if (row) {
      await prisma.productMedia.update({
        where: { id: row.id },
        data: { whatsappMediaId: mediaId, whatsappMediaAt: new Date(), whatsappMediaPhoneId: credentials.phoneNumberId },
      });
    }
    return mediaId;
  } catch (error) {
    // Nunca bloqueante: el camino viejo (Meta descarga la URL) sigue existiendo y es el respaldo.
    console.error(`No se pudo subir el medio a WhatsApp (${media.s3Key}), se manda por link:`, error);
    return media.url;
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
