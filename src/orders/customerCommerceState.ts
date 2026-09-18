import { prisma } from "../db/client";
import { formatPrice } from "../config/money";

// Pieza 6 del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 3).
//
// EL DEFECTO QUE CIERRA. Un pedido es del CLIENTE, no de la conversacion. `Order.conversationId` es 1:1
// con la conversacion en la que se cerro, asi que todo lo que el turno miraba por conversacion
// (getOrderByConversationId) era ciego al pedido que ese mismo cliente abrio en otra. Caso real del
// 2026-09-15: el pedido cmu3hv4y600ag4k2kanuuooyr (PARLANTE TIPO ALEXA, $80.000, PENDING) se creo en la
// conversacion cmu3hp5ve008f4k2ko22vdf2f y la clienta pidio cancelarlo desde la cmu3hw2qp00ar4k2ku58i0b5f:
// para el modelo ese pedido no existia. Volvio a pasar el 2026-09-16 con Laura Manjarrez.
//
// getLatestOrderForCustomer (orders/service.ts) ya buscaba por cliente y ya estaba bien, pero se usaba
// solo DENTRO de cancel_order y de get_order_status: el modelo se enteraba de que habia un pedido abierto
// despues de haber decidido cancelarlo. Esto lo saca de las herramientas y lo pone en el contexto del
// turno, como dato, antes de la primera llamada al modelo.
//
// LA DECISION QUE LE QUITA AL MODELO: si un pedido abierto existe o no para este turno. Hasta hoy eso
// dependia de en que conversacion estuviera el cliente y de si el modelo llamaba una herramienta. Desde
// aca lo decide el servidor leyendo la base, y el modelo no puede ignorar un dato que tiene delante.
//
// Toda la decision de que entra y que no vive en buildCustomerCommerceState, que es pura: se prueba sin
// base de datos. La lectura es una sola llamada a Prisma y no hace nada mas que traer filas.

/** Cuantos pedidos se traen de la base. El recorte para el modelo lo hace el builder puro. */
const ORDER_READ_LIMIT = 10;
/** Cuantas conversaciones del cliente se miran para la venta en curso y la ultima lista presentada. */
const CONVERSATION_READ_LIMIT = 5;
/** Cuantos pedidos ve el modelo. Los abiertos van todos primero; el resto es historia reciente. */
const MAX_ORDERS_SHOWN = 5;
/** Cuantos pedidos ya cerrados (enviados o cancelados) acompanan a los abiertos. */
const MAX_CLOSED_ORDERS_SHOWN = 2;

export type OrderStateLabel = "pendiente" | "enviado" | "cancelado";

export interface OrderFact {
  resumen: string;
  total: string;
  estado: OrderStateLabel;
  /** YYYY-MM-DD. La fecha alcanza: el modelo no necesita la hora para hablar de un pedido. */
  creado: string;
  /** El punto de toda la pieza: false = el pedido se abrio en OTRA conversacion de este mismo cliente. */
  enEstaConversacion: boolean;
  // E35 (2026-09-18). DONDE ESTA EL PEDIDO.
  //
  // Las claves solo aparecen cuando el dato existe: un pedido sin guia no manda `guia: null`, no manda
  // nada. Es la misma regla que el resto de las piezas -- lo que no se sabe no ocupa tokens y, sobre
  // todo, no le da al modelo un hueco que rellenar.
  transportadora?: string;
  guia?: string;
  /** YYYY-MM-DD. Solo fecha: la hora no se sabe y prometerla seria inventar. */
  entregaEstimada?: string;
  /** "pagado", "parcial" o "devuelto". Sin pagar no se anota: es lo que se asume de un pedido abierto. */
  pago?: "pagado" | "parcial" | "devuelto";
}

