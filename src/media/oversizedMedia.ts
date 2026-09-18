import type { MediaType } from "@prisma/client";
import { MAX_BYTES_BY_KIND } from "./s3";
import type { FileKind } from "./fileType";

// El tope por tipo (MAX_BYTES_BY_KIND en s3.ts) frena las subidas NUEVAS desde el 2026-09-16, pero no
// dice nada de lo que ya estaba en S3. Un archivo cargado antes de ese tope sigue ahi pesando de mas y
// WhatsApp lo rechaza en CADA intento de envio ("Image file has size 6303812 bytes but must be atmost
// 5242880 bytes and non-empty", produccion 2026-09-16): el cliente nunca ve la foto de ese producto y la
// duena no se entera, porque el panel ya le mostro la foto como cargada.
//
// Esta pieza es la decision pura - que archivo pasa el tope y cual no - separada de S3 y de la base para
// poder probarla sin ninguna de las dos. La usan los tres lugares que necesitan la misma respuesta:
// resolveSendableMedia antes de mandar nada a Meta, el panel para marcar la foto, y
// scripts/list-oversized-media.ts para medir el catalogo entero de una.

/** El tipo con el que la base guarda un medio, traducido al tipo con el que s3.ts define los topes. */
export function kindOfMediaType(type: MediaType): FileKind {
  if (type === "VIDEO") return "video";
  if (type === "AUDIO") return "audio";
  return "image";
}

export function maxBytesFor(type: MediaType): number {
  return MAX_BYTES_BY_KIND[kindOfMediaType(type)];
}

/** Un medio ya guardado, con el peso que de verdad tiene en S3. */
export interface StoredMedia {
  type: MediaType;
  bytes: number;
}

/**
 * True cuando ese archivo ya no se puede enviar por WhatsApp. El tope es el mismo que frena las subidas
 * nuevas, a proposito: si estas dos listas se separaran, el panel volveria a aceptar archivos que el
 * envio despues rechaza, que es exactamente el defecto que el tope vino a cerrar.
 */
export function isOversized(media: StoredMedia): boolean {
  return media.bytes > maxBytesFor(media.type);
}

/** Cuanto pesa de mas, en bytes. Es lo que hay que recortar para que el envio deje de fallar. */
export function excessBytes(media: StoredMedia): number {
  return Math.max(0, media.bytes - maxBytesFor(media.type));
}

/**
 * Por que este archivo no se puede mandar por WhatsApp, o null si se puede.
 *
 * El texto es el que ve la duena (en el panel y en Bot > Salud), asi que dice el peso real, el tope y
 * que hacer: una foto pesada no se arregla sola, hay que reemplazarla por una mas liviana.
 *
 * `bytes` en null significa "todavia no se midio", NO "esta bien". Un archivo sin medir se manda igual
 * y se mide en el intento (ver resolveSendableMedia): bloquear lo no medido dejaria sin fotos a todo
 * catalogo cargado antes de la columna, que es empeorar el comportamiento actual para prevenir un caso
 * que el propio envio ya resuelve.
 */
export function unsendableReason(media: { type: MediaType; bytes: number | null }): string | null {
  if (media.bytes === null) return null;
  if (!isOversized({ type: media.type, bytes: media.bytes })) return null;
  const esVideo = media.type === "VIDEO";
  const sujeto = esVideo ? "El video" : "La foto";
  const reemplazo = esVideo ? "Reemplazalo por uno mas liviano" : "Reemplazala por una mas liviana";
  return `${sujeto} pesa ${mb(media.bytes)} y WhatsApp no acepta mas de ${mb(maxBytesFor(media.type))}. ${reemplazo} en Catalogo.`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
