import { deepseek, DEEPSEEK_VISION_MODEL } from "./client";
import { logAiUsage } from "./usage";

const VISION_PROMPT = `Estas mirando una imagen que un cliente mando por WhatsApp a un negocio de ventas.

Primero decidi que tipo de imagen es:

1. COMPROBANTE DE PAGO (transferencia bancaria, Nequi, Daviplata, etc): describi en 1-2 frases el monto,
el metodo/banco y la fecha si se alcanzan a leer. Si el monto o los datos no se leen bien, decilo
explicitamente.

2. PRODUCTO, imagen CLARA (foto de un producto, captura de un live/video, captura de otro chat o red
social mostrando un articulo, etc, donde SI se distinguen bien los detalles): el cliente probablemente
esta preguntando "es este el que tienen?" sin saber el nombre exacto. Describi el articulo en detalle
visual util para buscarlo en un catalogo: tipo de producto, color(es), forma, material aparente, y
cualquier texto/marca/modelo visible en la imagen. Se especifico (ej: "reloj inteligente negro, pantalla
rectangular, correa de silicona" en vez de "un reloj").

3. PRODUCTO, imagen POCO CLARA (se nota que es un producto pero esta borrosa, muy oscura, muy lejos,
cortada, o con movimiento - no podes describir los detalles con confianza): decilo explicitamente y en
que consiste el problema (ej: "esta borrosa", "esta muy oscuro", "esta muy lejos para distinguir
detalles"). No inventes ni adivines detalles que no se ven bien.

4. OTRA COSA (persona, paisaje, meme, etc sin relacion con comprobantes ni productos): decilo en una
frase corta.

Empeza la respuesta con "COMPROBANTE:", "PRODUCTO:", "PRODUCTO_POCO_CLARO:" o "OTRO:" segun corresponda,
seguido de la descripcion. No agregues nada mas.`;

export async function analyzeCustomerImage(
  businessId: string,
  conversationId: string,
  imageUrl: string,
  caption: string
): Promise<string> {
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

    await logAiUsage({
      businessId,
      conversationId,
      kind: "VISION",
      model: DEEPSEEK_VISION_MODEL,
      usage: response.usage,
    });

    const text = response.choices[0]?.message?.content;
    return text?.trim() || "No se pudo analizar la imagen.";
  } catch (error) {
    console.error("Error analizando imagen con DeepSeek vision:", error);
    return "No se pudo analizar la imagen (error tecnico). Pedile al cliente que confirme el monto por texto.";
  }
}
