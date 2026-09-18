import { prisma } from "../db/client";
import type { OrderFulfillmentStatus, ShippingPaymentModality } from "@prisma/client";
import { OrderFulfillmentStatus as OrderFulfillmentStatusEnum } from "@prisma/client";
import { montoACobrarAlEntregar } from "./paymentTiming";
import { findConfidentProductMatch, getProductById } from "../catalog/products";
import { canonicalColors } from "../catalog/attributeTaxonomy";
import { normalizeForMatch, escapeForRegExp } from "../search/text";
import { sendToCustomer, type WhatsappCredentials } from "../whatsapp/outbound";
import { getPresignedMediaUrl } from "../media/s3";
import { emitOrderNew, emitOrderUpdated } from "../realtime/events";
import { getAgreedPrices, applyAgreedPrices, agreedUnitPriceOf } from "./agreedPrices";
import { recalcularEtapaDelCliente } from "../crm/customers";
import { transicionarPedido, TransicionNoPermitida, type Actor } from "./stateMachine";

export interface ResolvedOrderItem {
  productId: string;
  productName: string;
  variantId?: string | null;
  variantLabel?: string | null;
  quantity: number;
  /** El precio que se cobra: el acordado con la duena si existe para esta conversacion, si no el de catalogo. */
  unitPrice: number;
  /**
   * El precio acordado, cuando lo hay (ver src/orders/agreedPrices.ts). null = se cobra el de catalogo.
   * `unitPrice` ya trae el valor efectivo en los dos casos; esto existe para poder DECIR de donde salio.
   */
  agreedUnitPrice?: number | null;
  currency: string;
}

export interface OrderItemInput {
  // Nombre libre (fuzzy match via findConfidentProductMatch) - unico dato disponible cuando viene del
  // modelo (nunca conoce el productId real) o del cuerpo viejo de close-sale (compatibilidad).
  productName?: string;
  // Cuando el llamador ya conoce el producto real (el panel, con su selector) - resuelve por id, sin
  // puntaje ni empate posible. Se valida que sea de este negocio y este activo (getProductById no filtra
  // por active, a diferencia de findConfidentProductMatch). productName se usa igual como texto para
  // `unresolved` si este id no resuelve.
  productId?: string;
  // Igual que productId pero para la variante (color/talla) - se valida que pertenezca a ese producto y
  // este activa. Si se da, reemplaza el matching por variantLabel de abajo.
  variantId?: string;
  quantity: number;
  // Free text describing which color/size the customer picked (e.g. "rojo", "rojo talla M") - solo se usa
  // cuando no vino variantId. Matched by the same color-synonym canonicalization used for catalog search,
  // not exact string equality.
  variantLabel?: string;
}

export interface ResolveOrderItemsResult {
  items: ResolvedOrderItem[];
  unresolved: string[];
  // Product names that DO have variants (color/size options) but the given variantLabel didn't resolve
  // to exactly one of them - either nothing was given, or it matched more than one equally. Real
  // production incident (2026-09-12): a sale closed without ever asking the customer's color. The caller
  // must refuse to close the sale while this is non-empty, not just warn about it like `unresolved`.
  needsAttribute: string[];
}

type VariantForMatch = { id: string; color: string | null; size: string | null; active: boolean };

