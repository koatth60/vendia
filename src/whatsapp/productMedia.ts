import { sendToCustomer, type WhatsappCredentials } from "./outbound";
import { recordMessage } from "../conversation/service";

// WhatsApp a veces no entrega/renderiza una imagen si sale inmediatamente despues de otra - una pausa
// corta entre envios consecutivos evita esa colision.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Manda las fotos/videos de un producto, una por una, y graba cada envio como su propia fila Message
 * (whatsappMessageId + relatedProductId): asi, cuando el cliente despues responde citando esa foto
 * puntual, el webhook puede resolver de que producto era en vez de que el modelo tenga que adivinar.
 *
 * Vivia dentro de src/ai/tools.ts, privada de send_product_media. Se mudo aca sin cambiarle nada en la
 * Fase B del plan de catalogo y medios (2026-09-16), cuando dejo de haber un solo camino de envio de
 * medios: ahora tambien los manda el caller real (routes/whatsapp.ts) con los bloques que compuso el
 * servidor, y duplicar esta funcion en dos lugares habria sido garantizar que se desincronicen.
 */
export async function sendMediaWithSpacing(
  businessId: string,
  credentials: WhatsappCredentials,
  recipientPhone: string,
  conversationId: string,
  productId: string,
  productName: string,
  media: { type: string; url: string; s3Key: string }[]
): Promise<void> {
  for (let i = 0; i < media.length; i++) {
    if (i > 0) await sleep(1200);
    const item = media[i];
    const mediaType = item.type === "IMAGE" ? "IMAGE" : "VIDEO";
    const result = await sendToCustomer({
      businessId,
      conversationId,
      credentials,
      to: recipientPhone,
      content: mediaType === "IMAGE" ? { kind: "image", url: item.url } : { kind: "video", url: item.url },
    });
    // Se propaga como antes: quien llama a esto necesita saber que la foto NO salio, porque si no el
    // modelo sigue la conversacion como si el cliente ya la estuviera viendo.
    if (!result.delivered) throw new Error(result.failure?.message ?? "No se pudo enviar el medio del producto");
    const wamid = result.wamid;
    await recordMessage(
      businessId,
      conversationId,
      "ASSISTANT",
      `[${mediaType === "IMAGE" ? "Foto" : "Video"} de ${productName}]`,
      wamid || undefined,
      { s3Key: item.s3Key, type: mediaType },
      undefined,
      productId
    );
  }
}
