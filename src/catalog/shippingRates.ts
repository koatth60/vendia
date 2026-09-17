import { prisma } from "../db/client";
import { normalizeForMatch, escapeForRegExp } from "../search/text";
import type { ShippingPaymentModality } from "@prisma/client";

export async function listShippingRates(businessId: string) {
  return prisma.shippingRate.findMany({
    where: { businessId },
    orderBy: { sortOrder: "asc" },
  });
}

export async function createShippingRate(
  businessId: string,
  data: { label: string; cost: number; sortOrder?: number; paymentModalities?: ShippingPaymentModality[] }
) {
  return prisma.shippingRate.create({
    data: {
      businessId,
      label: data.label,
      cost: data.cost,
      sortOrder: data.sortOrder ?? 0,
      paymentModalities: data.paymentModalities ?? [],
    },
  });
}

// Fase 4 (ver ONIX-CRM-REORG-PLAN.md): estas dos tablas existian desde antes y el agente ya las
// consulta (get_shipping_rates/get_shipping_rate_for_city), pero no tenian ninguna interfaz - se
// cargaban con scripts/seed-magimp-shipping.ts. update/delete son nuevos, create/list ya existian.
export async function updateShippingRate(
  businessId: string,
  id: string,
  data: Partial<{ label: string; cost: number; sortOrder: number; paymentModalities: ShippingPaymentModality[] }>
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

export async function createShippingCityRule(
  businessId: string,
  data: { city: string; label: string; paymentModalities?: ShippingPaymentModality[] }
) {
  return prisma.shippingCityRule.create({
    data: {
      businessId,
      city: data.city.trim(),
      normalizedCity: normalizeForMatch(data.city.trim()),
      label: data.label,
      paymentModalities: data.paymentModalities ?? [],
    },
  });
}

/**
 * Prende o apaga, EN UNA CIUDAD, que el cliente pueda pagar todo al recibir.
 *
 * De las tres modalidades, esta es la unica que depende del lugar: las otras dos se pagan por
 * transferencia y se pueden hacer desde cualquier parte. Aceptar que paguen todo al recibir depende de
 * si el negocio llega ahi con su propio mensajero, y eso cambia ciudad por ciudad.
 *
 * La lista se arma en el servidor y no en el panel: se parte de lo que esa ciudad heredaria (su tarifa,
 * o el negocio) y se le suma o resta COD_ALL. Asi prender el interruptor no puede agregarle al negocio
 * una modalidad que no ofrece, que es lo que pasaria si el panel mandara la lista entera.
 */
export async function setCityAcceptsFullCod(businessId: string, id: string, acepta: boolean) {
  const rule = await prisma.shippingCityRule.findFirst({ where: { id, businessId } });
  if (!rule) throw new Error("Regla de ciudad no encontrada");

  const heredadas = await modalidadesHeredadasPorCiudad(businessId, rule.label);
  const sinCod = heredadas.filter((m) => m !== "COD_ALL");
  const nuevas = acepta ? [...sinCod, "COD_ALL" as const] : sinCod;

  // Si el resultado coincide con lo que heredaria, se guarda vacio: "aca no hay nada distinto" se
  // escribe como nada, no como una copia que despues se desincroniza de su tarifa.
  const igualAHeredado = nuevas.length === heredadas.length && nuevas.every((m) => heredadas.includes(m));
  return prisma.shippingCityRule.update({
    where: { id },
    data: { paymentModalities: { set: igualAHeredado ? [] : nuevas } },
  });
}

/** Lo que una ciudad heredaria si no tuviera nada propio: su tarifa, y si esa tampoco tiene, el negocio. */
async function modalidadesHeredadasPorCiudad(businessId: string, label: string): Promise<ShippingPaymentModality[]> {
  const rate = await prisma.shippingRate.findFirst({ where: { businessId, label }, orderBy: { sortOrder: "asc" } });
  if (rate && rate.paymentModalities.length > 0) return rate.paymentModalities;
  const negocio = await prisma.business.findUnique({
    where: { id: businessId },
    select: { shippingPaymentModalities: true },
  });
  return negocio?.shippingPaymentModalities ?? [];
}

/**
 * Las reglas de ciudad de una pagina, con el dato que el panel necesita pintar: si en esa ciudad se
 * acepta pagar todo al recibir, ya resuelto (lo propio si tiene, lo heredado si no).
 */
export async function withFullCodResolved<T extends { label: string; paymentModalities: ShippingPaymentModality[] }>(
  businessId: string,
  rules: T[]
): Promise<(T & { aceptaPagoTotalAlRecibir: boolean })[]> {
  if (rules.length === 0) return [];
  const [rates, negocio] = await Promise.all([
    prisma.shippingRate.findMany({ where: { businessId }, select: { label: true, paymentModalities: true } }),
    prisma.business.findUnique({ where: { id: businessId }, select: { shippingPaymentModalities: true } }),
  ]);
  const porTarifa = new Map(rates.map((r) => [r.label, r.paymentModalities]));
  const delNegocio = negocio?.shippingPaymentModalities ?? [];
  return rules.map((rule) => {
    const propias = rule.paymentModalities;
    const deTarifa = porTarifa.get(rule.label) ?? [];
    const efectivas = propias.length > 0 ? propias : deTarifa.length > 0 ? deTarifa : delNegocio;
    return { ...rule, aceptaPagoTotalAlRecibir: efectivas.includes("COD_ALL") };
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
  if (!rate) return null;
  // La modalidad de pago del envio viaja CON la tarifa (2026-09-17). Es el mismo viaje a la base y la
  // misma pregunta del cliente ("¿a donde te lo mando?"), y sin esto la unica forma de saber que en esta
  // zona se puede pagar todo al recibir era una frase escrita en las instrucciones del negocio.
  //
  // La CIUDAD manda sobre la tarifa: aceptar que paguen todo al recibir depende de si el negocio llega
  // ahi con su mensajero, y las tarifas agrupan por costo ("Nacional" junta Medellin con cien ciudades).
  return {
    label: rate.label,
    cost: rate.cost,
    paymentModalities: await modalidadesDeLaZona(businessId, rule.paymentModalities.length > 0 ? rule : rate),
  };
}

/**
 * Las modalidades de pago del envio que aplican en una zona: las suyas si tiene, y si no las del negocio.
 *
 * El vacio no significa "ninguna", significa "no se configuro nada distinto para esta zona". Un negocio
 * que ofrece lo mismo en todo el pais no tiene que cargar la lista tarifa por tarifa, y uno que tiene una
 * excepcion la carga solo donde existe.
 */
export async function modalidadesDeLaZona(
  businessId: string,
  rate: { paymentModalities: ShippingPaymentModality[] }
): Promise<ShippingPaymentModality[]> {
  if (rate.paymentModalities.length > 0) return rate.paymentModalities;
  const negocio = await prisma.business.findUnique({
    where: { id: businessId },
    select: { shippingPaymentModalities: true },
  });
  return negocio?.shippingPaymentModalities ?? [];
}
