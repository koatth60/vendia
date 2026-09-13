import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  createShippingRate,
  updateShippingRate,
  deleteShippingRate,
  createShippingCityRule,
  deleteShippingCityRule,
  resolveShippingRateForCity,
} from "./shippingRates";

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test Business ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.shippingCityRule.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
});

test("resolveShippingRateForCity: exact configured city resolves as before", async () => {
  await createShippingRate(businessId, { label: "Nacional", cost: 12000 });
  await createShippingCityRule(businessId, { city: "Bogota", label: "Nacional" });

  const rate = await resolveShippingRateForCity(businessId, "Bogota");
  assert.ok(rate);
  assert.equal(rate!.label, "Nacional");
  assert.equal(rate!.cost.toString(), "12000");
});

// Reliability plan Phase 3, item 3 (2026-09-13): exact normalized-city lookup only used to resolve
// nothing for "Bogota D.C." or "Medellin centro" even when "Bogota"/"Medellin" was configured - the
// customer's extra wording never equals the stored normalizedCity. A prefix/contains fallback closes the
// gap instead of pushing the decision to model prose.
test("resolveShippingRateForCity: extra customer wording around a configured city still resolves", async () => {
  const withDC = await resolveShippingRateForCity(businessId, "Bogota D.C.");
  assert.ok(withDC, "Bogota D.C. must resolve via the Bogota rule");
  assert.equal(withDC!.label, "Nacional");

  await createShippingRate(businessId, { label: "Medellin Local", cost: 8000 });
  await createShippingCityRule(businessId, { city: "Medellin", label: "Medellin Local" });

  const withSuffix = await resolveShippingRateForCity(businessId, "Medellin centro");
  assert.ok(withSuffix, "Medellin centro must resolve via the Medellin rule");
  assert.equal(withSuffix!.label, "Medellin Local");
});

test("resolveShippingRateForCity: an unconfigured city that only shares a substring does not false-match", async () => {
  // "Bogota" is configured; "Cundinamarca" shares no whole word with it and must not resolve.
  const rate = await resolveShippingRateForCity(businessId, "Cundinamarca");
  assert.equal(rate, null);
});

test("resolveShippingRateForCity: the more specific of two configured city names wins", async () => {
  await createShippingRate(businessId, { label: "Bogota Norte", cost: 15000 });
  await createShippingCityRule(businessId, { city: "Bogota Norte", label: "Bogota Norte" });

  const specific = await resolveShippingRateForCity(businessId, "Bogota Norte apto 302");
  assert.ok(specific);
  assert.equal(specific!.label, "Bogota Norte");
});

test("updateShippingRate solo cambia lo enviado y respeta el aislamiento por negocio", async () => {
  const rate = await createShippingRate(businessId, { label: "Express", cost: 20000 });
  const updated = await updateShippingRate(businessId, rate.id, { cost: 25000 });
  assert.equal(Number(updated.cost), 25000);
  assert.equal(updated.label, "Express", "el label no cambia si no se envia");

  const other = await prisma.business.create({
    data: { name: `Other ${randomUUID()}`, email: `other-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await assert.rejects(() => updateShippingRate(other.id, rate.id, { cost: 1 }), /no encontrada/);
  await prisma.business.delete({ where: { id: other.id } });
});

test("deleteShippingRate borra la tarifa y falla sobre un id de otro negocio", async () => {
  const rate = await createShippingRate(businessId, { label: "Temporal", cost: 5000 });
  const other = await prisma.business.create({
    data: { name: `Other ${randomUUID()}`, email: `other2-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await assert.rejects(() => deleteShippingRate(other.id, rate.id), /no encontrada/);
  await deleteShippingRate(businessId, rate.id);
  assert.equal(await prisma.shippingRate.findUnique({ where: { id: rate.id } }), null);
  await prisma.business.delete({ where: { id: other.id } });
});

test("deleteShippingCityRule borra la regla y falla sobre un id de otro negocio", async () => {
  const rule = await createShippingCityRule(businessId, { city: "Cali", label: "Nacional" });
  const other = await prisma.business.create({
    data: { name: `Other ${randomUUID()}`, email: `other3-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await assert.rejects(() => deleteShippingCityRule(other.id, rule.id), /no encontrada/);
  await deleteShippingCityRule(businessId, rule.id);
  assert.equal(await prisma.shippingCityRule.findUnique({ where: { id: rule.id } }), null);
  await prisma.business.delete({ where: { id: other.id } });
});
