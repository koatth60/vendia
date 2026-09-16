import { prisma } from "../db/client";
import { getSaleState, type SaleStateSnapshot } from "../orders/saleState";
import { runCatalogTool, type ToolContext } from "./tools";
import { formatPrice } from "../config/money";

// EFECTOS REQUERIDOS (2026-09-15).
//
// El problema que resuelve, en una frase: hasta ahora nadie verificaba que el turno hubiera hecho lo que
// su propio texto decia que hizo. Caso real, conversacion cmu3htnp0009y4k2kzxhy9dlz (2026-09-16 UTC): la
// clienta manda la foto del comprobante ($154.000 por Nequi), el turno registra UNA sola fila AiUsageLog
// (o sea, cero llamadas a herramientas), y el bot escribe "estoy validando tu comprobante... confirmando
// con el equipo" tres veces. En la base: PendingOwnerQuestion = 0, OwnerMessageLog = 0, Order = []. La
// clienta pago y la duena nunca se entero.
//
// El camino correcto existe y funciona (close_conversation -> requestSaleConfirmation -> el aviso
// "¿Te llego el pago?" que la duena contesta). Lo que no es confiable es que el modelo lo dispare.
//
// Por que no alcanza con forzar tool_choice: medido el 2026-09-15 en cmu0ehwqx00076k2k64mjaats (21:56:45
// y 22:35:11), con tool_choice forzado a list_all_products DeepSeek devolvio texto sin tool_calls, una
// sola llamada, e invento productos que no existen. Mismo modelo que en los turnos vecinos donde si
// honro la herramienta. El reintento es necesario, pero no puede ser la unica defensa: de ahi la
// escalera reintento -> fallback por codigo -> escalacion.
//
// REGLA DE ESTE MODULO: todo lo que se decide aca sale de estado de la base. Nunca de la prosa del
// modelo ni de la del cliente. No hay ni una expresion regular en este archivo, y no se agrega ninguna.

export type RequiredEffectKind = "SALE_REGISTERED_AND_OWNER_NOTIFIED";

export interface RequiredEffect {
  kind: RequiredEffectKind;
  /** Herramienta que produce este efecto - la que se fuerza con tool_choice en el reintento. */
  tool: string;
  /** Por que se exigio. Va al log del turno y al mensaje de sistema del reintento. */
  reason: string;
}

/** Lo unico que se mira del mensaje entrante: su tipo de medio. Nunca su texto. */
export interface IncomingMessageFacts {
  mediaType: string | null;
}

interface ConversationFacts {
  humanControl: boolean;
  pendingOrderSummary: string | null;
  pendingOrderItems: unknown;
  pendingConfirmationMessageId: string | null;
  hasOrder: boolean;
}

async function readConversationFacts(conversationId: string): Promise<ConversationFacts | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      humanControl: true,
      pendingOrderSummary: true,
      pendingOrderItems: true,
      pendingConfirmationMessageId: true,
      order: { select: { id: true } },
    },
  });
  if (!row) return null;
  return {
    humanControl: row.humanControl,
    pendingOrderSummary: row.pendingOrderSummary,
    pendingOrderItems: row.pendingOrderItems,
    pendingConfirmationMessageId: row.pendingConfirmationMessageId,
    hasOrder: Boolean(row.order),
  };
}

// "Venta en curso" = el pedido ya esta resuelto contra el catalogo, no que el cliente haya mostrado
// interes. Funcion pura sobre datos ya leidos para poder probarla sin base, misma razon que
// findHealthIssues en jobs/conversationHealth.ts.
export function hasSaleInProgress(
  conversation: Pick<ConversationFacts, "pendingOrderSummary" | "pendingOrderItems">,
  saleState: SaleStateSnapshot | null
): boolean {
  // `pendingOrderItems` es una columna Json anulable: cuando se limpia queda como null JSON, que puede
  // volver del cliente como null o como el literal null. Solo cuenta un objeto de verdad.
  const hasDraft = typeof conversation.pendingOrderItems === "object" && conversation.pendingOrderItems !== null;
  if (conversation.pendingOrderSummary || hasDraft) return true;
  if (!saleState) return false;
  // Producto, precio y forma de pago resueltos. El precio sale del catalogo (set_order_item lo valida
  // linea por linea), asi que un total > 0 ya significa "hay precio real", no "el modelo dijo un numero".
  return saleState.items.length > 0 && saleState.total > 0 && Boolean(saleState.paymentMethodLabel);
}

/**
 * Los efectos que ESTE turno esta obligado a producir, calculados solo desde estado de la base.
 *
 * Arranca con una sola fila a proposito: declarar un efecto como obligatorio cuando no lo era rompe
 * conversaciones que hoy funcionan bien. La estructura queda lista para mas filas (la de "se envio la
 * foto del producto en alcance" entra despues de la Fase B del plan de catalogo, cuando exista
 * resolveProductScope), pero no se agrega ninguna otra en esta fase.
 */
