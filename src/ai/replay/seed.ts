import { prisma } from "../../db/client";
import { normalizeForMatch } from "../../search/text";
import { formatPaymentExamples } from "../../catalog/paymentMethods";
import type { BotPersonality } from "../prompts/systemPrompt";
import catalogFixture from "../regression/fixtures/catalog.json";
import catalogMxFixture from "./catalog-mx.json";

// Fase 1 del plan maestro (2026-09-15): reusa el mismo catalogo real que ya usa
// scripts/run-regression-suite.ts (src/ai/regression/fixtures/catalog.json), en vez de mantener una
// segunda copia de Aurora Joyas / MAGByLizN que se desincroniza con el original. Un fixture de replay
// referencia el negocio por nombre ("Aurora Joyas", "MAGByLizN") y consigue el catalogo real con el
// que la conversacion original paso.
interface CatalogBusiness {
  name: string;
  // Fase 11 del plan maestro (2026-09-15): un catalogo puede declarar su pais. Los de
  // regression/fixtures/catalog.json no lo traen y quedan en el default colombiano, que es lo que eran.
  countryCode?: "CO" | "MX";
  currency?: string;
  timezone?: string;
  requiresIdDocument?: boolean;
  idDocumentExemptZones?: string[];
  businessHours?: Record<string, string[]> | null;
  customInstructions: string | null;
  assistantName: string | null;
  botTone: string | null;
  botDialect: string | null;
  botGreeting: string | null;
  botNeverSay: string | null;
  autoSendPhotoOnQuote: boolean;
  requirePaymentProof: boolean;
  businessCategory: string | null;
  products: {
    name: string;
    description: string;
    price: string;
    currency: string;
    stock: number;
    category: string | null;
    active: boolean;
    color?: string | null;
    size?: string | null;
    variants?: { color: string | null; size: string | null; stock: number; active: boolean }[];
  }[];
  // `settlement` decide si el pedido se cierra en el acto o queda esperando el comprobante. Estaba sin
  // declarar y Prisma le ponia PREPAID por defecto, asi que en el negocio sembrado "Contraentrega" se
  // comportaba como una transferencia - al reves que en produccion. Una venta contraentrega no se podia
  // probar de punta a punta (2026-09-17).
  paymentMethods: {
    type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO";
    label: string;
    details: string;
    active: boolean;
    settlement?: "PREPAID" | "ON_DELIVERY";
  }[];
  shippingRates: { label: string; cost: string; sortOrder: number }[];
  shippingCityRules: { city: string; label: string }[];
  faqEntries: { question: string; answer: string }[];
}

// El catalogo mexicano vive en su propio archivo a proposito: regression/fixtures/catalog.json es la
// grabacion real que usa scripts/run-regression-suite.ts y no se toca. Y va FUERA de fixtures/, porque
// replay.test.ts trata cada .json de ese directorio como una conversacion.
const catalogs = [...(catalogFixture as CatalogBusiness[]), ...(catalogMxFixture as unknown as CatalogBusiness[])];

export interface SeededBusiness {
  businessId: string;
  personality: BotPersonality;
}

