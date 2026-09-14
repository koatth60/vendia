import OpenAI, { toFile } from "openai";
import { env } from "../config/env";

// Exported so tests can monkeypatch groq.audio.transcriptions.create to exercise the retry-on-error
// path without spending real Groq API calls.
// Mismo razonamiento que el timeout de DeepSeek (ver src/ai/client.ts): sin esto, un proveedor que
// acepta la conexion y no responde deja al cliente esperando 10 minutos por intento.
export const groq = new OpenAI({
  apiKey: env.groqApiKey,
  baseURL: "https://api.groq.com/openai/v1",
  timeout: 60_000,
  maxRetries: 1,
});

const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

async function transcribeOnce(buffer: Buffer, mimeType: string): Promise<string> {
  const extension = mimeType.split("/")[1]?.split(";")[0] ?? "ogg";
  const file = await toFile(buffer, `audio.${extension}`);
  const response = await groq.audio.transcriptions.create({
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
