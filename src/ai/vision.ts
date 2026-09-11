import { deepseek, DEEPSEEK_VISION_MODEL } from "./client";
import { logAiUsage } from "./usage";
import { escalateToAnthropicVision } from "./visionEscalation";
import { buildVisionPrompt } from "./visionPrompt";

async function analyzeOnce(imageUrl: string, caption: string, catalogHint: string) {
  const prompt = buildVisionPrompt(catalogHint);
  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_VISION_MODEL,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          {
            type: "text",
            text: caption ? `${prompt}\n\nMensaje del cliente junto a la foto: "${caption}"` : prompt,
          },
        ],
      },
    ],
    // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types.
    thinking: { type: "disabled" },
  });
  const text = response.choices[0]?.message?.content;
  return { text: text?.trim() || "", usage: response.usage };
}

// Retries once on a thrown error (network blip, transient 5xx) before giving up on the whole image -
// a transient API failure used to permanently fall back to "no pude ver la imagen" for that message,
// same as a real unrecoverable error, with no automatic recovery attempt.
export async function analyzeCustomerImage(
  businessId: string,
  conversationId: string,
  imageUrl: string,
  caption: string,
  catalogHint = ""
): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, usage } = await analyzeOnce(imageUrl, caption, catalogHint);
      await logAiUsage({ businessId, conversationId, kind: "VISION", model: DEEPSEEK_VISION_MODEL, usage });
      const result = text || "No se pudo analizar la imagen.";

      // DeepSeek ya se rindio con esta imagen especifica (borrosa/oscura/lejos) - antes de aceptar
      // eso como respuesta final, le damos una segunda opinion a un modelo de vision mas fuerte. Esto
      // es lo unico que dispara la llamada a Anthropic (nunca en el caso normal/claro) para no gastar
      // esa API mas de lo estrictamente necesario.
      if (result.startsWith("PRODUCTO_POCO_CLARO:")) {
        const escalated = await escalateToAnthropicVision(businessId, conversationId, imageUrl, caption, catalogHint);
        if (escalated?.startsWith("PRODUCTO:")) {
          console.log(`Vision escalada a Anthropic resolvio una imagen que DeepSeek no pudo (conversacion ${conversationId}).`);
          return escalated;
        }
      }

      return result;
    } catch (error) {
      console.error(`Error analizando imagen con DeepSeek vision (intento ${attempt}):`, error);
      if (attempt === 2) {
        return "No se pudo analizar la imagen (error tecnico). Pedile al cliente que confirme el monto por texto.";
      }
    }
  }
  return "No se pudo analizar la imagen.";
}
