import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { montoACobrarAlEntregar, resolverModalidadDelPedido } from "./paymentTiming";

// Fase 3 (2026-09-17). El pedido guardaba el total y con que metodo, pero no CUANDO se cobra, asi que
// "¿cuanto le cobro al mensajero?" solo se respondia releyendo el chat.

test("el monto a cobrar sale de la modalidad, y sin modalidad no se inventa un cero", () => {
  const montos = { itemsTotal: 145000, shippingCost: 9000 };
  assert.equal(montoACobrarAlEntregar("PREPAID_ALL", montos), 0);
  assert.equal(montoACobrarAlEntregar("PREPAID_PRODUCT_COD_SHIPPING", montos), 9000);
  assert.equal(montoACobrarAlEntregar("COD_ALL", montos), 154000);
  // null no es cero: un cero le dice al mensajero "no le cobres nada".
  assert.equal(montoACobrarAlEntregar(null, montos), null);
});

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      shippingPaymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING"],
    },
  });
  businessId = business.id;
  await prisma.shippingRate.create({
    data: { businessId, label: "Bogotá", cost: 9000, paymentModalities: ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING", "COD_ALL"] },
  });
  await prisma.shippingCityRule.create({ data: { businessId, city: "Bogotá", normalizedCity: "bogota", label: "Bogotá" } });
});

after(async () => {
  await prisma.shippingCityRule.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("la modalidad declarada se acepta si aplica en la zona del cliente", async () => {
  const m = await resolverModalidadDelPedido(businessId, { declarada: "COD_ALL", cobraAlRecibir: true, city: "Bogotá" });
  assert.equal(m, "COD_ALL");
});

test("una modalidad que el negocio no ofrece en esa zona se descarta", async () => {
  // Es el mismo criterio con el que el bot se la ofrecio: fuera de Bogota no hay contraentrega total.
  const m = await resolverModalidadDelPedido(businessId, { declarada: "COD_ALL", cobraAlRecibir: false, city: "Cali" });
  assert.notEqual(m, "COD_ALL");
});

test("un metodo que cobra al recibir resuelve contraentrega total sin que nadie lo declare", async () => {
  // El dato es PaymentMethod.settlement, no una deduccion sobre la prosa.
  const m = await resolverModalidadDelPedido(businessId, { cobraAlRecibir: true, city: "Bogotá" });
  assert.equal(m, "COD_ALL");
});

test("con una sola modalidad posible no hubo nada que elegir", async () => {
  const solo = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      shippingPaymentModalities: ["PREPAID_ALL"],
    },
  });
  try {
    const m = await resolverModalidadDelPedido(solo.id, { cobraAlRecibir: false });
    assert.equal(m, "PREPAID_ALL");
  } finally {
    await prisma.business.deleteMany({ where: { id: solo.id } });
  }
});

test("sin nada con que resolver queda null, no una suposicion", async () => {
  const m = await resolverModalidadDelPedido(businessId, { cobraAlRecibir: false });
  assert.equal(m, null);
});
