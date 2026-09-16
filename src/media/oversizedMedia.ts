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
// poder probarla sin ninguna de las dos. El que la usa es scripts/list-oversized-media.ts, que solo
// lista: no borra ni modifica nada.

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
