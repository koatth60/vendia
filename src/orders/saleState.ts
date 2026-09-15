import { prisma } from "../db/client";
import type { ShippingPaymentModality } from "@prisma/client";
import { getProductById } from "../catalog/products";
import { resolveShippingRateForCity } from "../catalog/shippingRates";
import { computeCheckoutState, type CheckoutFacts, type CheckoutState } from "./checkoutState";

// Fase 2 del plan maestro (2026-09-15), causa raiz C1. Unico dueno de lectura/escritura de SaleState -
// ver ONIX-PLAN-MAESTRO.md seccion 1.3 y 4 (Fase 2) para el diseno completo. Nada fuera de este archivo
// escribe la tabla SaleState directamente.
//
// Principio del plan: "se deriva, no se duplica". `missing`, `subtotal`, `total`, `shippingCost` (y la
// ciudad/zona de envio) NUNCA se guardan - se recalculan aca mismo en cada lectura a partir de `items` y
// `address`, reusando computeCheckoutState (orders/checkoutState.ts) tal cual ya existe, para que nunca
// puedan desincronizarse de la base real.

export interface SaleStateItem {
  productId: string;
  productName: string;
  variantId: string | null;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  currency: string;
}

export interface SaleStateSnapshot {
  conversationId: string;
  items: SaleStateItem[];
  customerName: string | null;
  idNumber: string | null;
  deliveryPhone: string | null;
  address: string | null;
  city: string | null;
  shippingLabel: string | null;
  shippingCost: number | null;
  shippingModality: ShippingPaymentModality | null;
  paymentMethodId: string | null;
  paymentMethodLabel: string | null;
  blockedBy: string | null;
  checkout: CheckoutState;
  subtotal: number;
  total: number;
}

export interface SaleStateToolError {
  ok: false;
  reason: string;
  error: string;
  availableVariants?: { id: string; color: string | null; size: string | null }[];
  availableStock?: number;
  validCodes?: string[];
  validMethods?: { id: string; label: string }[];
}

async function isEnabled(businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { saleStateEnabled: true } });
  return business?.saleStateEnabled ?? false;
}

function parseItems(raw: unknown): SaleStateItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is SaleStateItem =>
      i && typeof i === "object" && typeof (i as SaleStateItem).productId === "string" && typeof (i as SaleStateItem).quantity === "number"
  );
}

// Misma extraccion que checkoutStateFromDb.ts ya usaba: la ciudad no tiene campo propio, se infiere de
// la direccion probando cada linea/segmento contra las reglas reales del negocio (ShippingCityRule).
async function resolveCityAndShipping(
  businessId: string,
  address: string | null
): Promise<{ city: string | null; label: string | null; cost: number | null }> {
  if (!address) return { city: null, label: null, cost: null };
  for (const trozo of address.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)) {
    const tarifa = await resolveShippingRateForCity(businessId, trozo);
    if (tarifa) return { city: trozo, label: tarifa.label, cost: Number(tarifa.cost) };
  }
  return { city: null, label: null, cost: null };
}

