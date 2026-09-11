import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";
import { logAiUsage } from "./usage";
import { buildVisionPrompt } from "./visionPrompt";

// Sonnet 5, no Haiku: este llamado ya es el ultimo recurso (solo dispara cuando DeepSeek se rindio),
// volumen bajo - la diferencia de costo real es chica (2x, no 10x) y la precision extra en detalle
// visual fino importa justo en este caso (fotos borrosas de un live).
export const ANTHROPIC_VISION_MODEL = "claude-sonnet-5";

// null cuando no hay key configurada - el resto del modulo trata eso como "escalacion apagada", no
// como un error. Asi el bot sigue andando normal en negocios/entornos sin ANTHROPIC_API_KEY.
// Exportado (no una const privada) para poder monkeypatchear anthropic.messages.create en tests,
// mismo patron que "export const groq" en src/ai/transcription.ts.
export const anthropic = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

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
  catalogHint: string
): Promise<string | null> {
  if (!anthropic) return null;

  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) return null;
    const mediaType = normalizeMediaType(imageResponse.headers.get("content-type"));
    const base64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");

    const prompt = buildVisionPrompt(catalogHint);
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
    return null;
  }
}
