import { prisma } from "../db/client";
import { localDaysBetween } from "../ai/clock";

// EL PEDIDO QUE EL CLIENTE YA TIENE, leido de la base (2026-09-17).
//
// El agujero que cierra, medido en produccion. Andres compro un reloj; close_conversation dejo esa
// conversacion en SOLD. Veintitres minutos despues escribio "Oye confirmado lo del reloj, mañana a que
// horas mas o menos llegaria" y eso abrio una conversacion NUEVA, con historial vacio. El modelo no
// llamo ninguna herramienta, asi que no supo que existia un pedido, y le volvio a pedir ciudad, barrio,
// nombre, celular y direccion de una compra que ya estaba cerrada.
//
// Recuperar ese contexto dependia de que el modelo se acordara de llamar get_previous_conversation.
// Confiar en que el modelo llame una herramienta, sin verificar que la haya llamado, es exactamente lo
// que la regla del repositorio prohibe. Se invierte: el SERVIDOR lee el pedido y lo pone en el turno.
// El modelo deja de tener la decision.
//
// El mismo dato sirve para dos cosas distintas, y por eso vive en un solo lugar: le dice al agente que
// el cliente ya compro (lo de abajo), y le dice al resolvedor de alcance que este no es un turno de
// navegar el catalogo (ver suppressBrowsingScope en src/ai/agent.ts).

/** Cuantos dias despues de la compra un cliente sigue siendo "post-venta" para este mecanismo. */
export const POST_SALE_WINDOW_DAYS = 30;

export interface PostSaleOrder {
  id: string;
  createdAt: Date;
  ageDays: number;
  fulfillmentStatus: string;
  canceledAt: Date | null;
  summary: string;
  totalAmount: string;
  currency: string;
  shippingCost: string | null;
  shippingAddress: string | null;
  paymentMethodLabel: string | null;
  shipmentNote: string | null;
  shippedAt: Date | null;
  items: { productName: string; variantLabel: string | null; quantity: number; unitPrice: string }[];
}

export interface PostSaleContext {
  /** El ultimo pedido del cliente, dentro de la ventana. */
  order: PostSaleOrder;
  /** true cuando ese pedido se cerro en OTRA conversacion (el caso de Andres). */
  fromAnotherConversation: boolean;
}

// La edad del pedido se cuenta en DIAS CALENDARIO de la zona del negocio, no en bloques de 24 horas
// (2026-09-17, ver src/ai/clock.ts). Un pedido de las 19:36 del martes en Bogota es 00:36 del
// miercoles en UTC: a las 10:33 del miercoles la resta en UTC daba 0 y la respuesta correcta es 1.
// Es justo el borde donde el cliente pregunta "y entonces manana me llega?", asi que era el unico
// borde donde el numero no podia estar mal.

/**
 * El ultimo pedido de ESTE cliente, sin importar en que conversacion se cerro.
 *
 * Por cliente y no por conversacion a proposito: `Order.conversationId` es 1:1 con la conversacion donde
 * se cerro, asi que una consulta por conversacion no encuentra nada justo en el caso que importa - el
 * cliente que vuelve a escribir despues de que su venta cerro y abre una conversacion nueva.
 *
 * Un pedido cancelado SIGUE contando: el cliente que escribe despues de una cancelacion pregunta por esa
 * cancelacion, no esta navegando el catalogo. Lo que decide es la fecha, no el estado.
 */
export async function getPostSaleContext(
  businessId: string,
  customerId: string,
  conversationId: string,
  now: Date = new Date(),
  timezone = "UTC"
): Promise<PostSaleContext | null> {
  const order = await prisma.order.findFirst({
    where: { businessId, customerId, createdAt: { gte: new Date(now.getTime() - POST_SALE_WINDOW_DAYS * 24 * 60 * 60 * 1000) } },
    include: { items: { select: { productName: true, variantLabel: true, quantity: true, unitPrice: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (!order) return null;

  return {
    order: {
      id: order.id,
      createdAt: order.createdAt,
      ageDays: localDaysBetween(order.createdAt, now, timezone),
      fulfillmentStatus: String(order.fulfillmentStatus),
      canceledAt: order.canceledAt,
      summary: order.summary,
      totalAmount: String(order.totalAmount),
      currency: order.currency,
      shippingCost: order.shippingCost !== null ? String(order.shippingCost) : null,
      shippingAddress: order.shippingAddress,
      paymentMethodLabel: order.paymentMethodLabel,
      shipmentNote: order.shipmentNote,
      shippedAt: order.shippedAt,
      items: order.items.map((i) => ({
        productName: i.productName,
        variantLabel: i.variantLabel,
        quantity: i.quantity,
        unitPrice: String(i.unitPrice),
      })),
    },
    fromAnotherConversation: order.conversationId !== conversationId,
  };
}

/**
 * Los hechos del pedido, listos para el mensaje de sistema. Funcion pura: se prueba sin base.
 *
 * Es DATO, no un mensaje escrito ni una instruccion de que contestar. Que decir y como decirlo sigue
 * siendo del agente - lo que deja de ser suyo es tener que acordarse de ir a buscarlo.
 */
export function postSaleFactsForModel(context: PostSaleContext): Record<string, unknown> {
  const { order } = context;
  return {
    pedidoCreado: order.createdAt.toISOString(),
    diasDesdeLaCompra: order.ageDays,
    estado: order.canceledAt ? "CANCELADO" : order.fulfillmentStatus,
    despachadoEl: order.shippedAt ? order.shippedAt.toISOString() : null,
    notaDeDespacho: order.shipmentNote,
    resumen: order.summary,
    productos: order.items.map((i) => ({
      producto: i.productName,
      variante: i.variantLabel,
      cantidad: i.quantity,
      precioUnitario: i.unitPrice,
    })),
    envio: order.shippingCost,
    total: order.totalAmount,
    moneda: order.currency,
    direccionDeEntrega: order.shippingAddress,
    formaDePago: order.paymentMethodLabel,
    cerradoEnOtraConversacion: context.fromAnotherConversation,
  };
}