export async function computeRequiredEffects(
  conversationId: string,
  incomingMessage: IncomingMessageFacts
): Promise<RequiredEffect[]> {
  // (a) el mensaje entrante trae mediaType IMAGE
  if (incomingMessage.mediaType !== "IMAGE") return [];

  const conversation = await readConversationFacts(conversationId);
  if (!conversation) return [];

  // (c) la conversacion no esta en manos de una persona
  if (conversation.humanControl) return [];

  // (d) no existe ya un Order para esta conversacion. Este es el candado de idempotencia: dos fotos
  // seguidas no pueden crear dos pedidos. La segunda condicion es el mismo candado un paso antes -
  // requestSaleConfirmation deja pendingConfirmationMessageId puesto y el Order recien se crea cuando la
  // duena contesta "si llego", asi que entre esos dos momentos el efecto YA ocurrio aunque no haya Order.
  if (conversation.hasOrder || conversation.pendingConfirmationMessageId) return [];

  // (b) hay una venta en curso
  const saleState = await getSaleState(conversationId);
  if (!hasSaleInProgress(conversation, saleState)) return [];

  return [
    {
      kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED",
      tool: "close_conversation",
      reason:
        "el cliente mando una imagen con una venta ya armada en curso, asi que el pedido tiene que quedar registrado y el dueno avisado antes de responderle",
    },
  ];
}

/**
 * Comprueba contra la base cuales de los efectos exigidos NO ocurrieron. Se llama ANTES de mandar la
 * respuesta: si el efecto falta, el texto del modelo tambien esta mal ("estoy confirmando con el equipo"
 * cuando no se consulto a nadie no debe salir nunca).
 *
 * Devuelve los efectos que faltan (lista vacia = el turno hizo lo que dice que hizo).
 */
export async function verifyRequiredEffects(
  conversationId: string,
  effects: RequiredEffect[]
): Promise<RequiredEffect[]> {
  if (effects.length === 0) return [];
  const conversation = await readConversationFacts(conversationId);
  if (!conversation) return [];

  const missing: RequiredEffect[] = [];
  for (const effect of effects) {
    if (effect.kind === "SALE_REGISTERED_AND_OWNER_NOTIFIED") {
      // Dos formas validas de que el efecto haya ocurrido, y las dos salen de la base:
      //  - hay Order (negocio sin contactPhone: close_conversation autocierra y crea el pedido), o
      //  - hay pendingConfirmationMessageId (close_conversation le mando "¿Te llego el pago?" al dueno y
      //    quedo esperando su respuesta; ese campo solo se escribe cuando el envio devolvio wamid, o sea
      //    cuando el dueno REALMENTE recibio el aviso - ver requestSaleConfirmation en tools.ts).
      if (conversation.hasOrder || conversation.pendingConfirmationMessageId) continue;
      missing.push(effect);
    }
  }
  return missing;
}

// Resumen del pedido para el fallback, armado desde la base. Nunca desde la prosa del modelo: eso es
// justamente lo que este mecanismo existe para dejar de hacer.
function buildSaleSummaryFromDb(saleState: SaleStateSnapshot | null, locale: string, fallbackSummary: string | null): string {
  if (!saleState || saleState.items.length === 0) return fallbackSummary ?? "";
  const currency = saleState.items[0].currency;
  const lineas = saleState.items.map((item) => {
    const nombre = item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName;
    return `${item.quantity}x ${nombre} - ${formatPrice(item.unitPrice * item.quantity, currency, locale)}`;
  });
  if (saleState.shippingCost) lineas.push(`Envio: ${formatPrice(saleState.shippingCost, currency, locale)}`);
  lineas.push(`TOTAL: ${formatPrice(saleState.total, currency, locale)}`);
  if (saleState.paymentMethodLabel) lineas.push(`Pago: ${saleState.paymentMethodLabel}`);
  if (saleState.address) lineas.push(`Envio a: ${saleState.address}`);
  return lineas.join("\n");
}

/** Texto FIJO, escrito por nosotros, para cuando el pedido lo cerro el fallback y no el modelo. */
export const FALLBACK_SALE_REGISTERED_TEXT =
  "Listo, ya registré tu pedido y le pasé tu comprobante al equipo para que confirme el pago. Apenas lo confirmen te aviso por acá.";

/** Texto FIJO para cuando no se pudo producir el efecto: no afirma que haya pasado nada. */
export const ESCALATION_TEXT =
  "Recibí tu mensaje. Un asesor del equipo va a continuar por acá contigo en un momento.";

export interface FallbackResult {
  ok: boolean;
  /** Que se hizo, para el incidente y el log del turno. */
  detail: string;
}

/**
 * FALLBACK POR CODIGO: ejecuta la herramienta que falta desde el servidor, con argumentos derivados de la
 * base. Reusa el MISMO camino que usa close_conversation hoy (runCatalogTool -> requestSaleConfirmation ->
 * createOrder); no existe una segunda forma de crear pedidos.
 */
