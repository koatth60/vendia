import OpenAI, { toFile } from "openai";
import { env } from "../config/env";

let groqClient: OpenAI | null = null;

// El cliente se construye en el PRIMER USO, no al importar el modulo. Antes era un `export const groq
// = new OpenAI(...)` al tope: el constructor del SDK tira "Missing credentials" cuando la apiKey viene
// vacia, asi que sin GROQ_API_KEY el error no ocurria al transcribir un audio - ocurria al IMPORTAR,
// y se llevaba puesto a todo el que importara este archivo, aunque fuera de refilon. Medido en CI el
// 2026-09-18: 3 archivos de prueba enteros rojos (transcription, whatsapp, whatsapp.webhook; los dos
// ultimos ni transcriben nada, solo importan src/routes/whatsapp.ts) con un mensaje que nombra
// OPENAI_API_KEY y no menciona Groq en ninguna parte. En un despliegue sin la variable el sintoma es
// peor: el servidor no arranca, en vez de arrancar sin transcribir audios.
// Mismo patron que getS3Client() en src/media/s3.ts, y por el mismo motivo.
// El timeout va por el mismo razonamiento que el de DeepSeek (ver src/ai/client.ts): sin esto, un
// proveedor que acepta la conexion y no responde deja al cliente esperando 10 minutos por intento.
export function getGroqClient(): OpenAI {
  if (groqClient) return groqClient;
  if (!env.groqApiKey) {
    throw new Error("Groq no esta configurado todavia (falta GROQ_API_KEY en .env)");
  }
  groqClient = new OpenAI({
    apiKey: env.groqApiKey,
    baseURL: "https://api.groq.com/openai/v1",
    timeout: 60_000,
    maxRetries: 1,
  });
  return groqClient;
}

// Punto de inyeccion para las pruebas: reemplaza el cliente sin necesidad de una GROQ_API_KEY de
// mentira en el entorno. Antes las pruebas monkeypatcheaban `groq.audio.transcriptions.create`, lo
// que obligaba a que el cliente real existiera (y por lo tanto a tener la variable) solo para poder
// pisarlo. `null` vuelve al cliente real.
export function setGroqClientForTests(client: OpenAI | null): void {
  groqClient = client;
}

const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

async function transcribeOnce(buffer: Buffer, mimeType: string): Promise<string> {
  const extension = mimeType.split("/")[1]?.split(";")[0] ?? "ogg";
  const file = await toFile(buffer, `audio.${extension}`);
  const response = await getGroqClient().audio.transcriptions.create({
    file,
    model: GROQ_WHISPER_MODEL,
    language: "es",
  });
  return response.text?.trim() ?? "";
}

// Retries once on a thrown error (network blip, transient 5xx) before giving up - a transient API
// failure used to collapse into the exact same "no pude transcribir" outcome as audio that's genuinely
// unclear, with no way to tell them apart or recover from the former automatically.
export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    return await transcribeOnce(buffer, mimeType);
  } catch (error) {
    console.error("Error transcribiendo audio con Groq (intento 1):", error);
    try {
      return await transcribeOnce(buffer, mimeType);
    } catch (retryError) {
      console.error("Error transcribiendo audio con Groq (intento 2, abandonado):", retryError);
      return "";
    }
  }
}
