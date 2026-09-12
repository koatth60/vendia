import { deepseek, DEEPSEEK_VISION_MODEL } from "./client";
import { logAiUsage } from "./usage";

// Used by the admin panel when uploading a catalog photo that shows several color options of the
// same product (e.g. one box with white/black/lilac earbuds) - lets the owner add variants by
// quantity instead of typing each color name by hand. Generic across businesses: no business-specific
// wording, just "what product colors are visible in this photo".
const PROMPT = `Estas viendo una foto de catalogo subida por un negocio para su tienda. La foto puede
mostrar UNO o VARIOS productos identicos en distintos colores (ej: 3 cajas del mismo audifono en
blanco, negro y lila).

Identifica cada color de PRODUCTO distinto que se ve en la imagen. Ignora el fondo, el empaque
generico, texto y logos - enfocate en el color del producto en si.

Responde SOLO con los colores en espanol, uno por linea, en minuscula, sin numeracion ni texto
adicional. Si ves un solo producto de un solo color, responde con ese unico color. Si no podes
distinguir colores de producto, responde unicamente con la palabra "ninguno".`;

export async function detectProductColors(businessId: string, imageUrl: string): Promise<string[]> {
  try {
    const response = await deepseek.chat.completions.create({
      model: DEEPSEEK_VISION_MODEL,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types.
      thinking: { type: "disabled" },
    });
    const text = response.choices[0]?.message?.content?.trim() || "";
    await logAiUsage({ businessId, kind: "VISION", model: DEEPSEEK_VISION_MODEL, usage: response.usage });

    if (!text || text.toLowerCase().includes("ninguno")) return [];
    const colors = text
      .split("\n")
      .map((line) => line.replace(/^[-*\d.\s]+/, "").trim().toLowerCase())
      .filter(Boolean);
    return Array.from(new Set(colors));
  } catch (error) {
    console.error("Error detectando colores de producto en la foto:", error);
    return [];
  }
}
