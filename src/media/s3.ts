import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import { detectFileType, type DetectedFileType, type FileKind } from "./fileType";

let s3: S3Client | null = null;

function getS3Client(): S3Client {
  if (!env.aws.region || !env.aws.bucket) {
    throw new Error("AWS S3 no esta configurado todavia (faltan AWS_REGION / AWS_S3_BUCKET en .env)");
  }
  if (!s3) {
    s3 = new S3Client({
      region: env.aws.region,
      credentials: {
        accessKeyId: env.aws.accessKeyId,
        secretAccessKey: env.aws.secretAccessKey,
      },
    });
  }
  return s3;
}

// Fase 8, punto 7 del plan maestro (2026-09-15). Tope por tipo, no uno solo para todo: 50 MB para un
// video es razonable, para una foto de catalogo no - y el tope mas alto es el que termina definiendo
// cuanto puede ocupar cualquier subida si no se separan.
// Los topes son los de WhatsApp, no unos nuestros mas generosos. Incidente real 2026-09-16: el panel
// aceptaba una foto de 6 MB, la guardaba, le mostraba a la duena que se habia enviado, y Meta la
// rechazaba despues con el error 131053 ("Image file has size 6303812 bytes but must be atmost 5242880
// bytes"). La duena no tenia forma de enterarse: dos fotos a un cliente real nunca llegaron. Un tope
// propio mas alto que el de la plataforma convierte un rechazo visible al subir en una falla silenciosa
// al enviar.
export const MAX_BYTES_BY_KIND: Record<FileKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
};

// Que puede caer en cada carpeta. "receipts" recibe fotos de comprobantes y tambien el cuadro que se
// extrae de un video entrante (ver routes/whatsapp.ts), las dos cosas son imagenes.
const ALLOWED_KINDS_BY_FOLDER: Record<MediaFolder, FileKind[]> = {
  images: ["image"],
  receipts: ["image"],
  videos: ["video"],
  audio: ["audio"],
};

export class RejectedMediaError extends Error {}

export type MediaFolder = "images" | "videos" | "audio" | "receipts";

// Toda la decision de "este archivo se acepta y con que tipo se guarda", separada de la subida para
// poder probarla sin tocar S3 - y para que quede en un solo lugar en vez de repartida entre las rutas.
export function resolveUploadType(
  buffer: Buffer,
  declaredContentType: string,
  folder: MediaFolder
): DetectedFileType {
  // El tipo sale del contenido, no de lo que declara quien sube. Antes la extension era
  // `declaredContentType.split("/")[1]`: subiendo algo como "text/html" quedaba un .html servido con
  // Content-Type: text/html desde el bucket, o sea una pagina ejecutable alojada en nuestro dominio de
  // medios, con una URL que el panel reparte.
  const detected = detectFileType(buffer);
  if (!detected) {
    throw new RejectedMediaError(
      `Tipo de archivo no reconocido (el cliente lo declaro como ${declaredContentType}). Usa JPG, PNG, WEBP, MP4 o audio.`
    );
  }

  // mp4 y m4a son el MISMO contenedor: la unica diferencia es si adentro hay pista de video. Los bytes
  // no alcanzan para separarlos cuando la marca es generica ("isom", "mp42"), que es lo que manda
  // WhatsApp en varias notas de voz. Solo en ese empate se mira lo que declaro quien sube, y solo para
  // elegir entre dos formatos que igual son medios inertes - no para decidir si el archivo se acepta.
  const resolved: DetectedFileType =
    folder === "audio" && detected.mime === "video/mp4" && declaredContentType.startsWith("audio/")
      ? { mime: "audio/mp4", extension: "m4a", kind: "audio" }
      : detected;

  if (!ALLOWED_KINDS_BY_FOLDER[folder].includes(resolved.kind)) {
    throw new RejectedMediaError(`Un archivo ${resolved.mime} no va en ${folder}`);
  }
  if (resolved.mime === "image/gif") {
    throw new RejectedMediaError("Formato GIF no soportado todavía - usa JPG, PNG o video.");
  }

  const maxBytes = MAX_BYTES_BY_KIND[resolved.kind];
  if (buffer.length > maxBytes) {
    throw new RejectedMediaError(
      `El archivo pesa ${Math.round(buffer.length / (1024 * 1024))} MB y el maximo para ${resolved.kind} es ${Math.round(maxBytes / (1024 * 1024))} MB`
    );
  }

  return resolved;
}

export async function uploadMedia(
  buffer: Buffer,
  declaredContentType: string,
  folder: MediaFolder
): Promise<{ key: string; url: string }> {
  const detected = resolveUploadType(buffer, declaredContentType, folder);

  const key = `${folder}/${randomUUID()}.${detected.extension}`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.aws.bucket,
      Key: key,
      Body: buffer,
      ContentType: detected.mime,
    })
  );

  const url = await getPresignedMediaUrl(key);
  return { key, url };
}

// Backups are named by timestamp (not a random key) so they sort and are identifiable in the S3
// console; unlike other media they're never read back through a presigned URL.
export async function uploadBackup(buffer: Buffer, filename: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.aws.bucket,
      Key: `backups/${filename}`,
      Body: buffer,
      ContentType: "application/octet-stream",
    })
  );
}

export async function getPresignedMediaUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.aws.bucket, Key: key });
  return getSignedUrl(getS3Client(), command, { expiresIn: 60 * 60 * 24 * 6 });
}

export async function deleteMedia(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.aws.bucket, Key: key }));
}

/**
 * Los bytes de un objeto de S3, en memoria.
 *
 * Existe para poder SUBIRLE el archivo a Meta en vez de darle una URL nuestra para que lo descargue
 * (ver uploadMediaToWhatsapp). Es la unica lectura de contenido que hace este modulo: todo lo demas
 * entrega URLs firmadas.
 */
export async function downloadMediaBytes(key: string): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await getS3Client().send(new GetObjectCommand({ Bucket: env.aws.bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error(`El objeto ${key} no devolvio contenido`);
  return { buffer: Buffer.from(bytes), contentType: result.ContentType ?? "application/octet-stream" };
}