// Lee el estado completo, con fallback al perfil del Customer para lo que esta conversacion todavia no
// escribio (ver comentario del modelo en schema.prisma) - asi un cliente que vuelve no pierde lo que ya
// dio antes, pero cualquier dato nuevo que escriba EN esta conversacion manda sobre lo viejo.
export async function getSaleState(conversationId: string): Promise<SaleStateSnapshot | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      saleState: true,
      customer: { select: { businessId: true, name: true, idNumber: true, deliveryPhone: true, address: true } },
    },
  });
  if (!conversation) return null;
  const { businessId } = conversation.customer;
  const state = conversation.saleState;

  const customerName = state?.customerName ?? conversation.customer.name;
  const idNumber = state?.idNumber ?? conversation.customer.idNumber;
  const deliveryPhone = state?.deliveryPhone ?? conversation.customer.deliveryPhone;
  const address = state?.address ?? conversation.customer.address;
  const items = parseItems(state?.items);

  const { city, label: shippingLabel, cost: shippingCost } = await resolveCityAndShipping(businessId, address);

  let paymentMethodLabel: string | null = null;
  if (state?.paymentMethodId) {
    const method = await prisma.paymentMethod.findFirst({ where: { id: state.paymentMethodId, businessId } });
    paymentMethodLabel = method?.label ?? null;
  }

  let varianteFaltante = false;
  for (const item of items) {
    if (item.variantId) continue;
    const product = await prisma.product.findFirst({
      where: { id: item.productId, businessId },
      select: { variants: { where: { active: true }, select: { id: true } } },
    });
    if ((product?.variants.length ?? 0) > 0) {
      varianteFaltante = true;
      break;
    }
  }

  const facts: CheckoutFacts = {
    pais: "CO",
    productos: items.map((i) => ({ nombre: i.productName, cantidad: i.quantity, variante: i.variantLabel })),
    varianteFaltante,
    nombre: customerName,
    documento: idNumber,
    telefono: deliveryPhone,
    ciudad: city,
    direccion: address,
    formaPago: paymentMethodLabel,
    zonaEnvio: shippingLabel,
  };
  const checkout = computeCheckoutState(facts);

  const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const total = subtotal + (shippingCost ?? 0);

  return {
    conversationId,
    items,
    customerName,
    idNumber,
    deliveryPhone,
    address,
    city,
    shippingLabel,
    shippingCost,
    shippingModality: state?.shippingModality ?? null,
    paymentMethodId: state?.paymentMethodId ?? null,
    paymentMethodLabel,
    blockedBy: state?.blockedBy ?? null,
    checkout,
    subtotal,
    total,
  };
}

// Texto fijo que agent.ts inyecta como mensaje system en cada turno (mismo canal que ya usa "FOTOS/
// VIDEOS YA ENVIADOS") - el modelo lo lee, nunca lo escribe.
export function formatSaleStateForPrompt(state: SaleStateSnapshot): string {
  if (state.items.length === 0 && state.checkout.faltan.length === 0) return "";
  const itemsText =
    state.items.length > 0
      ? state.items.map((i) => `${i.quantity}x ${i.productName}${i.variantLabel ? ` (${i.variantLabel})` : ""}`).join(", ")
      : "(todavia sin productos)";
  const faltan = state.checkout.faltan.length > 0 ? state.checkout.faltan.join(", ") : "nada, ya esta completo";
  return `PEDIDO EN CURSO: ${itemsText}. Falta: ${faltan}.`;
}

async function upsertSaleState(conversationId: string, data: Record<string, unknown>) {
  return prisma.saleState.upsert({
    where: { conversationId },
    create: { conversationId, ...data },
    update: data,
  });
}

export async function setOrderItem(
  businessId: string,
  conversationId: string,
  input: { productId: string; variantId?: string | null; quantity: number }
): Promise<{ ok: true; item: SaleStateItem; state: SaleStateSnapshot } | SaleStateToolError> {
  const quantity = Math.floor(Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { ok: false, reason: "invalid_quantity", error: "La cantidad tiene que ser un numero entero de al menos 1." };
  }

  const product = await getProductById(businessId, input.productId);
  if (!product || !product.active) {
    return { ok: false, reason: "product_not_found", error: `No se encontro ningun producto activo con id "${input.productId}".` };
  }

  const activeVariants = product.variants.filter((v) => v.active);
  let variantId: string | null = null;
  let variantLabel: string | null = null;
  let stock = product.stock;

  if (activeVariants.length > 0) {
    if (!input.variantId) {
      return {
        ok: false,
        reason: "needs_variant",
        error: `"${product.name}" tiene variantes - falta elegir cual.`,
        availableVariants: activeVariants.map((v) => ({ id: v.id, color: v.color, size: v.size })),
      };
    }
    const variant = activeVariants.find((v) => v.id === input.variantId);
    if (!variant) {
      return {
        ok: false,
        reason: "invalid_variant",
        error: `La variante "${input.variantId}" no existe o no esta activa en "${product.name}".`,
        availableVariants: activeVariants.map((v) => ({ id: v.id, color: v.color, size: v.size })),
      };
    }
    variantId = variant.id;
    variantLabel = [variant.color, variant.size].filter(Boolean).join(" / ") || null;
    stock = variant.stock;
  }

  if (quantity > stock) {
    return {
      ok: false,
      reason: "insufficient_stock",
      error: `Solo quedan ${stock} unidades disponibles de "${product.name}"${variantLabel ? ` (${variantLabel})` : ""}.`,
      availableStock: stock,
    };
  }

  const current = await getSaleState(conversationId);
  const items = current?.items ?? [];
  const key = (i: SaleStateItem) => `${i.productId}|${i.variantId ?? ""}`;
  const newItem: SaleStateItem = {
    productId: product.id,
    productName: product.name,
    variantId,
    variantLabel,
    quantity,
    unitPrice: Number(product.price),
    currency: product.currency,
  };
  const thisKey = `${product.id}|${variantId ?? ""}`;
  const nextItems = [...items.filter((i) => key(i) !== thisKey), newItem];

  await upsertSaleState(conversationId, { items: nextItems });
  const state = await getSaleState(conversationId);
  return { ok: true, item: newItem, state: state! };
}