export interface SaleInProgressFact {
  conversationId: string;
  enEstaConversacion: boolean;
  items: { producto: string; variante: string | null; cantidad: number }[];
  /** Hay una venta esperando que el dueno confirme el pago (Conversation.pendingConfirmationAskedAt). */
  esperandoConfirmacionDePago: boolean;
}

export interface PresentedListFact {
  conversationId: string;
  enEstaConversacion: boolean;
  productIds: string[];
}

export interface CustomerCommerceState {
  pedidos: OrderFact[];
  ventaEnCurso: SaleInProgressFact | null;
  ultimaListaPresentada: PresentedListFact | null;
}

/** Las filas tal como salen de la base. El builder no sabe de Prisma, solo de esta forma. */
export interface CommerceOrderRow {
  conversationId: string;
  summary: string;
  totalAmount: number | { toString(): string };
  currency: string;
  fulfillmentStatus: string;
  createdAt: Date;
  // E35. Opcionales para que las pruebas viejas y cualquier otro llamador sigan armando filas sin esto.
  carrier?: string | null;
  trackingNumber?: string | null;
  estimatedDelivery?: Date | null;
  paymentStatus?: string | null;
}

export interface CommerceConversationRow {
  id: string;
  lastPresentedProductIds: string[];
  pendingConfirmationAskedAt: Date | null;
  saleState: { items: unknown } | null;
}

export interface CommerceRows {
  /** Mas nuevo primero. */
  orders: CommerceOrderRow[];
  /** Mas recientemente actualizada primero. */
  conversations: CommerceConversationRow[];
}

export const EMPTY_COMMERCE_STATE: CustomerCommerceState = {
  pedidos: [],
  ventaEnCurso: null,
  ultimaListaPresentada: null,
};

function orderStateLabel(fulfillmentStatus: string): OrderStateLabel {
  if (fulfillmentStatus === "SHIPPED") return "enviado";
  if (fulfillmentStatus === "CANCELED") return "cancelado";
  return "pendiente";
}

/** Abierto = PENDING. Un pedido enviado ya no se puede cancelar y uno cancelado ya no existe. */
export function isOpenOrder(row: { fulfillmentStatus: string }): boolean {
  return row.fulfillmentStatus === "PENDING";
}

function saleItems(raw: unknown): { producto: string; variante: string | null; cantidad: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is { productName: string; variantLabel?: string | null; quantity: number } =>
      Boolean(i) && typeof i === "object" && typeof (i as { productName?: unknown }).productName === "string"
    )
    .map((i) => ({
      producto: i.productName,
      variante: i.variantLabel ?? null,
      cantidad: typeof i.quantity === "number" ? i.quantity : 1,
    }));
}

/**
 * Funcion pura: mismas filas, mismo estado, sin base de datos ni reloj.
 *
 * Que pedidos ve el modelo: TODOS los abiertos, tengan la edad que tengan, mas los dos mas recientes ya
 * cerrados. Un pedido abierto viejo es exactamente el caso que rompia (el de la clienta tenia dias), asi
 * que recortar por recencia a secas volveria a esconderlo.
 */
