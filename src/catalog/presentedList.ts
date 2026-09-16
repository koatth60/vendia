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
