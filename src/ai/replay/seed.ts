import { prisma } from "../../db/client";
import { normalizeForMatch } from "../../search/text";
import type { BotPersonality } from "../prompts/systemPrompt";
import catalogFixture from "../regression/fixtures/catalog.json";

// Fase 1 del plan maestro (2026-09-15): reusa el mismo catalogo real que ya usa
// scripts/run-regression-suite.ts (src/ai/regression/fixtures/catalog.json), en vez de mantener una
// segunda copia de Aurora Joyas / MAGByLizN que se desincroniza con el original. Un fixture de replay
// referencia el negocio por nombre ("Aurora Joyas", "MAGByLizN") y consigue el catalogo real con el
// que la conversacion original paso.
interface CatalogBusiness {
  name: string;
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
  paymentMethods: { type: "TRANSFERENCIA" | "TARJETA" | "EFECTIVO"; label: string; details: string; active: boolean }[];
  shippingRates: { label: string; cost: string; sortOrder: number }[];
  shippingCityRules: { city: string; label: string }[];
  faqEntries: { question: string; answer: string }[];
}

const catalogs = catalogFixture as CatalogBusiness[];

export interface SeededBusiness {
  businessId: string;
  personality: BotPersonality;
}

// Crea un negocio NUEVO en cada llamada (email con timestamp+random), a proposito: cada test de
// replay.test.ts debe poder correr en paralelo o repetirse sin pisar el negocio `[REGRESSION]` que deja
// scripts/run-regression-suite.ts, ni el de una corrida anterior de esta misma suite.
export async function seedReplayBusiness(catalogName: string, opts?: { saleStateEnabled?: boolean }): Promise<SeededBusiness> {
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
  };

  return { businessId: business.id, personality };
}

// Borra el negocio de replay entero (cascada vía FKs). Llamar siempre en un `after` del test, para no
// dejar negocios `[REPLAY]` acumulandose en la base de desarrollo cada corrida.
export async function teardownReplayBusiness(businessId: string): Promise<void> {
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
}