export async function runRequiredEffectFallback(context: ToolContext, effect: RequiredEffect): Promise<FallbackResult> {
  if (effect.kind !== "SALE_REGISTERED_AND_OWNER_NOTIFIED") {
    return { ok: false, detail: `No hay fallback por codigo para el efecto ${effect.kind}.` };
  }

  const conversation = await readConversationFacts(context.conversationId);
  if (!conversation) return { ok: false, detail: "La conversacion ya no existe." };

  const saleState = await getSaleState(context.conversationId);
  const locale = context.locale ?? "es-CO";
  const summary = buildSaleSummaryFromDb(saleState, locale, conversation.pendingOrderSummary);

  // Negocio sin SaleState: los items salen del borrador ya persistido (pendingOrderItems), que tambien es
  // estado de la base. Con SaleState activo close_conversation ignora `items` y lee el motor, asi que
  // mandarlos igual no cambia nada.
  const draft = conversation.pendingOrderItems as { items?: { productName?: unknown; quantity?: unknown; variantLabel?: unknown }[] } | null;
  const items = Array.isArray(draft?.items)
    ? draft.items
        .filter((i) => typeof i?.productName === "string" && typeof i?.quantity === "number")
        .map((i) => ({
          productName: String(i.productName),
          quantity: Number(i.quantity),
          ...(typeof i.variantLabel === "string" ? { variantLabel: i.variantLabel } : {}),
        }))
    : [];

  try {
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary,
      ...(items.length > 0 ? { items } : {}),
    })) as { closed?: boolean; pending?: boolean; note?: string; error?: string };

    // No alcanza con que la herramienta no haya tirado: se vuelve a comprobar contra la base, que es lo
    // unico que prueba que el efecto ocurrio.
    const stillMissing = await verifyRequiredEffects(context.conversationId, [effect]);
    if (stillMissing.length === 0) {
      return { ok: true, detail: result?.pending ? "pedido registrado, esperando la confirmacion del dueno" : "pedido cerrado y registrado" };
    }
    return { ok: false, detail: result?.note ?? result?.error ?? "close_conversation corrio pero el efecto sigue sin verse en la base" };
  } catch (error) {
    console.error("Fallo el fallback por codigo de un efecto requerido:", error);
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// OBSERVABILIDAD. Sin esto no hay forma de saber si el mecanismo sirve, y sobre todo: el contador
// `retryResolved` contra `fallbackUsed` es el numero que decide si en el futuro se puede confiar en el
// reintento (ver la medicion de tool_choice del 2026-09-15 que motivo todo esto).
// El caller real (routes/whatsapp.ts) descarta la respuesta si la conversacion quedo en control humano
// mientras se generaba - esa comprobacion existe para no pisar a una persona que tomo el chat a mano. La
// escalacion de abajo pone humanControl ella misma, asi que sin esta marca su texto neutro se descartaria
// y el cliente que acaba de pagar se quedaria sin ninguna respuesta: exactamente el silencio que este
// mecanismo existe para eliminar. La marca se consume una sola vez, en el mismo proceso y turno.
const escalatedTurns = new Set<string>();

export function markEscalatedTurn(conversationId: string): void {
  escalatedTurns.add(conversationId);
}

/** true si el turno que acaba de generarse escalo por su cuenta (y limpia la marca). */
export function consumeEscalatedTurn(conversationId: string): boolean {
  return escalatedTurns.delete(conversationId);
}

export interface RequiredEffectsTurnLog {
  conversationId: string;
  required: RequiredEffectKind[];
  missingAfterFirstAttempt: RequiredEffectKind[];
  retries: number;
  retryResolved: boolean;
  fallbackUsed: boolean;
  fallbackResolved: boolean;
  escalated: boolean;
}

export const requiredEffectStats = {
  turnsWithRequiredEffects: 0,
  missingAfterFirstAttempt: 0,
  retries: 0,
  retryResolved: 0,
  fallbackUsed: 0,
  fallbackResolved: 0,
  escalated: 0,
};

export function resetRequiredEffectStats(): void {
  requiredEffectStats.turnsWithRequiredEffects = 0;
  requiredEffectStats.missingAfterFirstAttempt = 0;
  requiredEffectStats.retries = 0;
  requiredEffectStats.retryResolved = 0;
  requiredEffectStats.fallbackUsed = 0;
  requiredEffectStats.fallbackResolved = 0;
  requiredEffectStats.escalated = 0;
}

export function recordRequiredEffectsTurn(log: RequiredEffectsTurnLog): void {
  requiredEffectStats.turnsWithRequiredEffects++;
  if (log.missingAfterFirstAttempt.length > 0) requiredEffectStats.missingAfterFirstAttempt++;
  requiredEffectStats.retries += log.retries;
  if (log.retryResolved) requiredEffectStats.retryResolved++;
  if (log.fallbackUsed) requiredEffectStats.fallbackUsed++;
  if (log.fallbackResolved) requiredEffectStats.fallbackResolved++;
  if (log.escalated) requiredEffectStats.escalated++;
  console.log(
    `[efectos-requeridos] conv=${log.conversationId} exigidos=${log.required.join(",") || "-"} ` +
      `faltaban=${log.missingAfterFirstAttempt.join(",") || "-"} reintentos=${log.retries} ` +
      `reintento_alcanzo=${log.retryResolved} fallback=${log.fallbackUsed} fallback_alcanzo=${log.fallbackResolved} escalado=${log.escalated}`
  );
}