// Scored the same way findConfidentProductMatch scores products: a hit on color (2) or size (2), refuse
// to guess on a tie or on zero evidence - see that function's comment for the "why weak evidence isn't
// enough to commit to a real order line" rationale, same logic applies here one level down.
function matchVariant(variants: VariantForMatch[], label: string): { variant: VariantForMatch | null; ambiguous: boolean } {
  const active = variants.filter((v) => v.active);
  if (active.length === 0) return { variant: null, ambiguous: false };
  if (active.length === 1) return { variant: active[0], ambiguous: false };

  const labelColors = canonicalColors(label);
  const labelNorm = normalizeForMatch(label);

  const scored = active
    .map((v) => {
      let score = 0;
      // Full set, not just the first canonical color - a variant labeled "negro/dorado" has two, and a
      // customer asking for "dorado" must still match it (reliability plan Phase 3, item 1, 2026-09-13).
      if (v.color && canonicalColors(v.color).some((c) => labelColors.includes(c))) score += 2;
      // Word-boundary check, not a raw substring - "labelNorm.includes(size)" used to let a variant sized
      // "M" match any customer text containing an "m" anywhere, e.g. "morado" (Phase 3, item 2).
      if (v.size) {
        const sizeNorm = normalizeForMatch(v.size).trim();
        if (sizeNorm && new RegExp(`(^|[^a-z0-9])${escapeForRegExp(sizeNorm)}($|[^a-z0-9])`, "i").test(labelNorm)) {
          score += 2;
        }
      }
      return { v, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { variant: null, ambiguous: false };
  const tied = scored.filter((s) => s.score === scored[0].score);
  if (tied.length > 1) return { variant: null, ambiguous: true };
  return { variant: scored[0].v, ambiguous: false };
}

function formatVariantLabel(color: string | null, size: string | null): string | null {
  const parts = [color, size].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

// Matches by confidence (findConfidentProductMatch), not a blind top-of-search-results guess - a weak
// or ambiguous match here used to silently record the wrong product (and its price) on a real order.
// Items that still can't be matched confidently are reported back in `unresolved` instead of vanishing
// silently - the free-text summary carries them too, but now the caller can act on it (e.g. warn the
// owner) instead of the structured order record just quietly being short a line.
// Two input lines resolving to the same product+variant (the model split one item across two tool-call
// entries, or the customer's order was described twice) are merged into one line with summed quantity,
// instead of creating duplicate OrderItem rows.
export async function resolveOrderItems(
  businessId: string,
  items: OrderItemInput[] | undefined,
  // EL PRECIO ACORDADO (2026-09-16): con la conversacion en mano, el precio de cada linea sale de la base
  // - el acordado con la duena si existe, el de catalogo si no. Sin conversacion (ningun llamador real
  // hoy) se comporta exactamente como antes de esta fase. Es el unico punto donde se arma una linea con
  // precio, asi que alcanza con resolverlo aca para que el resumen, el cierre y el panel coincidan.
  conversationId?: string
): Promise<ResolveOrderItemsResult> {
  if (!items || items.length === 0) return { items: [], unresolved: [], needsAttribute: [] };

  const byKey = new Map<string, ResolvedOrderItem>();
  const unresolved: string[] = [];
  const needsAttribute: string[] = [];

  for (const item of items) {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const rawName = String(item.productName ?? "").trim();

    let product: Awaited<ReturnType<typeof getProductById>> | null = null;
    if (item.productId) {
      // Resuelve por id, no por puntaje - lo usa el panel, que ya sabe exactamente que producto eligio
      // el dueno (Fase de correccion, 2026-09-15): sin esto, dos productos casi identicos empataban en
      // findConfidentProductMatch y la venta se rechazaba aunque el producto si existiera en el catalogo.
      // getProductById no filtra por `active` (a diferencia de findConfidentProductMatch), asi que un
      // producto desactivado igual se validaria aca sin este chequeo explicito - no se puede vender.
      const found = await getProductById(businessId, item.productId);
      if (found && found.active) product = found;
    } else if (rawName) {
      const match = await findConfidentProductMatch(businessId, rawName);
      product = match.product;
    }

    if (!product) {
      unresolved.push(rawName || item.productId || "(producto sin nombre)");
      continue;
    }

    let variantId: string | null = null;
    let variantLabel: string | null = null;

    if (product.variants.length > 0) {
      if (item.variantId) {
        const variant = product.variants.find((v) => v.id === item.variantId && v.active) ?? null;
        if (!variant) {
          needsAttribute.push(`${product.name} (variante invalida o inactiva)`);
          continue;
        }
        variantId = variant.id;
        variantLabel = formatVariantLabel(variant.color, variant.size);
      } else {
        const { variant, ambiguous } = matchVariant(product.variants, item.variantLabel ?? "");
        if (!variant) {
          needsAttribute.push(`${product.name}${ambiguous ? " (color/talla ambiguo)" : ""}`);
          continue;
        }
        variantId = variant.id;
        variantLabel = formatVariantLabel(variant.color, variant.size);
      }
    }

    const key = `${product.id}|${variantId ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      byKey.set(key, {
        productId: product.id,
        productName: product.name,
        variantId,
        variantLabel,
        quantity,
        unitPrice: Number(product.price),
        currency: product.currency,
      });
    }
  }

  const resolved = Array.from(byKey.values());
  if (!conversationId) return { items: resolved, unresolved, needsAttribute };
  const agreed = await getAgreedPrices(conversationId);
  const withAgreed = applyAgreedPrices(resolved, agreed).map((item) => ({
    ...item,
    agreedUnitPrice: agreedUnitPriceOf(item, agreed),
  }));
  return { items: withAgreed, unresolved, needsAttribute };
}

export async function createOrder(params: {
  businessId: string;
  customerId: string;
  conversationId: string;
  summary: string;
  items: ResolvedOrderItem[];
  shippingAddress?: string | null;
  paymentMethodLabel?: string | null;
  shippingCost?: number | null;
  /** Ver src/orders/paymentTiming.ts: cuando se paga este pedido. Null = no se pudo resolver sin adivinar. */
  shippingModality?: ShippingPaymentModality | null;
}) {
  const { businessId, customerId, conversationId, summary, items, shippingAddress, paymentMethodLabel, shippingCost } = params;
  const currency = items[0]?.currency ?? "COP";
  const itemsTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const totalAmount = itemsTotal + (shippingCost || 0);
  // Lo que el mensajero tiene que cobrar. Se guarda calculado y no derivado al leer: el precio de un
  // producto puede cambiar manana, y lo que se acordo en este pedido no.
  const amountOnDelivery = montoACobrarAlEntregar(params.shippingModality ?? null, {
    itemsTotal,
    shippingCost: shippingCost || 0,
  });

  // Stock was never decremented on a sale - a business could sell more units than it had in the
  // catalog and never find out until it physically ran out. Decrement in the same transaction as the
  // order so a real sale always moves the counter, clamped at 0 instead of going negative (an oversell
  // is still worth recording, but a negative on-hand count is just confusing in the admin panel).
  const createdOrder = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        businessId,
        customerId,
        conversationId,
        summary,
        shippingAddress: shippingAddress || null,
        paymentMethodLabel: paymentMethodLabel || null,
        shippingCost: shippingCost || null,
        totalAmount,
        shippingModality: params.shippingModality ?? null,
        amountOnDelivery,
        currency,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            variantId: item.variantId || null,
            variantLabel: item.variantLabel || null,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            agreedUnitPrice: item.agreedUnitPrice ?? null,
            currency: item.currency,
          })),
        },
      },
      include: { items: true },
    });

    for (const item of items) {
      // A variant sale decrements that variant's own stock, not the parent product's (which a
      // multi-variant product doesn't meaningfully track - see ProductVariant in schema.prisma).
      if (item.variantId) {
        const variant = await tx.productVariant.findUnique({ where: { id: item.variantId }, select: { stock: true } });
        if (!variant) continue;
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: Math.max(0, variant.stock - item.quantity) },
        });
        continue;
      }
      const product = await tx.product.findUnique({ where: { id: item.productId }, select: { stock: true } });
      if (!product) continue;
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: Math.max(0, product.stock - item.quantity) },
      });
    }

    return order;
  });

  emitOrderNew(businessId, createdOrder.id);
  // E41: la etapa del cliente la calcula el servidor, y este es el hecho que la mueve. Va DESPUES de la
  // transaccion a proposito: si el recalculo fallara, el pedido igual quedo creado - la etapa es un dato
  // derivado y el proximo pedido (o el job diario) la vuelve a poner bien. Al reves seria peor.
  try {
    await recalcularEtapaDelCliente(businessId, customerId);
  } catch (error) {
    console.error(`No se pudo recalcular la etapa de ${customerId} tras crear el pedido:`, error);
  }

  return createdOrder;
}

const CSAT_BUTTON_RATINGS: Record<string, number> = { csat_1: 1, csat_2: 2, csat_3: 3 };

// Asked right after a sale closes, while the 24h customer-service session is still open - waiting for
// "after delivery" would need an approved WhatsApp template (see followUpTemplateName), which isn't set
// up yet. Rates the sales experience, not the product/delivery itself.
export async function askForCsat(
  credentials: WhatsappCredentials,
  orderId: string,
  customerPhone: string
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { businessId: true, conversationId: true },
  });
  if (!order) return;
  const result = await sendToCustomer({
    businessId: order.businessId,
    conversationId: order.conversationId,
    credentials,
    to: customerPhone,
    content: {
      kind: "buttons",
      text: "¿Cómo calificarías la atención que recibiste? 😊",
      buttons: [
        { id: "csat_3", title: "😃 Buena" },
        { id: "csat_2", title: "😐 Regular" },
        { id: "csat_1", title: "😞 Mala" },
      ],
    },
    // La encuesta se manda justo despues de cerrar la venta, con la ventana abierta. Si por lo que sea
    // esta cerrada, no se gasta una plantilla de reenganche en pedir una calificacion.
    onWindowClosed: "fail",
  });
  if (!result.delivered) {
    console.error("No se pudo enviar la encuesta de satisfaccion:", result.failure?.message);
    return;
  }
  await prisma.order.update({ where: { id: orderId }, data: { csatAskedAt: new Date() } });
}

export async function recordCsatReply(
  businessId: string,
  customerPhone: string,
  buttonId: string
): Promise<{ recorded: boolean; conversationId: string | null }> {
  const rating = CSAT_BUTTON_RATINGS[buttonId];
  if (!rating) return { recorded: false, conversationId: null };

  const customer = await prisma.customer.findFirst({ where: { businessId, phoneNumber: customerPhone } });
  if (!customer) return { recorded: false, conversationId: null };

  const order = await prisma.order.findFirst({
    where: { customerId: customer.id, csatAskedAt: { not: null }, csatRating: null },
    orderBy: { createdAt: "desc" },
  });
  if (!order) return { recorded: false, conversationId: null };

  await prisma.order.update({ where: { id: order.id }, data: { csatRating: rating } });
  // Devuelve la conversacion para que el agradecimiento salga por la capa de salida, que necesita saber
  // contra que conversacion verificar la ventana de 24h.
  return { recorded: true, conversationId: order.conversationId };
}

function formatOrder<T extends { totalAmount: unknown; shippingCost: unknown; items: { unitPrice: unknown }[] }>(order: T) {
  return {
    ...order,
    totalAmount: String(order.totalAmount),
    shippingCost: order.shippingCost !== null ? String(order.shippingCost) : null,
    items: order.items.map((item) => ({ ...item, unitPrice: String(item.unitPrice) })),
  };
}

// Scoped to one status + a bounded page, not "every order this business ever had" - that used to be
// refetched in full (with a presigned S3 URL generated per order with shipment media) on a 30s poll AND
// every socket reconnect, forever, so the payload and the S3 API calls only ever grew as order history
// piled up. Pendientes/Enviados/Cancelados are now separate paged requests instead of one unbounded list.
export async function listOrdersForBusiness(
  businessId: string,
  status: OrderFulfillmentStatus,
  skip: number,
  take: number
) {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { businessId, fulfillmentStatus: status },
      include: { items: true, customer: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.order.count({ where: { businessId, fulfillmentStatus: status } }),
  ]);
  const formatted = await Promise.all(
    orders.map(async (order) => ({
      ...formatOrder(order),
      customer: {
        // id agregado en Fase 2 para poder enlazar un pedido con la ficha del cliente en el CRM
        // (P9 del diagnostico: antes no habia ningun salto entre pedido, cliente y conversacion).
        id: order.customer.id,
        phoneNumber: order.customer.phoneNumber,
        name: order.customer.name,
        idNumber: order.customer.idNumber,
        deliveryPhone: order.customer.deliveryPhone,
      },
      shipmentMediaUrl: order.shipmentMediaS3Key ? await getPresignedMediaUrl(order.shipmentMediaS3Key) : null,
    }))
  );
  return { orders: formatted, total };
}

// Cheap enough to poll on the same interval as before: no order rows, no presigned URLs, just 3 counts -
// used for the Pendientes/Enviados/Cancelados badge numbers regardless of which one is currently open.
export async function countOrdersByStatus(businessId: string): Promise<Record<OrderFulfillmentStatus, number>> {
  const rows = await prisma.order.groupBy({ by: ["fulfillmentStatus"], where: { businessId }, _count: true });
  // E31: se arma desde los valores del enum y no con tres literales. Con la lista escrita a mano, cada
  // estado nuevo que se agregue al esquema deja este objeto incompleto en silencio y su contador sale
  // como undefined en el panel.
  const counts = Object.fromEntries(
    Object.values(OrderFulfillmentStatusEnum).map((estado) => [estado, 0]),
  ) as Record<OrderFulfillmentStatus, number>;
  for (const row of rows) counts[row.fulfillmentStatus] = row._count;
  return counts;
}

export async function getOrderForBusiness(businessId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, businessId },
    include: { customer: true },
  });
}

// Order.conversationId is 1:1 (unique) - a second close_conversation(SOLD) call on a conversation that
// already has one used to hit that unique constraint as a raw, uncaught Prisma error, which propagated
// all the way out of generateReply's try/catch and got mislabeled "Fallo la llamada a DeepSeek" - found by
// replaying real historical conversations through the regression suite (2026-09-12). Checked here so
// close_conversation can degrade gracefully instead of crashing the whole turn.
export async function getOrderByConversationId(conversationId: string) {
  return prisma.order.findUnique({ where: { conversationId } });
}

// Looks up by customerId, not the current conversationId - Order.conversationId is 1:1 with the
// conversation it was closed in, so it can't be used to find a customer's order history across
// conversations (e.g. a new open conversation started after the sale closed the previous one).
export async function getLatestOrderForCustomer(businessId: string, customerId: string) {
  const order = await prisma.order.findFirst({
    where: { businessId, customerId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  return order ? formatOrder(order) : null;
}

// E31: las dos funciones que mueven el pedido pasan por la maquina de estados. Antes eran `update`
// sueltos que ni miraban el estado actual, asi que el panel podia cancelar un pedido YA ENVIADO y
// volver a enviar uno cancelado, sin dejar rastro de quien. Si la transicion no esta permitida, estas
// funciones TIRAN TransicionNoPermitida - las rutas la traducen a un 409 con el motivo en castellano.
export async function markOrderShipped(
  businessId: string,
  orderId: string,
  data: { note?: string | null; mediaS3Key?: string | null; mediaType?: string | null },
  actor: Actor = { tipo: "OWNER" }
) {
  const movido = await transicionarPedido({
    businessId,
    orderId,
    hacia: "SHIPPED",
    actor,
    datos: {
      shippedAt: new Date(),
      shipmentNote: data.note || null,
      shipmentMediaS3Key: data.mediaS3Key || null,
      shipmentMediaType: data.mediaType || null,
    },
  });
  if (!movido) return null;
  emitOrderUpdated(businessId, orderId);
  return prisma.order.findFirst({ where: { id: orderId, businessId } });
}

export async function markOrderCanceled(
  businessId: string,
  orderId: string,
  actor: Actor = { tipo: "OWNER" },
  motivo?: string | null
) {
  const movido = await transicionarPedido({
    businessId,
    orderId,
    hacia: "CANCELED",
    actor,
    motivo,
    datos: { canceledAt: new Date() },
  });
  if (!movido) return null;
  emitOrderUpdated(businessId, orderId);
  return prisma.order.findFirst({ where: { id: orderId, businessId } });
}
