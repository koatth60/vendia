import { deepseek, DEEPSEEK_VISION_MODEL } from "./client";

const VISION_PROMPT = `Estas mirando una imagen que un cliente mando por WhatsApp a un negocio, probablemente un
comprobante de pago (transferencia bancaria, Nequi, Daviplata, etc).

Describi en 1-2 frases cortas, en espanol neutro, lo que ves. Si parece un comprobante de pago, indica el
monto, el metodo/banco y la fecha si se alcanzan a leer. Si el monto o los datos no se leen bien, decilo
explicitamente. Si la imagen NO parece un comprobante de pago, decí solo que no lo es y que muestra.

No agregues nada mas, solo la descripcion.`;

export async function analyzeReceiptImage(imageUrl: string, caption: string): Promise<string> {
  try {
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
              text: caption ? `${VISION_PROMPT}\n\nMensaje del cliente junto a la foto: "${caption}"` : VISION_PROMPT,
            },
          ],
        },
      ],
      // @ts-expect-error DeepSeek-specific param, not in the OpenAI SDK types.
      thinking: { type: "disabled" },
    });

    const text = response.choices[0]?.message?.content;
    return text?.trim() || "No se pudo analizar la imagen.";
  } catch (error) {
    console.error("Error analizando imagen con DeepSeek vision:", error);
    return "No se pudo analizar la imagen (error tecnico). Pedile al cliente que confirme el monto por texto.";
  }
}
