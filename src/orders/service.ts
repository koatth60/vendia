import { prisma } from "../db/client";
import type { OrderFulfillmentStatus } from "@prisma/client";
import { findConfidentProductMatch } from "../catalog/products";
import { sendInteractiveButtonsMessage, type WhatsappCredentials } from "../whatsapp/client";
import { getPresignedMediaUrl } from "../media/s3";
import { emitOrderNew, emitOrderUpdated } from "../realtime/events";

export interface ResolvedOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}

export interface OrderItemInput {
  productName: string;
  quantity: number;
}

export interface ResolveOrderItemsResult {
  items: ResolvedOrderItem[];
  unresolved: string[];
}

// Matches by confidence (findConfidentProductMatch), not a blind top-of-search-results guess - a weak
// or ambiguous match here used to silently record the wrong product (and its price) on a real order.
// Items that still can't be matched confidently are reported back in `unresolved` instead of vanishing
// silently - the free-text summary carries them too, but now the caller can act on it (e.g. warn the
// owner) instead of the structured order record just quietly being short a line.
// Two input lines resolving to the same product (the model split one item across two tool-call entries,
// or the customer's order was described twice) are merged into one line with summed quantity, instead of
// creating duplicate OrderItem rows for the same product.
export async function resolveOrderItems(businessId: string, items: OrderItemInput[] | undefined): Promise<ResolveOrderItemsResult> {
  if (!items || items.length === 0) return { items: [], unresolved: [] };

  const byProductId = new Map<string, ResolvedOrderItem>();
  const unresolved: string[] = [];

  for (const item of items) {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const rawName = String(item.productName ?? "").trim();
    if (!rawName) continue;

    const match = await findConfidentProductMatch(businessId, rawName);
    if (!match.product) {
      unresolved.push(rawName);
      continue;
    }

    const product = match.product;
    const existing = byProductId.get(product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      byProductId.set(product.id, {
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice: Number(product.price),
        currency: product.currency,
      });
    }
  }

  return { items: Array.from(byProductId.values()), unresolved };
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
}) {
  const { businessId, customerId, conversationId, summary, items, shippingAddress, paymentMethodLabel, shippingCost } = params;
  const currency = items[0]?.currency ?? "COP";
  const itemsTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const totalAmount = itemsTotal + (shippingCost || 0);

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
        currency,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            currency: item.currency,
          })),
        },
      },
      include: { items: true },
    });

    for (const item of items) {
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
  try {
    const wamid = await sendInteractiveButtonsMessage(
      credentials,
      customerPhone,
      "¿Cómo calificarías la atención que recibiste? 😊",
      [
        { id: "csat_3", title: "😃 Buena" },
        { id: "csat_2", title: "😐 Regular" },
        { id: "csat_1", title: "😞 Mala" },
      ]
    );
    if (!wamid) return;
    await prisma.order.update({ where: { id: orderId }, data: { csatAskedAt: new Date() } });
  } catch (error) {
    console.error("No se pudo enviar la encuesta de satisfaccion:", error);
  }
}

export async function recordCsatReply(
  businessId: string,
  customerPhone: string,
  buttonId: string
): Promise<{ recorded: boolean }> {
  const rating = CSAT_BUTTON_RATINGS[buttonId];
  if (!rating) return { recorded: false };

  const customer = await prisma.customer.findFirst({ where: { businessId, phoneNumber: customerPhone } });
  if (!customer) return { recorded: false };

  const order = await prisma.order.findFirst({
    where: { customerId: customer.id, csatAskedAt: { not: null }, csatRating: null },
    orderBy: { createdAt: "desc" },
  });
  if (!order) return { recorded: false };

  await prisma.order.update({ where: { id: order.id }, data: { csatRating: rating } });
  return { recorded: true };
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
  const counts: Record<OrderFulfillmentStatus, number> = { PENDING: 0, SHIPPED: 0, CANCELED: 0 };
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

export async function markOrderShipped(
  businessId: string,
  orderId: string,
  data: { note?: string | null; mediaS3Key?: string | null; mediaType?: string | null }
) {
  const order = await prisma.order.findFirst({ where: { id: orderId, businessId } });
  if (!order) return null;
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      fulfillmentStatus: "SHIPPED",
      shippedAt: new Date(),
      shipmentNote: data.note || null,
      shipmentMediaS3Key: data.mediaS3Key || null,
      shipmentMediaType: data.mediaType || null,
    },
  });
  emitOrderUpdated(businessId, orderId);
  return updated;
}

export async function markOrderCanceled(businessId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, businessId } });
  if (!order) return null;
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { fulfillmentStatus: "CANCELED", canceledAt: new Date() },
  });
  emitOrderUpdated(businessId, orderId);
  return updated;
}
