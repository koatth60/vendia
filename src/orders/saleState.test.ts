import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { createProduct } from "../catalog/products";
import { createShippingRate, createShippingCityRule } from "../catalog/shippingRates";
import { createPaymentMethod } from "../catalog/paymentMethods";
import {
  getSaleState,
  setOrderItem,
  removeOrderItem,
  setShippingModality,
  setPaymentMethod,
  formatSaleStateForPrompt,
} from "./saleState";

// Fase 2 del plan maestro (2026-09-15), causa raiz C1: cobertura del unico dueno de lectura/escritura
// de SaleState. Cada caso prueba una validacion real del motor (contra catalogo/config), no prosa.

let businessId: string;
let customerId: string;
let simpleProductId: string;
let variantProductId: string;
let variantAId: string;
let variantBId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test SaleState ${randomUUID()}`,
      email: `test-salestate-${randomUUID()}@example.com`,
      passwordHash: "x",
      shippingPaymentModalities: ["PREPAID_ALL", "COD_ALL"],
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573001${Date.now()}` } });
  customerId = customer.id;

  const simple = await createProduct(businessId, { name: "Cargador USB-C", description: "d", price: 20000, stock: 3 });
  simpleProductId = simple.id;

  const withVariants = await createProduct(businessId, {
    name: "Diadema Bluetooth",
    description: "d",
    price: 50000,
    stock: 0,
    variants: [
      { color: "negro", stock: 2 },
      { color: "rojo", stock: 0 },
    ],
  });
  variantProductId = withVariants.id;
  variantAId = withVariants.variants[0].id;
  variantBId = withVariants.variants[1].id;

  await createShippingRate(businessId, { label: "Bogotá", cost: 9000 });
  await createShippingCityRule(businessId, { city: "Bogotá", label: "Bogotá" });
  await createPaymentMethod(businessId, { type: "TRANSFERENCIA", label: "Nequi", details: "300 000 0000" });
});

after(async () => {
  await prisma.saleState.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.shippingCityRule.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

async function freshConversation() {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  return conversation.id;
}

test("set_order_item guarda una linea simple y getSaleState calcula subtotal/total", async () => {
  const conversationId = await freshConversation();
  const result = await setOrderItem(businessId, conversationId, { productId: simpleProductId, quantity: 2 });
  assert.ok(result.ok, "se esperaba ok:true");
  if (!result.ok) return;
  assert.equal(result.item.unitPrice, 20000);

  const state = await getSaleState(conversationId);
  assert.ok(state);
  assert.equal(state!.items.length, 1);
  assert.equal(state!.subtotal, 40000);
  // Sin direccion todavia, no hay costo de envio resuelto.
  assert.equal(state!.shippingCost, null);
  assert.equal(state!.total, 40000);
});

test("set_order_item es SET, no SUMA: llamar dos veces reemplaza la cantidad", async () => {
  const conversationId = await freshConversation();
  await setOrderItem(businessId, conversationId, { productId: simpleProductId, quantity: 1 });
  const second = await setOrderItem(businessId, conversationId, { productId: simpleProductId, quantity: 2 });
  assert.ok(second.ok);

  const state = await getSaleState(conversationId);
  assert.equal(state!.items.length, 1);
  assert.equal(state!.items[0].quantity, 2);
});

test("set_order_item exige variante cuando el producto tiene variantes activas", async () => {
  const conversationId = await freshConversation();
  const result = await setOrderItem(businessId, conversationId, { productId: variantProductId, quantity: 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "needs_variant");
  assert.equal(result.availableVariants?.length, 2);
});

test("set_order_item rechaza una variante inactiva/inexistente", async () => {
  const conversationId = await freshConversation();
  const result = await setOrderItem(businessId, conversationId, {
    productId: variantProductId,
    variantId: "no-existe",
    quantity: 1,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_variant");
});

test("set_order_item rechaza cantidad mayor al stock real de la variante", async () => {
  const conversationId = await freshConversation();
  const result = await setOrderItem(businessId, conversationId, { productId: variantProductId, variantId: variantAId, quantity: 3 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "insufficient_stock");
  assert.equal(result.availableStock, 2);
});

test("set_order_item acepta la variante correcta dentro de stock", async () => {
  const conversationId = await freshConversation();
  const result = await setOrderItem(businessId, conversationId, { productId: variantProductId, variantId: variantAId, quantity: 2 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.item.variantLabel, "negro");
});

test("remove_order_item quita una linea, y avisa si no existe", async () => {
  const conversationId = await freshConversation();
  await setOrderItem(businessId, conversationId, { productId: simpleProductId, quantity: 1 });

  const notFound = await removeOrderItem(conversationId, { productId: variantProductId });
  assert.equal(notFound.ok, false);

  const removed = await removeOrderItem(conversationId, { productId: simpleProductId });
  assert.ok(removed.ok);
  if (!removed.ok) return;
  assert.equal(removed.state.items.length, 0);
});

test("set_shipping_modality valida contra las modalidades configuradas del negocio", async () => {
  const conversationId = await freshConversation();
  const bad = await setShippingModality(businessId, conversationId, "PREPAID_PRODUCT_COD_SHIPPING");
  assert.equal(bad.ok, false);

  const good = await setShippingModality(businessId, conversationId, "PREPAID_ALL");
  assert.ok(good.ok);
});

test("set_payment_method valida contra PaymentMethod activos del negocio", async () => {
  const conversationId = await freshConversation();
  const bad = await setPaymentMethod(businessId, conversationId, "no-existe");
  assert.equal(bad.ok, false);

  const method = await prisma.paymentMethod.findFirstOrThrow({ where: { businessId, label: "Nequi" } });
  const good = await setPaymentMethod(businessId, conversationId, method.id);
  assert.ok(good.ok);
  if (!good.ok) return;
  assert.equal(good.state.paymentMethodLabel, "Nequi");
});

test("getSaleState resuelve ciudad/costo de envio desde la direccion y calcula 'falta'", async () => {
  const conversationId = await freshConversation();
  await setOrderItem(businessId, conversationId, { productId: simpleProductId, quantity: 1 });

  const beforeAddress = await getSaleState(conversationId);
  assert.ok(beforeAddress!.checkout.faltan.length > 0);

  await prisma.saleState.update({
    where: { conversationId },
    data: { customerName: "Ana Perez", deliveryPhone: "3001234567", address: "Bogotá, barrio Kennedy, casa 12" },
  });

  const state = await getSaleState(conversationId);
  assert.equal(state!.city, "Bogotá");
  assert.equal(state!.shippingCost, 9000);
  assert.equal(state!.total, 20000 + 9000);
});

test("formatSaleStateForPrompt describe items y lo que falta", async () => {
  const conversationId = await freshConversation();
  await setOrderItem(businessId, conversationId, { productId: simpleProductId, quantity: 2 });
  const state = await getSaleState(conversationId);
  const text = formatSaleStateForPrompt(state!);
  assert.match(text, /PEDIDO EN CURSO/);
  assert.match(text, /2x Cargador USB-C/);
  assert.match(text, /Falta:/);
});
