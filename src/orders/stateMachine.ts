import type { OrderEventActor, OrderFulfillmentStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/client";

// E31 (2026-09-18). El estado del pedido deja de poder sobrescribirse desde cualquier lado.
//
// Hasta hoy markOrderShipped y markOrderCanceled eran dos `update` sueltos que ni miraban el estado
// actual. O sea que el panel podia cancelar un pedido YA ENVIADO (el mensajero ya salio) y volver a
// enviar uno cancelado, y ninguna de las dos cosas dejaba rastro: no existia un solo campo que dijera
// quien envio o quien cancelo.
//
// Acá esta la unica tabla de transiciones permitidas del sistema. Si un camino no esta en esta tabla,
// no existe: no hay una segunda lista en las rutas ni un `if` suelto en el panel que pueda contradecirla.

/**
 * PENDING es el valor historico de la columna; PENDING_PAYMENT es como se llama ese mismo estado de
 * ahora en adelante. Se normaliza en un solo lugar para que la tabla de abajo no tenga que declarar
 * las dos veces cada camino, que es justo la clase de duplicado que se desincroniza.
 */
export function normalizarEstado(estado: OrderFulfillmentStatus): OrderFulfillmentStatus {
  return estado === "PENDING" ? "PENDING_PAYMENT" : estado;
}

/**
 * De cada estado, a cuales se puede ir. Lo que no esta, no se puede.
 *
 * Las decisiones que no son obvias, dichas:
 * - De SHIPPED NO se puede cancelar. El pedido ya salio; lo que ocurre despues es una DEVOLUCION, que
 *   es otro hecho con otro nombre (y ConversationIntent ya tenia DEVOLUCION y NO_RECIBIDO sin nada del
 *   lado del pedido que los representara).
 * - CANCELED, RETURNED y REFUNDED son finales. Un pedido cancelado no se "descancela": si el cliente
 *   vuelve, es un pedido nuevo. Permitir volver atras es lo que hace que el historial mienta.
 * - DELIVERED puede ir a RETURNED: el cliente lo recibio y lo devolvio. Es el caso real, no una rareza.
 */
const TRANSICIONES: Record<OrderFulfillmentStatus, OrderFulfillmentStatus[]> = {
  PENDING: [], // nunca se usa: todo pasa por normalizarEstado antes de mirar esta tabla
  PENDING_PAYMENT: ["PAID", "PREPARING", "SHIPPED", "CANCELED"],
  PAID: ["PREPARING", "SHIPPED", "CANCELED", "REFUNDED"],
  PREPARING: ["SHIPPED", "CANCELED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  CANCELED: [],
  RETURNED: ["REFUNDED"],
  REFUNDED: [],
};

/** Por que no se pudo, en palabras que sirvan para mostrarle al dueno. */
export class TransicionNoPermitida extends Error {
  constructor(
    readonly desde: OrderFulfillmentStatus,
    readonly hacia: OrderFulfillmentStatus,
  ) {
    super(explicar(desde, hacia));
    this.name = "TransicionNoPermitida";
  }
}

const NOMBRES: Record<OrderFulfillmentStatus, string> = {
  PENDING: "pendiente",
  PENDING_PAYMENT: "pendiente de pago",
  PAID: "pagado",
  PREPARING: "en preparación",
  SHIPPED: "enviado",
  DELIVERED: "entregado",
  CANCELED: "cancelado",
  RETURNED: "devuelto",
  REFUNDED: "reembolsado",
};

function explicar(desde: OrderFulfillmentStatus, hacia: OrderFulfillmentStatus): string {
  const d = NOMBRES[normalizarEstado(desde)];
  const h = NOMBRES[hacia];
  if (normalizarEstado(desde) === "SHIPPED" && hacia === "CANCELED") {
    return "Este pedido ya fue enviado, así que no se puede cancelar. Si el cliente lo rechaza o lo devuelve, marcalo como devuelto.";
  }
  if (["CANCELED", "REFUNDED"].includes(normalizarEstado(desde))) {
    return `Este pedido está ${d} y eso es definitivo. Si el cliente vuelve a comprar, es un pedido nuevo.`;
  }
  return `Un pedido ${d} no puede pasar a ${h}.`;
}

export function sePuede(desde: OrderFulfillmentStatus, hacia: OrderFulfillmentStatus): boolean {
  return TRANSICIONES[normalizarEstado(desde)].includes(hacia);
}

export interface Actor {
  tipo: OrderEventActor;
  /** Email de la sesion del panel, o el nombre del job. Null para el agente y el sistema. */
  etiqueta?: string | null;
}

/**
 * Mueve el pedido, o tira. Nunca escribe a medias: la validacion, el update y el evento van en una
 * transaccion, y la condicion del estado anterior viaja DENTRO del WHERE del update. Eso ultimo es lo
 * que hace que dos pedidos simultaneos de cancelar y enviar no puedan pisarse: el segundo no encuentra
 * fila que actualizar y se rechaza, en vez de ganar por llegar despues.
 */
export async function transicionarPedido(params: {
  businessId: string;
  orderId: string;
  hacia: OrderFulfillmentStatus;
  actor: Actor;
  motivo?: string | null;
  /** Campos extra que esta transicion escribe en el pedido (shippedAt, canceledAt, la nota de envio). */
  datos?: Prisma.OrderUpdateInput;
}): Promise<{ estadoAnterior: OrderFulfillmentStatus } | null> {
  const { businessId, orderId, hacia, actor, motivo, datos } = params;

  const actual = await prisma.order.findFirst({
    where: { id: orderId, businessId },
    select: { fulfillmentStatus: true },
  });
  if (!actual) return null;

  const desde = actual.fulfillmentStatus;
  if (!sePuede(desde, hacia)) throw new TransicionNoPermitida(desde, hacia);

  await prisma.$transaction(async (tx) => {
    const movidos = await tx.order.updateMany({
      // El estado anterior va en el WHERE: si otro cambio lo movio entre el SELECT y esto, no hay fila
      // que actualizar y la transaccion se cae sola en vez de sobrescribirlo.
      where: { id: orderId, businessId, fulfillmentStatus: desde },
      data: { fulfillmentStatus: hacia, ...(datos as Prisma.OrderUpdateManyMutationInput) },
    });
    if (movidos.count === 0) throw new TransicionNoPermitida(desde, hacia);
    await tx.orderEvent.create({
      data: {
        orderId,
        businessId,
        from: desde,
        to: hacia,
        actor: actor.tipo,
        actorLabel: actor.etiqueta ?? null,
        reason: motivo ?? null,
      },
    });
  });

  return { estadoAnterior: desde };
}
