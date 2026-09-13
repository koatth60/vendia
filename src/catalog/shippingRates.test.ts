import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { createShippingRate, createShippingCityRule, resolveShippingRateForCity } from "./shippingRates";

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