export function buildCustomerCommerceState(
  rows: CommerceRows,
  currentConversationId: string,
  opts: { currency: string; locale: string }
): CustomerCommerceState {
  const abiertos = rows.orders.filter(isOpenOrder);
  const cerrados = rows.orders.filter((o) => !isOpenOrder(o)).slice(0, MAX_CLOSED_ORDERS_SHOWN);
  const pedidos = [...abiertos, ...cerrados].slice(0, MAX_ORDERS_SHOWN).map((o) => ({
    resumen: o.summary,
    total: `$${formatPrice(o.totalAmount, o.currency || opts.currency, opts.locale)}`,
    estado: orderStateLabel(o.fulfillmentStatus),
    creado: o.createdAt.toISOString().slice(0, 10),
    enEstaConversacion: o.conversationId === currentConversationId,
    // E35: donde esta y si esta pagado. Solo lo que existe (ver OrderFact).
    ...(o.carrier ? { transportadora: o.carrier } : {}),
    ...(o.trackingNumber ? { guia: o.trackingNumber } : {}),
    ...(o.estimatedDelivery ? { entregaEstimada: o.estimatedDelivery.toISOString().slice(0, 10) } : {}),
    ...(o.paymentStatus === "PAID"
      ? { pago: "pagado" as const }
      : o.paymentStatus === "PARTIAL"
        ? { pago: "parcial" as const }
        : o.paymentStatus === "REFUNDED"
          ? { pago: "devuelto" as const }
          : {}),
  }));

  // La conversacion actual gana sobre cualquier otra: lo que el cliente esta haciendo ahora es mas verdad
  // que lo que dejo abierto hace tres dias. Recien si esta no tiene nada se mira el resto, que ya viene
  // ordenado por recencia.
  const prefiereActual = <T extends { id: string }>(candidatos: T[]): T | null => {
    const actual = candidatos.find((c) => c.id === currentConversationId);
    return actual ?? candidatos[0] ?? null;
  };

  const conVenta = rows.conversations.filter(
    (c) => saleItems(c.saleState?.items).length > 0 || c.pendingConfirmationAskedAt !== null
  );
  const venta = prefiereActual(conVenta);
  const ventaEnCurso: SaleInProgressFact | null = venta
    ? {
        conversationId: venta.id,
        enEstaConversacion: venta.id === currentConversationId,
        items: saleItems(venta.saleState?.items),
        esperandoConfirmacionDePago: venta.pendingConfirmationAskedAt !== null,
      }
    : null;

  const conLista = rows.conversations.filter((c) => c.lastPresentedProductIds.length > 0);
  const lista = prefiereActual(conLista);
  const ultimaListaPresentada: PresentedListFact | null = lista
    ? {
        conversationId: lista.id,
        enEstaConversacion: lista.id === currentConversationId,
        productIds: lista.lastPresentedProductIds,
      }
    : null;

  return { pedidos, ventaEnCurso, ultimaListaPresentada };
}

/**
 * Una sola lectura: los pedidos del cliente y sus conversaciones recientes salen de la misma llamada a
 * Prisma, por customerId. Nada de esto se filtra por conversationId - esa es justamente la ceguera que
 * esta pieza corrige.
 *
 * Nunca puede romper el turno: si la lectura falla se devuelve el estado vacio y el turno sigue
 * exactamente como antes de esta fase, igual que getLastPresentedProductIds.
 */
export async function getCustomerCommerceState(
  businessId: string,
  customerId: string,
  currentConversationId: string,
  opts: { currency: string; locale: string }
): Promise<CustomerCommerceState> {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: {
        orders: {
          where: { businessId },
          orderBy: { createdAt: "desc" },
          take: ORDER_READ_LIMIT,
          select: {
            conversationId: true,
            summary: true,
            totalAmount: true,
            currency: true,
            fulfillmentStatus: true,
            createdAt: true,
            // E35: donde esta el pedido. Es la pregunta mas comun despues de la venta y hasta hoy no
            // habia de donde leerla.
            carrier: true,
            trackingNumber: true,
            estimatedDelivery: true,
            paymentStatus: true,
          },
        },
        conversations: {
          orderBy: { updatedAt: "desc" },
          take: CONVERSATION_READ_LIMIT,
          select: {
            id: true,
            lastPresentedProductIds: true,
            pendingConfirmationAskedAt: true,
            saleState: { select: { items: true } },
          },
        },
      },
    });
    if (!customer) return EMPTY_COMMERCE_STATE;
    return buildCustomerCommerceState(
      { orders: customer.orders, conversations: customer.conversations },
      currentConversationId,
      opts
    );
  } catch (error) {
    console.error("No se pudo leer el estado comercial del cliente (no bloqueante):", error);
    return EMPTY_COMMERCE_STATE;
  }
}