export async function removeOrderItem(
  conversationId: string,
  input: { productId: string; variantId?: string | null }
): Promise<{ ok: true; state: SaleStateSnapshot } | SaleStateToolError> {
  const current = await getSaleState(conversationId);
  const items = current?.items ?? [];
  const nextItems = input.variantId
    ? items.filter((i) => !(i.productId === input.productId && i.variantId === input.variantId))
    : items.filter((i) => i.productId !== input.productId);

  if (nextItems.length === items.length) {
    return { ok: false, reason: "not_found", error: "No hay ese producto en el pedido en curso." };
  }

  await upsertSaleState(conversationId, { items: nextItems });
  const state = await getSaleState(conversationId);
  return { ok: true, state: state! };
}

export async function setShippingModality(
  businessId: string,
  conversationId: string,
  code: string
): Promise<{ ok: true; state: SaleStateSnapshot } | SaleStateToolError> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { shippingPaymentModalities: true } });
  const valid = business?.shippingPaymentModalities ?? [];
  if (!valid.includes(code as ShippingPaymentModality)) {
    return {
      ok: false,
      reason: "invalid_modality",
      error: `"${code}" no es una modalidad de pago de envio configurada por este negocio.`,
      validCodes: valid,
    };
  }
  await upsertSaleState(conversationId, { shippingModality: code as ShippingPaymentModality });
  const state = await getSaleState(conversationId);
  return { ok: true, state: state! };
}

export async function setPaymentMethod(
  businessId: string,
  conversationId: string,
  paymentMethodId: string
): Promise<{ ok: true; state: SaleStateSnapshot } | SaleStateToolError> {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, businessId, active: true } });
  if (!method) {
    const active = await prisma.paymentMethod.findMany({ where: { businessId, active: true }, select: { id: true, label: true } });
    return {
      ok: false,
      reason: "invalid_payment_method",
      error: `El metodo de pago "${paymentMethodId}" no existe o no esta activo en este negocio.`,
      validMethods: active,
    };
  }
  await upsertSaleState(conversationId, { paymentMethodId: method.id });
  const state = await getSaleState(conversationId);
  return { ok: true, state: state! };
}

// Llamado por save_customer_contact_info/save_customer_name en tools.ts cuando el negocio tiene la
// bandera activa - dual-write ademas de lo que esas herramientas ya guardan en Customer (ver comentario
// del modelo SaleState en schema.prisma sobre por que no alcanza con leer solo Customer).
export async function saveDeliveryDataToSaleState(
  conversationId: string,
  data: { customerName?: string; idNumber?: string; deliveryPhone?: string; address?: string }
): Promise<void> {
  const payload: Record<string, string> = {};
  if (data.customerName) payload.customerName = data.customerName;
  if (data.idNumber) payload.idNumber = data.idNumber;
  if (data.deliveryPhone) payload.deliveryPhone = data.deliveryPhone;
  if (data.address) payload.address = data.address;
  if (Object.keys(payload).length === 0) return;
  await upsertSaleState(conversationId, payload);
}

export { isEnabled as isSaleStateEnabled };
