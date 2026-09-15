import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getConfigHealth, getSaleGate } from "./configHealth";

// Fase G of the 2026-09-13 audit (robustez multi-negocio): each of these checks corresponds to a real,
// silent production failure mode found this session (F5: no contactPhone means every escalation is an
// empty promise; F7: no categories means the attribute-filter forcing never engages). Nothing errors
// anywhere today when a business is missing one of these - this is the one place that checks and says so.

const businessIds: string[] = [];

async function makeBusiness(overrides: Partial<{ contactPhone: string | null }> = {}) {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: overrides.contactPhone ?? null,
    },
  });
  businessIds.push(business.id);
  return business;
}

after(async () => {
  await prisma.product.deleteMany({ where: { businessId: { in: businessIds } } });
  await prisma.paymentMethod.deleteMany({ where: { businessId: { in: businessIds } } });
  await prisma.shippingRate.deleteMany({ where: { businessId: { in: businessIds } } });
  await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
});

test("getConfigHealth: flags every gap on a brand-new business with nothing configured", async () => {
  const business = await makeBusiness();
  const health = await getConfigHealth(business.id);
  assert.equal(health.hasContactPhone, false);
  assert.equal(health.hasCategoriesConfigured, false);
  assert.equal(health.hasPaymentMethods, false);
  // Not connected to WhatsApp in this test - null (unknown), never a false positive "not approved".
  assert.equal(health.hasApprovedOwnerAlertTemplate, null);
  assert.equal(health.canConverse, false);
  assert.equal(health.canSell, false);
  assert.deepEqual(health.missingForSale, ["métodos de pago", "tarifas de envío", "teléfono de contacto"]);
});

test("getSaleGate: canConverse solo con al menos un producto activo, sin importar categoria", async () => {
  const business = await makeBusiness();
  assert.equal((await getSaleGate(business.id)).canConverse, false);
  await prisma.product.create({
    data: { businessId: business.id, name: "Reloj X", description: "d", category: null, price: 100000, currency: "COP", stock: 3 },
  });
  assert.equal((await getSaleGate(business.id)).canConverse, true);
});

test("getSaleGate: canSell exige metodos de pago, tarifa de envio y telefono de contacto a la vez", async () => {
  const business = await makeBusiness({ contactPhone: "573000000000" });
  await prisma.paymentMethod.create({
    data: { businessId: business.id, type: "TRANSFERENCIA", label: "Nequi", details: "123", active: true },
  });
  let gate = await getSaleGate(business.id);
  assert.equal(gate.canSell, false);
  assert.deepEqual(gate.missing, ["tarifas de envío"]);

  await prisma.shippingRate.create({ data: { businessId: business.id, label: "Estandar", cost: 15000 } });
  gate = await getSaleGate(business.id);
  assert.equal(gate.canSell, true);
  assert.deepEqual(gate.missing, []);
});

test("getConfigHealth: hasContactPhone true once configured", async () => {
  const business = await makeBusiness({ contactPhone: "573000000000" });
  const health = await getConfigHealth(business.id);
  assert.equal(health.hasContactPhone, true);
});

test("getConfigHealth: hasCategoriesConfigured true once at least one active product has a category", async () => {
  const business = await makeBusiness();
  await prisma.product.create({
    data: { businessId: business.id, name: "Reloj X", description: "d", category: "Smartwatches", price: 100000, currency: "COP", stock: 3 },
  });
  const health = await getConfigHealth(business.id);
  assert.equal(health.hasCategoriesConfigured, true);
});

test("getConfigHealth: hasPaymentMethods true once at least one active method exists", async () => {
  const business = await makeBusiness();
  await prisma.paymentMethod.create({
    data: { businessId: business.id, type: "TRANSFERENCIA", label: "Nequi", details: "123", active: true },
  });
  const health = await getConfigHealth(business.id);
  assert.equal(health.hasPaymentMethods, true);
});
