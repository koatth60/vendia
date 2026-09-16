import { sendToCustomer, type WhatsappCredentials } from "./outbound";
import { sendMediaWithSpacing } from "./productMedia";
import { recordMediaSent } from "../orders/saleState";
import { prisma } from "../db/client";
import type { CatalogBlock } from "../catalog/presenter";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, piezas 2 y 3).
//
// Envia los mensajes que compuso el servidor, en orden, cada uno con sus medios pegados. Estos bloques
// NO pasan por splitLongMessage: el corte natural ya lo hizo renderCatalog (un mensaje por categoria),
// que es mejor que una guillotina de 700 caracteres a mitad de lista.

// Pausa corta entre mensajes consecutivos, mismo motivo que en sendMediaWithSpacing: WhatsApp a veces
// reordena o no renderiza dos mensajes que salen pegados.
const BLOCK_GAP_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendCatalogBlocksArgs {
  businessId: string;
  conversationId: string;
  credentials: WhatsappCredentials;
  to: string;
  blocks: CatalogBlock[];
}

/**
 * Manda [texto del bloque, ...sus medios] por cada bloque. Los medios ya vienen decididos por el alcance
 * (ver renderCatalog): el modelo no eligio ninguno, no llamo send_product_media y no pudo prometer una
 * foto que no sale.
 *
 * Deja registrado lo enviado en Conversation.mediaSentProductIds y en SaleState.mediaSent. De ahi sale el
 * dedup: 2026-09-16, renderCatalog lee Conversation.mediaSentProductIds antes de adjuntar nada, asi que sin
 * este registro el turno siguiente volveria a mandar las mismas fotos.
 */
export async function sendCatalogBlocks(args: SendCatalogBlocksArgs): Promise<void> {
  const { businessId, conversationId, credentials, to, blocks } = args;
  const sentProductIds: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) await sleep(BLOCK_GAP_MS);
    const block = blocks[i];
    if (block.text.trim()) {
      await sendToCustomer({
        businessId,
        conversationId,
        credentials,
        to,
        content: { kind: "text", text: block.text },
        recordAs: { text: block.text },
      });
    }

    for (const media of block.media) {
      // Un fallo de envio de medios no puede dejar al cliente sin el resto de los bloques: la ficha de
      // texto ya salio y es lo que sostiene la conversacion. Se registra y se sigue.
      try {
        await sendMediaWithSpacing(businessId, credentials, to, conversationId, media.productId, media.productName, media.items);
        sentProductIds.push(media.productId);
        await recordMediaSent(conversationId, media.productName);
      } catch (error) {
        console.error(`No se pudieron enviar los medios de "${media.productName}" (no bloqueante):`, error);
      }
    }
  }

  if (sentProductIds.length === 0) return;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { mediaSentProductIds: true },
    });
    const updated = new Set(conversation?.mediaSentProductIds ?? []);
    for (const id of sentProductIds) updated.add(id);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { mediaSentProductIds: { set: [...updated] } },
    });
  } catch (error) {
    console.error("No se pudo registrar el dedup de medios enviados (no bloqueante):", error);
  }
}
