// Fase 8, punto 7 del plan maestro (2026-09-15): hasta ahora la extension y el Content-Type del
// objeto en S3 salian de lo que declaraba el cliente (`contentType.split("/")[1]`). Un archivo
// subido como "text/html" quedaba guardado como .html y servido con Content-Type: text/html desde el
// bucket - o sea, una pagina ejecutable alojada en nuestro dominio de medios, cargada por una URL que
// el panel reparte. El tipo tiene que salir del contenido, no de quien lo manda.
//
// Los bytes de cabecera de cada formato son fijos y publicos; se comparan a mano para no depender de
// una libreria mas ni de expresiones regulares.

export type FileKind = "image" | "video" | "audio" | "document";

export interface DetectedFileType {
  mime: string;
  extension: string;
  kind: FileKind;
}

function startsWithBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buffer: Buffer, offset: number, length: number): string {
  if (buffer.length < offset + length) return "";
  return buffer.toString("latin1", offset, offset + length);
}

// Los contenedores tipo ISO-BMFF (mp4, mov, 3gp, m4a) comparten cabecera: el tipo real lo dice la
// "marca mayor" que va justo despues de "ftyp".
function detectIsoContainer(buffer: Buffer): DetectedFileType | null {
  if (asciiAt(buffer, 4, 4) !== "ftyp") return null;
  const brand = asciiAt(buffer, 8, 4);
  if (brand === "qt  ") return { mime: "video/quicktime", extension: "mov", kind: "video" };
  if (brand.startsWith("3g")) return { mime: "video/3gpp", extension: "3gp", kind: "video" };
  if (brand === "M4A " || brand === "M4B ") return { mime: "audio/mp4", extension: "m4a", kind: "audio" };
  return { mime: "video/mp4", extension: "mp4", kind: "video" };
}

// Un .docx, .xlsx y .pptx son el MISMO formato en los bytes: un ZIP cuya primera entrada se llama
// "[Content_Types].xml". La diferencia esta adentro del ZIP, comprimida. Se reconoce el contenedor
// aca y cual de los tres es se desempata con el tipo declarado en resolveUploadType - el mismo
// criterio que ya se usa para mp4 vs m4a, y por la misma razon: los tres son documentos inertes, asi
// que lo declarado elige entre iguales, nunca decide si el archivo se acepta.
//
// Un ZIP cualquiera (o un .zip renombrado a .docx) NO tiene esa primera entrada y queda afuera. Es a
// proposito: un contenedor generico puede traer cualquier cosa adentro y no hay forma de mirarlo por
// los bytes de cabecera.
function detectOfficeZip(buffer: Buffer): DetectedFileType | null {
  if (!startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04])) return null;
  if (buffer.length < 30) return null;
  const nameLength = buffer.readUInt16LE(26);
  if (asciiAt(buffer, 30, nameLength) !== "[Content_Types].xml") return null;
  return {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    kind: "document",
  };
}

export function detectFileType(buffer: Buffer): DetectedFileType | null {
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", extension: "jpg", kind: "image" };
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: "png", kind: "image" };
  }
  const gifHeader = asciiAt(buffer, 0, 6);
  // Se detecta a proposito aunque WhatsApp lo rechace (ver isUnsupportedImageType): un GIF tiene que
  // rebotar como "formato no soportado", no colarse como algo que no es.
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return { mime: "image/gif", extension: "gif", kind: "image" };

  if (asciiAt(buffer, 0, 5) === "%PDF-") return { mime: "application/pdf", extension: "pdf", kind: "document" };
  const officeZip = detectOfficeZip(buffer);
  if (officeZip) return officeZip;

  if (asciiAt(buffer, 0, 4) === "RIFF") {
    const riffKind = asciiAt(buffer, 8, 4);
    if (riffKind === "WEBP") return { mime: "image/webp", extension: "webp", kind: "image" };
    if (riffKind === "WAVE") return { mime: "audio/wav", extension: "wav", kind: "audio" };
    return null;
  }

  const iso = detectIsoContainer(buffer);
  if (iso) return iso;

  // Matroska / WebM.
  if (startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", extension: "webm", kind: "video" };
  // WhatsApp manda las notas de voz en Ogg/Opus.
  if (asciiAt(buffer, 0, 4) === "OggS") return { mime: "audio/ogg", extension: "ogg", kind: "audio" };
  if (asciiAt(buffer, 0, 5) === "#!AMR") return { mime: "audio/amr", extension: "amr", kind: "audio" };
  // AAC crudo (ADTS), uno de los formatos que WhatsApp usa para las notas de voz.
  if (startsWithBytes(buffer, [0xff, 0xf1]) || startsWithBytes(buffer, [0xff, 0xf9])) {
    return { mime: "audio/aac", extension: "aac", kind: "audio" };
  }
  if (asciiAt(buffer, 0, 3) === "ID3") return { mime: "audio/mpeg", extension: "mp3", kind: "audio" };
  // Un mp3 sin etiqueta ID3 arranca directo con la cabecera de cuadro.
  if (
    startsWithBytes(buffer, [0xff, 0xfb]) ||
    startsWithBytes(buffer, [0xff, 0xf3]) ||
    startsWithBytes(buffer, [0xff, 0xf2])
  ) {
    return { mime: "audio/mpeg", extension: "mp3", kind: "audio" };
  }

  return null;
}
