import { prisma } from "../db/client";
import { normalizeForMatch, escapeForRegExp } from "../search/text";

export async function listShippingRates(businessId: string) {
  return prisma.shippingRate.findMany({
    where: { businessId },
    orderBy: { sortOrder: "asc" },
  });
}

export async function createShippingRate(businessId: string, data: { label: string; cost: number; sortOrder?: number }) {
  return prisma.shippingRate.create({ data: { businessId, label: data.label, cost: data.cost, sortOrder: data.sortOrder ?? 0 } });
}

export async function listShippingCityRules(businessId: string) {
  return prisma.shippingCityRule.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
}

export async function createShippingCityRule(businessId: string, data: { city: string; label: string }) {
  return prisma.shippingCityRule.create({
    data: { businessId, city: data.city.trim(), normalizedCity: normalizeForMatch(data.city.trim()), label: data.label },
  });
}

// Resolves a customer-typed city against this business's configured exact-match rules, then re-resolves
// the rule's label against the CURRENT ShippingRate rows (not a cached cost) - a renamed/deleted
// ShippingRate just makes this return null, same as "no rule configured", never an error.
export async function resolveShippingRateForCity(businessId: string, city: string) {
  const normalizedCity = normalizeForMatch(city.trim());
  if (!normalizedCity) return null;

  let rule = await prisma.shippingCityRule.findUnique({
    where: { businessId_normalizedCity: { businessId, normalizedCity } },
  });

  if (!rule) {
    // Exact match failed - real customer text often carries extra qualifiers a configured city name
    // doesn't have ("Bogota D.C.", "Medellin centro"), so it never equals the stored normalizedCity even
    // though the intent is unambiguous. Fall back to whichever configured city name appears as a whole
    // word inside what the customer typed, instead of giving up and pushing the decision to model prose
    // (reliability plan Phase 3, item 3, 2026-09-13). Longest match wins so a business with both "Bogota"
    // and "Bogota Norte" configured resolves the more specific one first.
    const rules = await prisma.shippingCityRule.findMany({ where: { businessId } });
    const candidates = rules
      .filter((r) => new RegExp(`(^|[^a-z0-9])${escapeForRegExp(r.normalizedCity)}($|[^a-z0-9])`, "i").test(normalizedCity))
      .sort((a, b) => b.normalizedCity.length - a.normalizedCity.length);
    rule = candidates[0] ?? null;
  }
  if (!rule) return null;

  const rate = await prisma.shippingRate.findFirst({
    where: { businessId, label: rule.label },
    orderBy: { sortOrder: "asc" },
  });
  return rate ? { label: rate.label, cost: rate.cost } : null;
}
