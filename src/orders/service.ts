import { prisma } from "../db/client";
import { searchProducts } from "../catalog/products";
import { sendInteractiveButtonsMessage, type WhatsappCredentials } from "../whatsapp/client";
import { getPresignedMediaUrl } from "../media/s3";

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

// Items that don't match a catalog product are dropped from the structured record -
// the free-text summary already carries the full human-readable picture regardless.
export async function resolveOrderItems(businessId: string, items: OrderItemInput[] | undefined): Promise<ResolvedOrderItem[]> {
  if (!items || items.length === 0) return [];

  const resolved: ResolvedOrderItem[] = [];
  for (const item of items) {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const matches = await searchProducts(businessId, String(item.productName ?? ""));
    if (matches.length === 0) continue;
    const product = matches[0];
    resolved.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice: Number(product.price),
      currency: product.currency,
    });
  }
  return resolved;
}

export async function createOrder(params: {
  businessId: string;
  customerId: string;
  conversationId: string;
  summary: string;
  items: ResolvedOrderItem[];
  shippingAddress?: string | null;
  paymentMethodLabel?: string | null;
}) {
  const { businessId, customerId, conversationId, summary, items, shippingAddress, paymentMethodLabel } = params;
  const currency = items[0]?.currency ?? "COP";
  const totalAmount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  return prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId,
      summary,
      shippingAddress: shippingAddress || null,
      paymentMethodLabel: paymentMethodLabel || null,
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

function formatOrder<T extends { totalAmount: unknown; items: { unitPrice: unknown }[] }>(order: T) {
  return {
    ...order,
    totalAmount: String(order.totalAmount),
    items: order.items.map((item) => ({ ...item, unitPrice: String(item.unitPrice) })),
  };
}

export async function listOrdersForBusiness(businessId: string) {
  const orders = await prisma.order.findMany({
    where: { businessId },
    include: { items: true, customer: true },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(
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
}

export async function getOrderForBusiness(businessId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, businessId },
    include: { customer: true },
  });
}

export async function markOrderShipped(
  businessId: string,
  orderId: string,
  data: { note?: string | null; mediaS3Key?: string | null; mediaType?: string | null }
) {
  const order = await prisma.order.findFirst({ where: { id: orderId, businessId } });
  if (!order) return null;
  return prisma.order.update({
    where: { id: orderId },
    data: {
      fulfillmentStatus: "SHIPPED",
      shippedAt: new Date(),
      shipmentNote: data.note || null,
      shipmentMediaS3Key: data.mediaS3Key || null,
      shipmentMediaType: data.mediaType || null,
    },
  });
}

export async function markOrderCanceled(businessId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, businessId } });
  if (!order) return null;
  return prisma.order.update({
    where: { id: orderId },
    data: { fulfillmentStatus: "CANCELED", canceledAt: new Date() },
  });
}