// Crea un negocio NUEVO en cada llamada (email con timestamp+random), a proposito: cada test de
// replay.test.ts debe poder correr en paralelo o repetirse sin pisar el negocio `[REGRESSION]` que deja
// scripts/run-regression-suite.ts, ni el de una corrida anterior de esta misma suite.
export async function seedReplayBusiness(
  catalogName: string,
  opts?: { saleStateEnabled?: boolean; requiredEffectsEnabled?: boolean }
): Promise<SeededBusiness> {
  const fixture = catalogs.find((c) => c.name === catalogName);
  if (!fixture) {
    throw new Error(`No hay catalogo "${catalogName}" en src/ai/regression/fixtures/catalog.json`);
  }

  const email = `replay+${Date.now()}+${Math.random().toString(36).slice(2)}@onix.internal`;
  const business = await prisma.business.create({
    data: {
      name: `[REPLAY] ${fixture.name}`,
      email,
      passwordHash: "replay-only-not-a-real-login",
      active: true,
      contactPhone: "573000000000",
      contactName: "Dueno de prueba",
      saleStateEnabled: opts?.saleStateEnabled ?? false,
      requiredEffectsEnabled: opts?.requiredEffectsEnabled ?? false,
      countryCode: fixture.countryCode ?? "CO",
      currency: fixture.currency ?? "COP",
      timezone: fixture.timezone ?? "America/Bogota",
      requiresIdDocument: fixture.requiresIdDocument ?? true,
      idDocumentExemptZones: fixture.idDocumentExemptZones ?? [],
      businessHours: fixture.businessHours ?? undefined,
      customInstructions: fixture.customInstructions,
      assistantName: fixture.assistantName,
      botTone: fixture.botTone,
      botDialect: fixture.botDialect,
      botGreeting: fixture.botGreeting,
      botNeverSay: fixture.botNeverSay,
      autoSendPhotoOnQuote: fixture.autoSendPhotoOnQuote,
      requirePaymentProof: fixture.requirePaymentProof,
      businessCategory: fixture.businessCategory,
      products: {
        create: fixture.products.map((p) => ({
          name: p.name,
          description: p.description,
          price: p.price,
          currency: p.currency,
          stock: p.stock,
          category: p.category,
          active: p.active,
          color: p.color ?? null,
          size: p.size ?? null,
          variants: p.variants ? { create: p.variants } : undefined,
        })),
      },
      paymentMethods: { create: fixture.paymentMethods },
      shippingRates: { create: fixture.shippingRates },
      shippingCityRules: {
        create: fixture.shippingCityRules.map((r) => ({ city: r.city, normalizedCity: normalizeForMatch(r.city), label: r.label })),
      },
      faqEntries: { create: fixture.faqEntries },
    },
  });

  const shippingRatesConfigured = (await prisma.shippingRate.count({ where: { businessId: business.id } })) > 0;
  const personality: BotPersonality = {
    assistantName: business.assistantName,
    tone: business.botTone,
    dialect: business.botDialect,
    greeting: business.botGreeting,
    neverSay: business.botNeverSay,
    customInstructions: business.customInstructions,
    autoSendPhotoOnQuote: business.autoSendPhotoOnQuote,
    offerPhotosBeforeSending: business.offerPhotosBeforeSending,
    requirePaymentProof: business.requirePaymentProof,
    category: business.businessCategory,
    shippingRatesConfigured,
    saleStateEnabled: business.saleStateEnabled,
    requiredEffectsEnabled: business.requiredEffectsEnabled,
    // Fase 11: mismo dato que arma routes/whatsapp.ts para una conversacion real.
    paymentExamples: formatPaymentExamples(fixture.paymentMethods.filter((m) => m.active).map((m) => m.label)),
  };

  return { businessId: business.id, personality };
}

// Borra el negocio de replay entero (cascada vía FKs). Llamar siempre en un `after` del test, para no
// dejar negocios `[REPLAY]` acumulandose en la base de desarrollo cada corrida.
export async function teardownReplayBusiness(businessId: string): Promise<void> {
  // EL ORDEN ES EL DE LAS LLAVES FORANEAS, y la lista tiene que estar COMPLETA: cualquier tabla que
  // apunte a Customer o a Conversation y no este aca hace que el borrado falle con un 23503 y deje el
  // negocio de prueba a medio borrar. Paso el 2026-09-18 con BillableChat (la facturacion por chats,
  // agregada el 2026-09-17): la fila quedaba viva y el teardown reventaba.
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.agentTurn.deleteMany({ where: { businessId } });
  await prisma.billableChat.deleteMany({ where: { businessId } });
  await prisma.saleState.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.deliveryFailure.deleteMany({ where: { businessId } });
  await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
}
