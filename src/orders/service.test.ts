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

// Reliability plan Phase 3, item 1 (2026-09-13): matchVariant used to score a variant's color via
// canonicalColors(v.color)[0] - only the FIRST canonical color of a multi-color label. A variant literally
// named "Negro/Dorado" never matched a customer asking for "dorado" since only "negro" (the first token)
// was ever compared.
test("resolveOrderItems: a variant labeled with two colors matches a request for either one", async () => {
  const product = await createProduct(businessId, {
    name: "Reloj Bicolor Test",
    description: "Reloj con caratula de dos colores",
    price: 60000,
    currency: "COP",
    stock: 0,
  });
  const bicolor = await createProductVariant(businessId, product.id, { color: "Negro/Dorado", stock: 2 });
  await createProductVariant(businessId, product.id, { color: "Plateado", stock: 1 });

  const result = await resolveOrderItems(businessId, [
    { productName: "Reloj Bicolor Test", quantity: 1, variantLabel: "dorado" },
  ]);
  assert.equal(result.needsAttribute.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].variantId, bicolor.id);

  await prisma.product.delete({ where: { id: product.id } });
});

// Phase 3, item 2: matchVariant used to score size via `labelNorm.includes(normalizeForMatch(v.size))`, a
// raw substring check - a variant sized "M" matched any customer text containing an "m" anywhere, e.g.
// "morado". Needs a word-boundary check instead.
test("resolveOrderItems: a size variant does not false-match an unrelated word merely containing its letter", async () => {
  const product = await createProduct(businessId, {
    name: "Camiseta Talla Test",
    description: "Camiseta en varias tallas",
    price: 35000,
    currency: "COP",
    stock: 0,
  });
  await createProductVariant(businessId, product.id, { size: "M", stock: 2 });
  await createProductVariant(businessId, product.id, { size: "L", stock: 1 });

  // "morado" contains the letter "m" but is not the size "M" - must NOT resolve, since neither size has
  // real evidence and there's no way to tell which one the customer meant.
  const falseMatch = await resolveOrderItems(businessId, [
    { productName: "Camiseta Talla Test", quantity: 1, variantLabel: "morado" },
  ]);
  assert.equal(falseMatch.items.length, 0, "must NOT resolve to the 'M' variant just because 'morado' contains an m");
  assert.equal(falseMatch.needsAttribute.length, 1);

  // A real, unambiguous size mention still resolves correctly.
  const realMatch = await resolveOrderItems(businessId, [
    { productName: "Camiseta Talla Test", quantity: 1, variantLabel: "talla M" },
  ]);
  assert.equal(realMatch.needsAttribute.length, 0);
  assert.equal(realMatch.items.length, 1);
  assert.equal(realMatch.items[0].variantLabel, "M");

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

// Bug de produccion (2026-09-15, MAGByLizN): dos productos casi identicos empataban en
// findConfidentProductMatch (puntaje por nombre) y el cierre de venta por nombre libre se rechazaba
// aunque el producto elegido si existiera en el catalogo. El panel ahora manda el productId real, que
// resuelve directo sin puntaje ni empate posible - estas pruebas cubren esa ruta.
test("resolveOrderItems: productId resolves directly even when two products would tie by name score", async () => {
  const a = await createProduct(businessId, {
    name: "Smartwatch Serie 11 Mini",
    description: "Reloj inteligente",
    price: 145000,
    currency: "COP",
    stock: 5,
  });
  const b = await createProduct(businessId, {
    name: "Smartwatch Serie 11 Max",
    description: "Reloj inteligente",
    price: 165000,
    currency: "COP",
    stock: 5,
  });

  // Por nombre libre, "Smartwatch Serie 11" empata entre los dos (mismo puntaje, misma descripcion) -
  // confirma que el escenario de empate existe antes de probar que productId lo evita.
  const byName = await resolveOrderItems(businessId, [{ productName: "Smartwatch Serie 11", quantity: 1 }]);
  assert.equal(byName.items.length, 0);
  assert.equal(byName.unresolved.length, 1, "ambiguo por nombre debe caer en unresolved, no resolverse a ciegas");

  const byId = await resolveOrderItems(businessId, [{ productId: b.id, productName: "Smartwatch Serie 11", quantity: 1 }]);
  assert.equal(byId.unresolved.length, 0);
  assert.equal(byId.items.length, 1);
  assert.equal(byId.items[0].productId, b.id);
  assert.equal(byId.items[0].productName, "Smartwatch Serie 11 Max");

  await prisma.product.deleteMany({ where: { id: { in: [a.id, b.id] } } });
});

test("resolveOrderItems: a productId belonging to another business is rejected, not resolved cross-tenant", async () => {
  const otherBusiness = await prisma.business.create({
    data: { name: `Other Business ${randomUUID()}`, email: `other-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const otherProduct = await createProduct(otherBusiness.id, {
    name: "Producto De Otro Negocio",
    description: "No deberia ser visible para businessId",
    price: 10000,
    currency: "COP",
    stock: 5,
  });

  const result = await resolveOrderItems(businessId, [
    { productId: otherProduct.id, productName: "Producto De Otro Negocio", quantity: 1 },
  ]);
  assert.equal(result.items.length, 0, "no debe resolver un productId de otro negocio");
  assert.equal(result.unresolved.length, 1);

  await prisma.product.delete({ where: { id: otherProduct.id } });
  await prisma.business.delete({ where: { id: otherBusiness.id } });
});

test("resolveOrderItems: an inactive product's id is rejected, not resolved", async () => {
  const product = await createProduct(businessId, {
    name: "Producto Descontinuado Test",
    description: "Ya no se vende",
    price: 20000,
    currency: "COP",
    stock: 0,
  });
  await prisma.product.update({ where: { id: product.id }, data: { active: false } });

  const result = await resolveOrderItems(businessId, [{ productId: product.id, productName: "Producto Descontinuado Test", quantity: 1 }]);
  assert.equal(result.items.length, 0);
  assert.equal(result.unresolved.length, 1);

  await prisma.product.delete({ where: { id: product.id } });
});

test("resolveOrderItems: variantId resolves directly without needing a variantLabel guess", async () => {
  const product = await createProduct(businessId, {
    name: "Diadema M4 Test Id",
    description: "Diadema bluetooth en varios colores",
    price: 45000,
    currency: "COP",
    stock: 0,
  });
  const red = await createProductVariant(businessId, product.id, { color: "Rojo", stock: 2 });
  await createProductVariant(businessId, product.id, { color: "Amarillo", stock: 1 });

  const result = await resolveOrderItems(businessId, [{ productId: product.id, variantId: red.id, quantity: 1 }]);
  assert.equal(result.needsAttribute.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].variantId, red.id);
  assert.equal(result.items[0].variantLabel, "Rojo");

  await prisma.product.delete({ where: { id: product.id } });
});

test("resolveOrderItems: a variantId that doesn't belong to the product falls into needsAttribute, not a wrong variant", async () => {
  const productA = await createProduct(businessId, {
    name: "Diadema M4 Test Id A",
    description: "Diadema bluetooth",
    price: 45000,
    currency: "COP",
    stock: 0,
  });
  const productB = await createProduct(businessId, {
    name: "Diadema M4 Test Id B",
    description: "Otra diadema",
    price: 45000,
    currency: "COP",
    stock: 0,
  });
  await createProductVariant(businessId, productA.id, { color: "Rojo", stock: 2 });
  const variantOfB = await createProductVariant(businessId, productB.id, { color: "Azul", stock: 2 });

  const result = await resolveOrderItems(businessId, [{ productId: productA.id, variantId: variantOfB.id, quantity: 1 }]);
  assert.equal(result.items.length, 0);
  assert.equal(result.needsAttribute.length, 1);

  await prisma.product.deleteMany({ where: { id: { in: [productA.id, productB.id] } } });
});
