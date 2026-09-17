import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { resolveShippingRateForCity, modalidadesDeLaZona } from "./shippingRates";

// 2026-09-17. La contraentrega casi nunca es una politica del negocio entero: es por zona. En MAG.IMP
// vivia como prosa en las instrucciones ("si la ciudad es Bogota o Soacha, ofrece ademas Pago Contra
// Entrega Total"), o sea como una regla mas que el modelo tenia que recordar. Ahora es un dato que sale
// con la tarifa, en la misma llamada que ya resuelve la ciudad.

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
  await prisma.shippingRate.create({ data: { businessId, label: "Nacional", cost: 15000 } });
  await prisma.shippingCityRule.create({ data: { businessId, city: "Bogotá", normalizedCity: "bogota", label: "Bogotá" } });
  await prisma.shippingCityRule.create({ data: { businessId, city: "Cali", normalizedCity: "cali", label: "Nacional" } });
});

after(async () => {
  await prisma.shippingCityRule.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("una zona con contraentrega total la ofrece; la misma consulta trae tarifa y modalidades", async () => {
  const resuelta = await resolveShippingRateForCity(businessId, "Bogotá");
  assert.ok(resuelta);
  assert.equal(resuelta.label, "Bogotá");
  assert.ok(resuelta.paymentModalities.includes("COD_ALL"), "en esta zona se puede pagar todo al recibir");
});

test("una zona sin nada configurado cae a las modalidades del negocio, no a ninguna", async () => {
  // El vacio significa "esta zona no tiene nada distinto", no "esta zona no admite pagar".
  const resuelta = await resolveShippingRateForCity(businessId, "Cali");
  assert.ok(resuelta);
  assert.deepEqual(resuelta.paymentModalities, ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING"]);
  assert.ok(!resuelta.paymentModalities.includes("COD_ALL"), "y no se le ofrece contraentrega donde el negocio no la hace");
});

test("modalidadesDeLaZona respeta lo de la zona por encima de lo del negocio", async () => {
  const propias = await modalidadesDeLaZona(businessId, { paymentModalities: ["COD_ALL"] });
  assert.deepEqual(propias, ["COD_ALL"]);

  const heredadas = await modalidadesDeLaZona(businessId, { paymentModalities: [] });
  assert.deepEqual(heredadas, ["PREPAID_ALL", "PREPAID_PRODUCT_COD_SHIPPING"]);
});
