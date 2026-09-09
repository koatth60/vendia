import OpenAI, { toFile } from "openai";
import { env } from "../config/env";

const groq = new OpenAI({
  apiKey: env.groqApiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    const extension = mimeType.split("/")[1]?.split(";")[0] ?? "ogg";
    const file = await toFile(buffer, `audio.${extension}`);
    const response = await groq.audio.transcriptions.create({
      file,
      model: GROQ_WHISPER_MODEL,
      language: "es",
    });
    return response.text?.trim() ?? "";
  } catch (error) {
    console.error("Error transcribiendo audio con Groq:", error);
    return "";
  }
}
