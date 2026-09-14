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

// Fase 4 (ver ONIX-CRM-REORG-PLAN.md): estas dos tablas existian desde antes y el agente ya las
// consulta (get_shipping_rates/get_shipping_rate_for_city), pero no tenian ninguna interfaz - se
// cargaban con scripts/seed-magimp-shipping.ts. update/delete son nuevos, create/list ya existian.
export async function updateShippingRate(
  businessId: string,
  id: string,
  data: Partial<{ label: string; cost: number; sortOrder: number }>
) {
  const rate = await prisma.shippingRate.findFirst({ where: { id, businessId } });
  if (!rate) throw new Error("Tarifa de envío no encontrada");
  return prisma.shippingRate.update({ where: { id }, data });
}

export async function deleteShippingRate(businessId: string, id: string) {
  const rate = await prisma.shippingRate.findFirst({ where: { id, businessId } });
  if (!rate) throw new Error("Tarifa de envío no encontrada");
  return prisma.shippingRate.delete({ where: { id } });
}

export async function listShippingCityRules(businessId: string) {
  return prisma.shippingCityRule.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
}

// Paginada, para la lista del panel (Bot > Envíos > Reglas por ciudad) - una sola ciudad ambigua de
// Colombia son ~1.122 municipios posibles y un negocio real puede terminar con cientos de filas acá
// (feedback del dueño, 2026-09-13: la lista sin paginar quedaba "extremadamente larga"). Funcion
// NUEVA y separada de listShippingCityRules de arriba a proposito: esa la sigue usando solo el
// panel en ningun otro lado hoy, pero mantenerlas separadas evita que un cambio futuro que SI la
// comparta con el agente herede un limite por accidente.
export async function listShippingCityRulesPage(businessId: string, skip: number, take: number, q?: string) {
  const where = q ? { businessId, city: { contains: q, mode: "insensitive" as const } } : { businessId };
  const [items, total] = await Promise.all([
    // id asc como desempate, mismo motivo que listAllProductsPage: createdAt puede empatar entre
    // filas cargadas rapido seguidas (ej. una carga masiva de ciudades) y sin desempate el orden
    // entre esas filas no es estable de una pagina a la siguiente.
    prisma.shippingCityRule.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip, take }),
    prisma.shippingCityRule.count({ where }),
  ]);
  return { items, total };
}

export async function createShippingCityRule(businessId: string, data: { city: string; label: string }) {
  return prisma.shippingCityRule.create({
    data: { businessId, city: data.city.trim(), normalizedCity: normalizeForMatch(data.city.trim()), label: data.label },
  });
}

export async function deleteShippingCityRule(businessId: string, id: string) {
  const rule = await prisma.shippingCityRule.findFirst({ where: { id, businessId } });
  if (!rule) throw new Error("Regla de ciudad no encontrada");
  return prisma.shippingCityRule.delete({ where: { id } });
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
