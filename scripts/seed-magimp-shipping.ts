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

// Real, sourced data (not invented): Cundinamarca's 116 municipios (Wikipedia's
// "Anexo:Municipios_de_Cundinamarca"), Soacha excluded since it already has its own tier above. Maps to
// the "Regional" tier per the business's own script ("otros municipios de Cundinamarca").
const CUNDINAMARCA_MUNICIPIOS = [
  "Chocontá", "Machetá", "Manta", "Sesquilé", "Suesca", "Tibirita", "Villapinzón", "Agua de Dios",
  "Girardot", "Guataquí", "Jerusalén", "Nariño", "Nilo", "Ricaurte", "Tocaima", "Caparrapí", "Guaduas",
  "Puerto Salgar", "Albán", "La Peña", "La Vega", "Nimaima", "Nocaima", "Quebradanegra", "San Francisco",
  "Sasaima", "Supatá", "Útica", "Vergara", "Villeta", "Gachalá", "Gachetá", "Gama", "Guasca", "Guatavita",
  "Junín", "La Calera", "Ubalá", "Beltrán", "Bituima", "Chaguaní", "Guayabal de Síquima", "Pulí",
  "San Juan de Rioseco", "Vianí", "Medina", "Paratebueno", "Cáqueza", "Chipaque", "Choachí", "Fómeque",
  "Fosca", "Guayabetal", "Gutiérrez", "Quetame", "Ubaque", "Une", "El Peñón", "La Palma", "Pacho", "Paime",
  "San Cayetano", "Topaipí", "Villagómez", "Yacopí", "Cajicá", "Chía", "Cogua", "Cota", "Gachancipá",
  "Nemocón", "Sopó", "Tabio", "Tenjo", "Tocancipá", "Zipaquirá", "Bojacá", "El Rosal", "Facatativá",
  "Funza", "Madrid", "Mosquera", "Subachoque", "Zipacón", "Sibaté", "Arbeláez", "Cabrera", "Fusagasugá",
  "Granada", "Pandi", "Pasca", "San Bernardo", "Silvania", "Tibacuy", "Venecia", "Anapoima", "Anolaima",
  "Apulo", "Cachipay", "El Colegio", "La Mesa", "Quipile", "San Antonio del Tequendama", "Tena", "Viotá",
  "Carmen de Carupa", "Cucunubá", "Fúquene", "Guachetá", "Lenguazaque", "Simijaca", "Susa", "Sutatausa",
  "Tausa", "Ubaté",
];

// Colombia's 32 department capitals (Wikipedia's "Anexo:Capitales_departamentales_de_Colombia_por_población"),
// Bogotá excluded (own tier). "Capital de departamento" is a simple, sourced heuristic for "principal
// city" per the business's "Nacional (principales ciudades de Colombia)" tier - a few of these (Mitú,
// Leticia, Puerto Carreño) are remote Amazon/Orinoquía capitals arguably closer to "Difícil Acceso" in
// spirit, accepted as a known simplification rather than left unclassified.
const DEPARTMENT_CAPITALS = [
  "Medellín", "Cali", "Barranquilla", "Cartagena", "Cúcuta", "Bucaramanga", "Villavicencio", "Santa Marta",
  "Valledupar", "Ibagué", "Montería", "Pereira", "Manizales", "Pasto", "Neiva", "Popayán", "Armenia",
  "Sincelejo", "Riohacha", "Tunja", "Yopal", "Florencia", "Quibdó", "Arauca", "Mocoa", "San Andrés",
  "San José del Guaviare", "Leticia", "Inírida", "Mitú", "Puerto Carreño",
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

  const REGIONAL_LABEL = "Regional (otros municipios de Cundinamarca)";
  const NACIONAL_LABEL = "Nacional (principales ciudades de Colombia)";
  const existingTaxonomyRules = await prisma.shippingCityRule.count({ where: { businessId: business.id, label: { in: [REGIONAL_LABEL, NACIONAL_LABEL] } } });
  if (existingTaxonomyRules > 0) {
    console.log(`Ya hay ${existingTaxonomyRules} reglas de taxonomia (Regional/Nacional) cargadas para ${business.name}, no se duplican.`);
  } else {
    for (const city of CUNDINAMARCA_MUNICIPIOS) {
      await createShippingCityRule(business.id, { city, label: REGIONAL_LABEL });
    }
    for (const city of DEPARTMENT_CAPITALS) {
      await createShippingCityRule(business.id, { city, label: NACIONAL_LABEL });
    }
    console.log(
      `Cargadas ${CUNDINAMARCA_MUNICIPIOS.length} reglas Regional + ${DEPARTMENT_CAPITALS.length} reglas Nacional para ${business.name}.`
    );
  }

  await prisma.business.update({ where: { id: business.id }, data: { ownerReminderMinutes: 5 } });
  console.log(`ownerReminderMinutes de ${business.name} puesto en 5 minutos (su propio guion lo promete).`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
