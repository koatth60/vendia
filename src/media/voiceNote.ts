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

/**
 * Cuantas barras tiene la onda que dibuja el panel. Tiene que ser el mismo numero que VOICE_BARS en
 * public/admin/js/admin.js: el panel dibuja una barra por valor, sin interpolar.
 */
export const VOICE_PEAKS = 44;

const FFMPEG_TIMEOUT_MS = 30_000;

/** Bitrate de voz. 32 kbps mono es lo que usa WhatsApp para sus propias notas de voz. */
const OPUS_BITRATE = "32k";

async function correr(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS });
}

/**
 * La forma de onda de un audio: VOICE_PEAKS numeros de 0 a 99, como texto separado por comas.
 *
 * POR QUE EN EL SERVIDOR. El panel sabe calcularla solo (Web Audio), pero para eso tiene que
 * DESCARGARSE el archivo con fetch, y los audios se sirven con una URL firmada de S3: si el bucket no
 * habilita CORS para este dominio, ese fetch no se puede hacer y la onda no aparece nunca. Aca el
 * archivo ya esta en memoria y ffmpeg ya esta instalado, asi que se calcula una sola vez, cuando el
 * mensaje se guarda, y viaja con el mensaje. El panel deja de depender de una configuracion del bucket.
 *
 * Devuelve null si no se pudo: la onda es un adorno util, nunca un motivo para que un audio no se mande
 * ni para que un mensaje no se guarde.
 */
export async function extractPeaks(input: Buffer): Promise<string | null> {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `${id}-picos`);
  try {
    await writeFile(inputPath, input);
    // PCM crudo, mono, 8 kHz: para dibujar 44 barras no hace falta mas resolucion, y a 8 kHz una nota de
    // dos minutos son 2 MB en memoria en vez de 20.
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-v", "quiet", "-i", inputPath, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }
    );
    const pcm = stdout as unknown as Buffer;
    const muestras = Math.floor(pcm.length / 2);
    if (muestras < VOICE_PEAKS) return null;

    const porBarra = Math.floor(muestras / VOICE_PEAKS);
    const picos: number[] = [];
    let maximo = 0;
    for (let i = 0; i < VOICE_PEAKS; i++) {
      let pico = 0;
      const desde = i * porBarra;
      for (let j = desde; j < desde + porBarra; j++) {
        const valor = Math.abs(pcm.readInt16LE(j * 2));
        if (valor > pico) pico = valor;
      }
      picos.push(pico);
      if (pico > maximo) maximo = pico;
    }
    if (maximo === 0) return null;
    // Normalizado a 0-99: una nota grabada bajito se ve igual de alta que una grabada fuerte. Sin esto
    // la mitad de las notas se dibujan como una linea recta.
    return picos.map((p) => Math.round((p / maximo) * 99)).join(",");
  } catch (error) {
    console.error("No se pudieron calcular los picos del audio:", error);
    return null;
  } finally {
    await unlink(inputPath).catch(() => {});
  }
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
