import { prisma } from "../db/client";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 4).
//
// La ultima lista que el servidor le presento DE VERDAD al cliente, en el orden en que salio numerada.
// Antes de esto, "el 3" solo se podia resolver confiando en que el modelo se acordara de su propia
// lista - y como esa lista podia ser prosa inventada, "el 3" podia resolver a un producto que no
// existe. Ahora la escribe el mismo codigo que compuso los bloques.

export async function getLastPresentedProductIds(conversationId: string): Promise<string[]> {
  try {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { lastPresentedProductIds: true },
    });
    return row?.lastPresentedProductIds ?? [];
  } catch (error) {
    // Nunca puede romper el turno: sin lista previa, "el 3" simplemente no resuelve y el modelo
    // responde como antes de esta fase.
    console.error("No se pudo leer la ultima lista presentada (no bloqueante):", error);
    return [];
  }
}

export async function setLastPresentedProductIds(conversationId: string, productIds: string[]): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastPresentedProductIds: { set: productIds } },
    });
  } catch (error) {
    console.error("No se pudo guardar la ultima lista presentada (no bloqueante):", error);
  }
}

/**
 * Los productos cuyos medios YA salieron de verdad en esta conversacion. Es el mismo registro que ya
 * consultaban el auto-envio de get_product_details y send_product_media (`Conversation.mediaSentProductIds`),
 * leido aca para que el presentador tambien lo consulte ANTES de adjuntar fotos y videos: hasta el
 * 2026-09-16 los adjuntaba siempre, y un cliente que volvia a un producto recibia las mismas fotos otra vez.
 *
 * Tambien es lo que marca una ficha como "ya vista": el camino que escribe esta lista es el mismo que
 * manda la ficha entera, asi que un id de aca es un producto que el cliente ya leyo completo.
 */
export async function getMediaSentProductIds(conversationId: string): Promise<string[]> {
  try {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { mediaSentProductIds: true },
    });
    return row?.mediaSentProductIds ?? [];
  } catch (error) {
    // No bloqueante, igual que la lista presentada: sin el registro se cae al comportamiento anterior
    // (se manda la ficha entera con sus medios), nunca se pierde el turno.
    console.error("No se pudo leer el registro de medios ya enviados (no bloqueante):", error);
    return [];
  }
}

/**
 * Los productos cuya FOTO DE VITRINA ya salio en esta conversacion (ver Business.catalogPhotoScope).
 *
 * Es un registro distinto del de arriba, y la diferencia es el punto: haber visto una foto suelta en la
 * vitrina de una categoria NO es haber visto la ficha del producto. Con un solo registro, un cliente que
 * mira una categoria de siete quedaria con los siete marcados como vistos, y el que despues eligiera
 * recibiria una ficha corta sin una sola foto mas.
 */
export async function getBrowsePhotoProductIds(conversationId: string): Promise<string[]> {
  try {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { browsePhotoProductIds: true },
    });
    return row?.browsePhotoProductIds ?? [];
  } catch (error) {
    // No bloqueante como los otros dos: sin el registro la vitrina se manda igual, a lo sumo repitiendo
    // una foto que el cliente ya habia visto.
    console.error("No se pudo leer el registro de fotos de vitrina (no bloqueante):", error);
    return [];
  }
}
