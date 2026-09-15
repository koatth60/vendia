import multer from "multer";
import type { ErrorRequestHandler } from "express";
import { RejectedMediaError, MAX_BYTES_BY_KIND } from "../../media/s3";

// Fase 8, punto 7 del plan maestro (2026-09-15): antes multer aceptaba cualquier tipo de archivo con
// un unico tope de 50 MB. Esta es la primera de dos puertas: rechaza por lo que DECLARA el cliente,
// que es barato y corta lo obvio antes de gastar memoria. La puerta que realmente decide esta en
// uploadMedia, que mira los bytes (ver src/media/fileType.ts) - lo que declara quien sube no es
// prueba de nada.
const ALLOWED_DECLARED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  // Se acepta aca y se rechaza mas adelante con un mensaje propio: WhatsApp no soporta GIF, y un
  // "tipo de archivo no permitido" generico no le dice eso a nadie.
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/3gpp",
  "video/webm",
]);

export class UnsupportedUploadTypeError extends Error {}

export const upload = multer({
  storage: multer.memoryStorage(),
  // El tope duro del transporte es el mayor de los topes por tipo; el tope fino, por tipo de
  // contenido real, lo aplica uploadMedia.
  limits: { fileSize: Math.max(...Object.values(MAX_BYTES_BY_KIND)) },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_DECLARED_TYPES.has(file.mimetype)) {
      cb(new UnsupportedUploadTypeError(`Tipo de archivo no permitido: ${file.mimetype}. Usa JPG, PNG, WEBP o MP4.`));
      return;
    }
    cb(null, true);
  },
});

// Un archivo rechazado es un error del que sube, no una falla del servidor: sin esto sale un 500 y el
// panel muestra "error inesperado" para algo que tiene una explicacion exacta.
export const uploadErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof UnsupportedUploadTypeError || error instanceof RejectedMediaError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    const maxMb = Math.round(Math.max(...Object.values(MAX_BYTES_BY_KIND)) / (1024 * 1024));
    res.status(400).json({ error: `El archivo supera el maximo de ${maxMb} MB` });
    return;
  }
  next(error);
};

export function businessIdOf(req: { session: { businessId?: string } }): string {
  return req.session.businessId as string;
}

// WhatsApp's Cloud API rejects image/gif outright ("Unsupported Image mime type image/gif") - and it
// does so asynchronously, after already accepting the send request, so the caller has no synchronous
// error to react to. Block it at upload time instead of letting it silently fail delivery later.
export function isUnsupportedImageType(mimetype: string): boolean {
  return mimetype === "image/gif";
}
