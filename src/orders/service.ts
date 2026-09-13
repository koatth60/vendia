import { prisma } from "../db/client";
import type { OrderFulfillmentStatus } from "@prisma/client";
import { findConfidentProductMatch } from "../catalog/products";
import { canonicalColors } from "../catalog/attributeTaxonomy";
import { normalizeForMatch, escapeForRegExp } from "../search/text";
import { sendInteractiveButtonsMessage, type WhatsappCredentials } from "../whatsapp/client";
import { getPresignedMediaUrl } from "../media/s3";
import { emitOrderNew, emitOrderUpdated } from "../realtime/events";

export interface ResolvedOrderItem {
  productId: string;
  productName: string;
  variantId?: string | null;
  variantLabel?: string | null;
  quantity: number;
  unitPrice: number;
  currency: string;
}

export interface OrderItemInput {
  productName: string;
  quantity: number;
  // Free text describing which color/size the customer picked (e.g. "rojo", "rojo talla M") - only
  // meaningful when the matched product has variants (see ProductVariant in schema.prisma). Matched by
  // the same color-synonym canonicalization used for catalog search, not exact string equality.
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
export async function resolveOrderItems(businessId: string, items: OrderItemInput[] | undefined): Promise<ResolveOrderItemsResult> {
  if (!items || items.length === 0) return { items: [], unresolved: [], needsAttribute: [] };

  const byKey = new Map<string, ResolvedOrderItem>();
  const unresolved: string[] = [];
  const needsAttribute: string[] = [];

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
    let variantId: string | null = null;
    let variantLabel: string | null = null;

    if (product.variants.length > 0) {
      const { variant, ambiguous } = matchVariant(product.variants, item.variantLabel ?? "");
      if (!variant) {
        needsAttribute.push(`${product.name}${ambiguous ? " (color/talla ambiguo)" : ""}`);
        continue;
      }
      variantId = variant.id;
      variantLabel = formatVariantLabel(variant.color, variant.size);
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

  return { items: Array.from(byKey.values()), unresolved, needsAttribute };
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
            variantId: item.variantId || null,
            variantLabel: item.variantLabel || null,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
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
