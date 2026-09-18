import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { logAiUsage } from "./usage";
import { buildVisionPrompt } from "./visionPrompt";
import { recordAgentIncident } from "./incidents";

// Sonnet 5, no Haiku: este llamado ya es el ultimo recurso (solo dispara cuando DeepSeek se rindio),
// volumen bajo - la diferencia de costo real es chica (2x, no 10x) y la precision extra en detalle
// visual fino importa justo en este caso (fotos borrosas de un live).
export const ANTHROPIC_VISION_MODEL = "claude-sonnet-5";

// null cuando no hay key configurada - el resto del modulo trata eso como "escalacion apagada", no
// como un error. Asi el bot sigue andando normal en negocios/entornos sin ANTHROPIC_API_KEY.
// Exportado (no una const privada) para poder monkeypatchear anthropic.messages.create en tests,
// El `? :` no es cosmetico: es lo que hace que importar este archivo sea inocuo cuando falta la key.
// El constructor del SDK tira si la apiKey viene vacia, asi que sin ese guard el error saldria al
// IMPORTAR y no al usar la vision. src/ai/transcription.ts tenia ese agujero y en CI dejaba 3 archivos
// de prueba rojos (arreglado el 2026-09-18 con getGroqClient(), construccion diferida).
// timeout/maxRetries por el mismo motivo que DeepSeek (ver src/ai/client.ts) - esta llamada corre en
// medio del turno de un cliente esperando respuesta, no en background.
export const anthropic = env.anthropicApiKey
  ? new Anthropic({ apiKey: env.anthropicApiKey, timeout: 60_000, maxRetries: 1 })
  : null;

const SUPPORTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
type SupportedMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function normalizeMediaType(contentType: string | null): SupportedMediaType {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return (SUPPORTED_MEDIA_TYPES.has(base) ? base : "image/jpeg") as SupportedMediaType;
}

// Segunda opinion, solo llamada cuando DeepSeek ya devolvio PRODUCTO_POCO_CLARO en esa imagen
// especifica (src/ai/vision.ts) - nunca en el caso normal. Cualquier fallo (sin key, red, imagen no
// descargable, respuesta rara) devuelve null y el caller se queda con el resultado original de
// DeepSeek - esta funcion nunca puede romper el flujo de un mensaje.
export async function escalateToAnthropicVision(
  businessId: string,
  conversationId: string,
  imageUrl: string,
  caption: string,
  catalogHint: string,
  paymentExamples: string
): Promise<string | null> {
  if (!anthropic) return null;

  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      // Mismo razonamiento que el catch de abajo: una URL de S3 vencida rompe la escalacion de forma
      // permanente y silenciosa, sin ni siquiera llegar a Anthropic.
      await recordAgentIncident(
        businessId,
        "EXTERNAL_API_FAILURE",
        `No se pudo descargar la imagen para escalar vision (HTTP ${imageResponse.status})`,
        conversationId
      );
      return null;
    }
    const mediaType = normalizeMediaType(imageResponse.headers.get("content-type"));
    const base64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");

    const prompt = buildVisionPrompt(catalogHint, paymentExamples);
    const response = await anthropic.messages.create({
      model: ANTHROPIC_VISION_MODEL,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: caption ? `${prompt}\n\nMensaje del cliente junto a la foto: "${caption}"` : prompt },
          ],
        },
      ],
    });

    const block = response.content.find((c) => c.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";

    await logAiUsage({
      businessId,
      conversationId,
      kind: "VISION_ESCALATION",
      model: ANTHROPIC_VISION_MODEL,
      usage: {
        prompt_cache_miss_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
    });

    return text || null;
  } catch (error) {
    console.error("Error escalando vision a Anthropic:", error);
    // Sin esta fila el fallo es invisible: el caller se queda con lo de DeepSeek y la conversacion
    // sigue normal. Una llave mal configurada dejo esta funcion muerta semanas sin que nadie lo
    // notara, porque "0 escalaciones" se ve igual que "nunca hizo falta escalar".
    await recordAgentIncident(
      businessId,
      "EXTERNAL_API_FAILURE",
      `Anthropic (vision, ${ANTHROPIC_VISION_MODEL}): ${error instanceof Error ? error.message : String(error)}`,
      conversationId
    );
    return null;
  }
}
