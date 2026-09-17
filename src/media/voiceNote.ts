import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// POR QUE EXISTE ESTE ARCHIVO
//
// WhatsApp muestra una nota de voz (la burbuja con la onda y el play) solo si el audio llega en
// Ogg/Opus. El navegador no puede grabar eso: Chrome y Firefox graban Opus pero dentro de un
// contenedor WebM, y Safari graba AAC dentro de MP4. Mandar el WebM tal cual lo rechaza Meta.
//
// La conversion NO es recodificar. Chrome ya entrega Opus; lo unico que cambia es el envoltorio, asi
// que ffmpeg copia el flujo de audio tal cual (-c:a copy) y lo mete en Ogg. Es instantaneo y no pierde
// nada. El recodificado a Opus queda como segundo intento, para los audios que NO vienen en Opus (un
// mp3 o un m4a que el dueno sube desde el disco, o lo que graba Safari).
//
// El unico tope real es que ffmpeg tiene que poder leerlo: un archivo que no es audio no produce una
// pista de audio y las dos pasadas fallan, asi que la conversion tambien es la puerta que valida el
// contenido - igual que detectFileType para las fotos.

export class VoiceNoteError extends Error {}

const FFMPEG_TIMEOUT_MS = 30_000;

/** Bitrate de voz. 32 kbps mono es lo que usa WhatsApp para sus propias notas de voz. */
const OPUS_BITRATE = "32k";

async function correr(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS });
}

/**
 * Deja el audio en Ogg/Opus mono, que es lo que WhatsApp entrega como nota de voz.
 *
 * Devuelve los bytes convertidos. Lanza VoiceNoteError si ffmpeg no pudo leer el archivo por ninguno
 * de los dos caminos: eso significa que lo que llego no es audio que WhatsApp pueda reproducir.
 */
export async function toOggOpus(input: Buffer): Promise<Buffer> {
  const id = randomUUID();
  // La extension de entrada no importa: ffmpeg mira el contenido, igual que detectFileType.
  const inputPath = join(tmpdir(), `${id}-in`);
  const outputPath = join(tmpdir(), `${id}-out.ogg`);

  try {
    await writeFile(inputPath, input);

    try {
      // Camino rapido: ya es Opus, solo cambia el envoltorio.
      await correr(["-y", "-i", inputPath, "-vn", "-c:a", "copy", "-f", "ogg", outputPath]);
    } catch {
      // No era Opus (o el copiado no se pudo). Se recodifica a Opus mono.
      try {
        await correr([
          "-y",
          "-i",
          inputPath,
          "-vn",
          "-c:a",
          "libopus",
          "-b:a",
          OPUS_BITRATE,
          "-ac",
          "1",
          "-f",
          "ogg",
          outputPath,
        ]);
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        throw new VoiceNoteError(
          `No se pudo preparar el audio para WhatsApp. El archivo no parece ser audio que se pueda convertir: ${detalle.slice(0, 200)}`
        );
      }
    }

    const salida = await readFile(outputPath);
    // Un Ogg valido empieza con "OggS". Sin este chequeo, un ffmpeg que devuelve 0 pero escribe un
    // archivo vacio (pasa con entradas truncadas) terminaria subiendo 0 bytes a S3 y a Meta.
    if (salida.length === 0 || salida.toString("latin1", 0, 4) !== "OggS") {
      throw new VoiceNoteError("La conversion del audio no produjo un archivo Ogg valido");
    }
    return salida;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}
