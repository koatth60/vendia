import { prisma } from "../db/client";
import { searchProducts } from "../catalog/products";

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
  return orders.map((order) => ({
    ...formatOrder(order),
    customer: { phoneNumber: order.customer.phoneNumber, name: order.customer.name },
  }));
}
