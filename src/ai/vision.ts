import { deepseek, DEEPSEEK_VISION_MODEL } from "./client";
import { logAiUsage } from "./usage";
import { escalateToAnthropicVision } from "./visionEscalation";
import { buildVisionPrompt } from "./visionPrompt";
import { recordAgentIncident } from "./incidents";

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

      // Toda foto de producto pasa por un modelo de vision mas fuerte, no solo las que DeepSeek marca
      // como poco claras. Medido contra la foto real del incidente del 2026-09-14: DeepSeek acerto en 2
      // de 3 corridas y en la tercera invento "una bateria portatil o power bank" con total seguridad -
      // y ese negocio vende una "Bateria portatil power bank 12000 mah", asi que la descripcion
      // equivocada enganchaba fuerte con el producto equivocado. Una descripcion segura y equivocada no
      // se distingue por texto de una correcta, ni por coincidencia con el catalogo: la unica defensa
      // es preguntarle siempre al modelo que ve mejor. A ~4.4 fotos de producto por dia y ~USD 0.01 por
      // llamada, son centavos al mes por negocio.
      if (result.startsWith("PRODUCTO_POCO_CLARO:") || result.startsWith("PRODUCTO:")) {
        const escalated = await escalateToAnthropicVision(businessId, conversationId, imageUrl, caption, catalogHint);
        // Si el modelo fuerte tambien pudo identificarlo, su respuesta manda. Si no pudo (devuelve
        // POCO_CLARO) o la llamada fallo (null), nos quedamos con la de DeepSeek: nunca se pierde
        // informacion por escalar.
        if (escalated?.startsWith("PRODUCTO:")) {
          console.log(`Vision escalada a Anthropic (conversacion ${conversationId}).`);
          return escalated;
        }
      }

      return result;
    } catch (error) {
      console.error(`Error analizando imagen con DeepSeek vision (intento ${attempt}):`, error);
      if (attempt === 2) {
        // Se agotaron los dos intentos: el cliente mando una foto y el bot se quedo sin poder verla.
        // Queda registrado para que se vea en "Salud del bot" y no solo en los logs de produccion.
        await recordAgentIncident(
          businessId,
          "EXTERNAL_API_FAILURE",
          `DeepSeek vision fallo dos veces seguidas: ${error instanceof Error ? error.message : String(error)}`,
          conversationId
        );
        return "No se pudo analizar la imagen (error tecnico). Pedile al cliente que confirme el monto por texto.";
      }
    }
  }
  return "No se pudo analizar la imagen.";
}
