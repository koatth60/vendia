import type { CancelacionPorElBot, OrderEventActor, OrderFulfillmentStatus, Prisma } from "@prisma/client";
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
 * - De SHIPPED SI se puede cancelar, pero eso no quiere decir que el bot pueda: la tabla dice lo que es
 *   POSIBLE, y `estadosQueElBotPuedeCancelar` dice hasta donde llega el bot en ESTE negocio. Un pedido
 *   despachado que el cliente rechaza puede terminar en RETURNED, que sigue siendo otro hecho con otro
 *   nombre; lo que se agrego es que un negocio pueda dejar que se cancele antes de que llegue.
 * - CANCELED, RETURNED y REFUNDED son finales. Un pedido cancelado no se "descancela": si el cliente
 *   vuelve, es un pedido nuevo. Permitir volver atras es lo que hace que el historial mienta.
 * - DELIVERED puede ir a RETURNED: el cliente lo recibio y lo devolvio. Es el caso real, no una rareza.
 */
const TRANSICIONES: Record<OrderFulfillmentStatus, OrderFulfillmentStatus[]> = {
  PENDING: [], // nunca se usa: todo pasa por normalizarEstado antes de mirar esta tabla
  PENDING_PAYMENT: ["PAID", "PREPARING", "SHIPPED", "CANCELED"],
  PAID: ["PREPARING", "SHIPPED", "CANCELED", "REFUNDED"],
  PREPARING: ["SHIPPED", "CANCELED"],
  SHIPPED: ["DELIVERED", "RETURNED", "CANCELED"],
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

/**
 * E34: los estados desde los que un pedido todavia se puede cancelar. Sale de la MISMA tabla de
 * transiciones, no de una lista escrita a mano: el dia que un estado nuevo admita cancelacion, esto lo
 * sabe solo. Una lista aparte es exactamente la que se olvida de actualizar.
 */
export const ESTADOS_CANCELABLES = (Object.keys(TRANSICIONES) as OrderFulfillmentStatus[]).filter((estado) =>
  sePuede(estado, "CANCELED"),
);

/**
 * Hasta donde puede cancelar EL BOT en este negocio, que no es lo mismo que lo que es posible.
 *
 * Pedido del dueño (2026-09-18): "un toggle donde el cliente decida hasta qué punto se puede cancelar el
 * pedido... para que el bot pueda cancelar sin tener que hacer nada el dueño de la empresa, pero bajo
 * ciertas condiciones". El corte se fija una vez por negocio y dentro de ese límite el bot cancela solo.
 *
 * Sale de la MISMA tabla que `ESTADOS_CANCELABLES`, filtrada por el ajuste: así el día que la tabla
 * cambie, esto lo sabe solo. Una segunda lista escrita a mano es la que se olvida de actualizar.
 */
export function estadosQueElBotPuedeCancelar(ajuste: CancelacionPorElBot): OrderFulfillmentStatus[] {
  if (ajuste === "NUNCA") return [];
  if (ajuste === "ANTES_DE_ENTREGAR") return ESTADOS_CANCELABLES;
  // ANTES_DE_DESPACHAR: todo lo cancelable menos el pedido que ya salio.
  return ESTADOS_CANCELABLES.filter((estado) => estado !== "SHIPPED");
}

/**
 * El cliente de transaccion tal como lo entrega ESTE prisma, que esta extendido (ver src/db/client.ts:
 * la extension que cifra y descifra el token de WhatsApp). Prisma.TransactionClient describe el cliente
 * sin extender y no encaja; derivarlo del propio `prisma` lo mantiene correcto si la extension cambia.
 */
export type TxCliente = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

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
  /**
   * Trabajo extra que tiene que ocurrir en LA MISMA transaccion que el cambio de estado. Lo usa la
   * cancelacion para devolver el stock: si la devolucion fuera un paso aparte y fallara, el pedido
   * quedaria cancelado con las unidades perdidas, que es el defecto que E32 vino a cerrar.
   */
  enLaMismaTransaccion?: (tx: TxCliente) => Promise<void>;
}): Promise<{ estadoAnterior: OrderFulfillmentStatus } | null> {
  const { businessId, orderId, hacia, actor, motivo, datos, enLaMismaTransaccion } = params;

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
    if (enLaMismaTransaccion) await enLaMismaTransaccion(tx);
  });

  return { estadoAnterior: desde };
}
