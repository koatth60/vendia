import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getLatestOrderForCustomer, resolveOrderItems } from "./service";
import { createProduct, createProductVariant } from "../catalog/products";

let businessId: string;
let customerId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test Business ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573005${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("getLatestOrderForCustomer returns null when the customer has no orders", async () => {
  const order = await getLatestOrderForCustomer(businessId, customerId);
  assert.equal(order, null);
});

test("getLatestOrderForCustomer returns the most recent order across different conversations", async () => {
  // Order.conversationId is 1:1 with the conversation it closed in - a customer's order history spans
  // multiple conversations over time, so the lookup must go through customerId, not conversationId.
  const conversationA = await prisma.conversation.create({ data: { customerId } });
  const orderA = await prisma.order.create({
    data: { businessId, customerId, conversationId: conversationA.id, summary: "Pedido viejo", totalAmount: 50000, currency: "COP" },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const conversationB = await prisma.conversation.create({ data: { customerId } });
  const orderB = await prisma.order.create({
    data: { businessId, customerId, conversationId: conversationB.id, summary: "Pedido nuevo", totalAmount: 90000, currency: "COP" },
  });

  const latest = await getLatestOrderForCustomer(businessId, customerId);
  assert.ok(latest);
  assert.equal(latest!.id, orderB.id);
  assert.equal(latest!.summary, "Pedido nuevo");
  assert.notEqual(latest!.id, orderA.id);

  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
});

// Coverage for the checkout attribute completeness guard (2026-09-12 plan): a real sale closed once
// without ever asking the customer's color, because nothing forced it. resolveOrderItems is the code
// that decides whether a variant-bearing product's order line is actually resolved or must block the
// close - see needsAttribute in ResolveOrderItemsResult.
test("resolveOrderItems: a product with variants and no variantLabel is reported in needsAttribute, not silently resolved", async () => {
  const product = await createProduct(businessId, {
    name: "Diadema M4 Test",
    description: "Diadema bluetooth en varios colores",
    price: 45000,
    currency: "COP",
    stock: 0,
  });
  await createProductVariant(businessId, product.id, { color: "Rojo", stock: 2 });
  await createProductVariant(businessId, product.id, { color: "Amarillo", stock: 1 });

  const result = await resolveOrderItems(businessId, [{ productName: "Diadema M4 Test", quantity: 1 }]);
  assert.equal(result.items.length, 0, "must NOT create an order line with an unresolved color");
  assert.equal(result.needsAttribute.length, 1);
  assert.match(result.needsAttribute[0], /Diadema M4 Test/);

  await prisma.product.delete({ where: { id: product.id } });
});

test("resolveOrderItems: a variantLabel that matches one color resolves to that specific variant", async () => {
  const product = await createProduct(businessId, {
    name: "Diadema M4 Test 2",
    description: "Diadema bluetooth en varios colores",
    price: 45000,
    currency: "COP",
    stock: 0,
  });
  const red = await createProductVariant(businessId, product.id, { color: "Rojo", stock: 2 });
  await createProductVariant(businessId, product.id, { color: "Amarillo", stock: 1 });

  const result = await resolveOrderItems(businessId, [
    { productName: "Diadema M4 Test 2", quantity: 1, variantLabel: "rojo" },
  ]);
  assert.equal(result.needsAttribute.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].variantId, red.id);
  assert.equal(result.items[0].variantLabel, "Rojo");

  await prisma.product.delete({ where: { id: product.id } });
});

test("resolveOrderItems: a product with no variants at all resolves exactly as before (no attribute needed)", async () => {
  const product = await createProduct(businessId, {
    name: "Producto Simple Test",
    description: "Sin variantes",
    price: 30000,
    currency: "COP",
    stock: 5,
  });

  const result = await resolveOrderItems(businessId, [{ productName: "Producto Simple Test", quantity: 2 }]);
  assert.equal(result.needsAttribute.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].variantId, null);
  assert.equal(result.items[0].quantity, 2);

  await prisma.product.delete({ where: { id: product.id } });
});
