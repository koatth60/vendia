import { sendToCustomer, type WhatsappCredentials } from "./outbound";
import { sendMediaWithSpacing } from "./productMedia";
import { recordMediaSent } from "../orders/saleState";
import { prisma } from "../db/client";
import { rowsAreListable, listBodyText, type CatalogBlock } from "../catalog/presenter";

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
  /** Business.interactiveListsEnabled. Ver por que es una bandera en el esquema. */
  interactiveLists?: boolean;
}

// Cuando un bloque de lista puede salir como lista TOCABLE de WhatsApp. La regla vive en el presentador
// (rowsAreListable), que es quien construye las filas y quien escribe la linea de cierre que le dice al
// cliente que gesto hacer: una sola definicion, para que el texto y la forma del mensaje no puedan
// contradecirse.
//
// El texto NUMERADO del bloque se sigue grabando en el historial aunque el cuerpo que viaja sea el corto:
// es lo que ve quien abre la conversacion en el panel, y lo que ve el modelo. La lista es la forma de
// ELEGIR, no un reemplazo del contenido.
function listableRows(block: CatalogBlock): NonNullable<CatalogBlock["rows"]> | null {
  return rowsAreListable(block.rows) ? block.rows! : null;
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
  // Dos registros, no uno, porque son dos hechos distintos (ver CatalogBlock.kind): "este cliente ya vio
  // la ficha entera de este producto con todos sus medios" y "este cliente ya vio la foto de vitrina de
  // este producto". Mezclarlos dejaria a una categoria de siete productos marcada como enteramente
  // vista despues de siete fotos sueltas.
  const sentProductIds: string[] = [];
  const vitrinaProductIds: string[] = [];

  // Manda los medios de un bloque. Devuelve si mando alguno, para saber si hace falta una pausa antes
  // del mensaje que sigue.
  async function enviarMedios(block: CatalogBlock): Promise<boolean> {
    let alguno = false;
    for (const media of block.media) {
      // Un fallo de envio de medios no puede dejar al cliente sin el resto de los bloques: el texto ya
      // salio (o esta por salir) y es lo que sostiene la conversacion. Se registra y se sigue.
      try {
        await sendMediaWithSpacing(
          businessId,
          credentials,
          to,
          conversationId,
          media.productId,
          media.productName,
          media.items,
          media.caption
        );
        alguno = true;
        if (block.kind === "lista") vitrinaProductIds.push(media.productId);
        else sentProductIds.push(media.productId);
        await recordMediaSent(conversationId, media.productName);
      } catch (error) {
        console.error(`No se pudieron enviar los medios de "${media.productName}" (no bloqueante):`, error);
      }
    }
    return alguno;
  }

  async function enviarTexto(block: CatalogBlock): Promise<void> {
    if (!block.text.trim()) return;
    await sendToCustomer({
      businessId,
      conversationId,
      credentials,
      to,
      content: { kind: "text", text: block.text },
      recordAs: { text: block.text },
    });
  }

  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) await sleep(BLOCK_GAP_MS);
    const block = blocks[i];
    const rows = args.interactiveLists ? listableRows(block) : null;

    if (!rows) {
      // Camino de siempre: el texto numerado y despues sus fotos.
      await enviarTexto(block);
      await enviarMedios(block);
      continue;
    }

    // EL BOTON VA ULTIMO (2026-09-17). Con lista tocable las fotos salen ANTES que el mensaje de la
    // lista, al reves que en el camino de texto. El motivo es lo que ve el cliente: en WhatsApp lo
    // ultimo que llega es lo que queda abajo, al alcance del pulgar. Mandando la lista primero, las
    // siete fotos de la vitrina empujan "Ver opciones" siete mensajes hacia arriba y el cliente termina
    // escribiendo un numero, que es justo el camino que la lista tocable vino a eliminar. Cada foto
    // lleva su pie con el numero y el precio, asi que no llegan sin contexto.
    const huboMedios = await enviarMedios(block);
    if (huboMedios) await sleep(BLOCK_GAP_MS);

    // El cuerpo NO repite los productos: eso ya son las filas, y ademas Meta rechaza un cuerpo de mas de
    // 1024 caracteres (ver listBodyText). El titulo de la seccion es el nombre real de la categoria
    // cuando el bloque lo trae. Si Meta rechaza la lista (formato, version del cliente), se cae al texto
    // numerado completo - el cliente nunca se queda sin la informacion por un problema de formato.
    const sent = await sendToCustomer({
      businessId,
      conversationId,
      credentials,
      to,
      content: {
        kind: "list",
        text: listBodyText(block),
        buttonText: "Ver opciones",
        sections: [{ title: block.sectionTitle ?? "Opciones", rows }],
      },
      recordAs: { text: block.text },
    });
    if (!sent.delivered) {
      console.error("La lista interactiva no salio, se manda el texto numerado:", sent.failure?.message);
      await enviarTexto(block);
    }
  }

  if (sentProductIds.length === 0 && vitrinaProductIds.length === 0) return;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { mediaSentProductIds: true, browsePhotoProductIds: true },
    });
    const fichas = new Set(conversation?.mediaSentProductIds ?? []);
    for (const id of sentProductIds) fichas.add(id);
    const vitrinas = new Set(conversation?.browsePhotoProductIds ?? []);
    for (const id of vitrinaProductIds) vitrinas.add(id);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        mediaSentProductIds: { set: [...fichas] },
        browsePhotoProductIds: { set: [...vitrinas] },
      },
    });
  } catch (error) {
    console.error("No se pudo registrar el dedup de medios enviados (no bloqueante):", error);
  }
}
