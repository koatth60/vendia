import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toOggOpus, extractPeaks, VOICE_PEAKS, VoiceNoteError } from "./voiceNote";

const execFileAsync = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

// Mismo criterio que videoFrame.test.ts: ffmpeg es dependencia del sistema (del droplet), no de npm,
// asi que cada prueba se saltea sola donde no esta en vez de romper la corrida.

/** Genera con ffmpeg un audio sintetico en el formato pedido, sin traer un archivo binario al repo. */
async function generarAudio(codec: string, formato: string, extension: string): Promise<Buffer> {
  const ruta = join(tmpdir(), `${randomUUID()}-fuente.${extension}`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      codec,
      "-f",
      formato,
      ruta,
    ]);
    return await readFile(ruta);
  } finally {
    await unlink(ruta).catch(() => {});
  }
}

test("lo que graba Chrome (Opus adentro de WebM) sale como Ogg/Opus", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg no esta instalado en esta maquina");
    return;
  }

  const webm = await generarAudio("libopus", "webm", "webm");
  const ogg = await toOggOpus(webm);

  assert.equal(ogg.toString("latin1", 0, 4), "OggS", "WhatsApp solo muestra nota de voz si es Ogg");
  assert.ok(ogg.length > 0);
});

test("un audio que NO es Opus (mp3) tambien sale como Ogg/Opus, recodificado", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg no esta instalado en esta maquina");
    return;
  }

  const mp3 = await generarAudio("libmp3lame", "mp3", "mp3");
  const ogg = await toOggOpus(mp3);

  assert.equal(ogg.toString("latin1", 0, 4), "OggS");
});

// La conversion es tambien la puerta que valida el contenido: si ffmpeg no encuentra audio adentro, el
// archivo no era audio. Sin esto, un archivo cualquiera renombrado terminaria subido a S3 y mandado a
// Meta para que lo rechace horas despues.
test("algo que no es audio no se convierte: rebota con VoiceNoteError", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg no esta instalado en esta maquina");
    return;
  }

  await assert.rejects(() => toOggOpus(Buffer.from("esto no es audio")), VoiceNoteError);
});

test("los picos salen del audio: un silencio y un sonido no dibujan la misma onda", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg no esta instalado en esta maquina");
    return;
  }

  // Audio con volumen que sube y baja: la onda TIENE que variar.
  const ruta = join(tmpdir(), `${randomUUID()}-variable.ogg`);
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
      "-af", "volume='0.05+0.95*abs(sin(3*t))':eval=frame",
      "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "ogg", ruta,
    ]);
    const crudo = await extractPeaks(await readFile(ruta));
    assert.ok(crudo, "se esperaba una onda");
    const valores = crudo!.split(",").map(Number);
    assert.equal(valores.length, VOICE_PEAKS, "una barra por valor, sin interpolar en el panel");
    assert.ok(valores.every((v) => v >= 0 && v <= 99), "los valores van de 0 a 99");
    assert.equal(Math.max(...valores), 99, "normalizado: el pico mas alto siempre llega al tope");
    // Lo que se comprueba de verdad: la onda sigue al audio. Con un volumen que sube y baja, el valle
    // tiene que quedar MUY por debajo del pico; si fuera un dibujo decorativo, esto no se cumpliria.
    assert.ok(Math.min(...valores) < 40, `el valle deberia ser bajo, fue ${Math.min(...valores)}`);
  } finally {
    await unlink(ruta).catch(() => {});
  }
});

test("un archivo que no es audio no produce onda, y no rompe el envio", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg no esta instalado en esta maquina");
    return;
  }

  // Devuelve null en vez de lanzar: la onda es un adorno util, nunca un motivo para que un mensaje no
  // se guarde ni para que un audio no se mande.
  assert.equal(await extractPeaks(Buffer.from("esto no es audio")), null);
});
