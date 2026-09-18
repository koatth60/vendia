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

  // Manda los medios de un bloque. Devuelve los productos cuyos medios SALIERON de verdad - no se
  // registra nada todavia, porque si el texto del bloque no llego, esas fotos no alcanzan para dar el
  // producto por visto (ver el registro por bloque mas abajo).
  async function enviarMedios(block: CatalogBlock): Promise<string[]> {
    const enviados: string[] = [];
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
        enviados.push(media.productId);
        // SaleState.mediaSent es otra cosa que el dedup: es "el servidor mando esta media de verdad", y
        // eso es cierto aunque el texto del bloque falle. De ahi sale la evidencia de venta en curso que
        // lee computeRequiredEffects, asi que no se toca.
        await recordMediaSent(conversationId, media.productName);
      } catch (error) {
        console.error(`No se pudieron enviar los medios de "${media.productName}" (no bloqueante):`, error);
      }
    }
    return enviados;
  }

  // Un bloque cuenta como visto solo si su TEXTO llego: es el que lleva los nombres y los precios. Las
  // fotos solas no son el catalogo.
  function registrar(block: CatalogBlock, productIds: string[], textoEntregado: boolean): void {
    if (!textoEntregado) {
      // Antes se registraba igual, y el dedup del turno siguiente suprimia esas mismas fotos: la clienta
      // se quedaba sin el bloque para siempre y un fallo se convertia en dos (E10). Sin el registro,
      // el proximo turno lo vuelve a componer entero. Puede repetir una foto que si habia salido; ver una
      // foto dos veces es mejor que no ver nunca el producto ni su precio.
      if (productIds.length > 0) {
        console.error(`El texto del bloque no llego: no se marcan como vistos ${productIds.length} producto(s), para que el turno siguiente los vuelva a mandar`);
      }
      return;
    }
    if (block.kind === "lista") vitrinaProductIds.push(...productIds);
    else sentProductIds.push(...productIds);
  }

  // Devuelve si el texto llego de verdad. Un bloque sin texto cuenta como entregado: no hay nada que
  // mandar y sus fotos no dependen de ningun mensaje que haya fallado.
  async function enviarTexto(block: CatalogBlock): Promise<boolean> {
    if (!block.text.trim()) return true;
    const enviado = await sendToCustomer({
      businessId,
      conversationId,
      credentials,
      to,
      content: { kind: "text", text: block.text },
      recordAs: { text: block.text },
    });
    if (!enviado.delivered) {
      console.error(`No salio el texto del bloque del catalogo: ${enviado.failure?.message ?? "sin detalle"}`);
    }
    return enviado.delivered;
  }

  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) await sleep(BLOCK_GAP_MS);
    const block = blocks[i];
    const rows = args.interactiveLists ? listableRows(block) : null;

    if (!rows) {
      // Camino de siempre: el texto numerado y despues sus fotos.
      const textoEntregado = await enviarTexto(block);
      registrar(block, await enviarMedios(block), textoEntregado);
      continue;
    }

    // EL BOTON VA ULTIMO (2026-09-17). Con lista tocable las fotos salen ANTES que el mensaje de la
    // lista, al reves que en el camino de texto. El motivo es lo que ve el cliente: en WhatsApp lo
    // ultimo que llega es lo que queda abajo, al alcance del pulgar. Mandando la lista primero, las
    // siete fotos de la vitrina empujan "Ver opciones" siete mensajes hacia arriba y el cliente termina
    // escribiendo un numero, que es justo el camino que la lista tocable vino a eliminar. Cada foto
    // lleva su pie con el numero y el precio, asi que no llegan sin contexto.
    const mediosEnviados = await enviarMedios(block);
    if (mediosEnviados.length > 0) await sleep(BLOCK_GAP_MS);

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
    // La lista tocable ES el texto de este bloque: si no sale, el respaldo es el texto numerado, y el
    // bloque cuenta como entregado solo si alguno de los dos llego.
    let textoEntregado = sent.delivered;
    if (!sent.delivered) {
      console.error("La lista interactiva no salio, se manda el texto numerado:", sent.failure?.message);
      textoEntregado = await enviarTexto(block);
    }
    registrar(block, mediosEnviados, textoEntregado);
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
