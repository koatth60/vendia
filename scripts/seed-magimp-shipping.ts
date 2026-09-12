import { prisma } from "../src/db/client";
import { createShippingCityRule } from "../src/catalog/shippingRates";

// One-off seed for MAGByLizN's real shipping tiers (from its customInstructions prose) into the new
// structured ShippingRate table, plus its promised 5-minute owner-reminder threshold. No UI for this yet
// (same stopgap pattern as scripts/set-whatsapp.ts) - run manually over SSH.
const RATES = [
  { label: "Bogotá", cost: 9000, sortOrder: 1 },
  { label: "Soacha", cost: 10000, sortOrder: 2 },
  { label: "Regional (otros municipios de Cundinamarca)", cost: 12500, sortOrder: 3 },
  { label: "Nacional (principales ciudades de Colombia)", cost: 18500, sortOrder: 4 },
  { label: "Municipal (otros municipios de Colombia)", cost: 20900, sortOrder: 5 },
  { label: "Difícil acceso", cost: 31900, sortOrder: 6 },
  { label: "Vereda / zona rural", cost: 88900, sortOrder: 7 },
];

const CITY_RULES = [
  { city: "Bogotá", label: "Bogotá" },
  { city: "Soacha", label: "Soacha" },
];

async function main() {
  const business = await prisma.business.findFirst({ where: { name: { contains: "MAGByLizN", mode: "insensitive" } } });
  if (!business) {
    console.error('No se encontró el negocio "MAGByLizN"');
    process.exit(1);
  }

  const existing = await prisma.shippingRate.count({ where: { businessId: business.id } });
  if (existing > 0) {
    console.log(`Ya hay ${existing} tarifas cargadas para ${business.name}, no se duplican.`);
  } else {
    await prisma.shippingRate.createMany({ data: RATES.map((r) => ({ ...r, businessId: business.id })) });
    console.log(`Cargadas ${RATES.length} tarifas de envío para ${business.name}.`);
  }

  const existingRules = await prisma.shippingCityRule.count({ where: { businessId: business.id } });
  if (existingRules > 0) {
    console.log(`Ya hay ${existingRules} reglas de ciudad cargadas para ${business.name}, no se duplican.`);
  } else {
    for (const rule of CITY_RULES) {
      await createShippingCityRule(business.id, rule);
    }
    console.log(`Cargadas ${CITY_RULES.length} reglas de ciudad para ${business.name}.`);
  }

  await prisma.business.update({ where: { id: business.id }, data: { ownerReminderMinutes: 5 } });
  console.log(`ownerReminderMinutes de ${business.name} puesto en 5 minutos (su propio guion lo promete).`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
