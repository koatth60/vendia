import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { setGroqClientForTests, transcribeAudio } from "./transcription";

// Regression coverage for the retry-on-transient-error fix: a thrown error (network blip, 5xx) used to
// collapse into the exact same silent "" result as genuinely unclear audio, with zero recovery attempt.

// Un cliente de mentira con lo unico que este modulo le pide, inyectado por setGroqClientForTests.
// Antes esto pisaba `groq.audio.transcriptions.create` sobre el cliente real, lo que exigia que el
// cliente real se pudiera construir - o sea, una GROQ_API_KEY en el entorno - solo para poder taparlo.
function stubGroq(create: () => Promise<{ text?: string }>): void {
  setGroqClientForTests({
    audio: { transcriptions: { create } },
  } as unknown as OpenAI);
}

afterEach(() => {
  setGroqClientForTests(null);
});

test("transcribeAudio retries once after a thrown error and returns the transcript on success", async () => {
  let calls = 0;
  stubGroq(async () => {
    calls++;
    if (calls === 1) throw new Error("simulated transient Groq failure");
    return { text: "hola quiero el producto" };
  });

  const result = await transcribeAudio(Buffer.from("fake-audio"), "audio/ogg");
  assert.equal(result, "hola quiero el producto");
  assert.equal(calls, 2, "expected exactly one retry after the first failure");
});

test("transcribeAudio gives up and returns empty string after two consecutive failures (no infinite retry)", async () => {
  let calls = 0;
  stubGroq(async () => {
    calls++;
    throw new Error("simulated persistent Groq failure");
  });

  const result = await transcribeAudio(Buffer.from("fake-audio"), "audio/ogg");
  assert.equal(result, "");
  assert.equal(calls, 2, "expected exactly two attempts total, not an unbounded retry loop");
});

test("transcribeAudio succeeds on the first try without a wasted retry call", async () => {
  let calls = 0;
  stubGroq(async () => {
    calls++;
    return { text: "todo bien" };
  });

  const result = await transcribeAudio(Buffer.from("fake-audio"), "audio/ogg");
  assert.equal(result, "todo bien");
  assert.equal(calls, 1);
});

// NO agregar aca una prueba de "sin GROQ_API_KEY": `env` lee process.env una sola vez al importar, asi
// que borrar la variable dentro de la prueba no la apaga, y en una maquina que SI tiene la key el
// cliente real se construye y transcribeAudio le pega de verdad a Groq (dos veces, por el reintento).
// Esa garantia ya la da la suite completa: en CI corre sin GROQ_API_KEY, y si importar este modulo
// volviera a explotar, estos tres archivos se ponen rojos al instante.
