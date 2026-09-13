import { prisma } from "../src/db/client";
import { normalizeForMatch } from "../src/search/text";
import { generateReply } from "../src/ai/agent";
import { recordMessage } from "../src/conversation/service";
import catalogFixture from "../src/ai/regression/fixtures/catalog.json";
import conversationsFixture from "../src/ai/regression/fixtures/conversations.json";

// Replays real historical customer turns (see src/ai/regression/fixtures/README.md) against the CURRENT
// generateReply, using the exact history that really existed at that point in the conversation - not a
// compounding simulation, so results are comparable run to run regardless of what a previous run's
// generated reply happened to say. Fake WhatsApp credentials mean any attempted send hits Meta's real API
// and gets rejected for bad auth - nothing ever reaches a real customer or owner. Not part of `npm test`:
// this hits the real DeepSeek API (real cost, ~1 call per customer turn) and a local dev-only Business it
// creates - run manually before a deploy, not on every commit.
//
// Signal: any console.error a backstop logs when it has to intervene (guardAgainstPaymentHallucination,
// guardAgainstShippingCostHallucination, the catalog/escalation/payment "promised but didn't do it"
// nets) gets captured per turn. Zero interventions across a run is the pass condition; each one printed
// is a concrete regression to look at, tied to the exact real conversation and turn that triggered it.

const FAKE_CREDENTIALS = { phoneNumberId: "regression-fake-phone-id", accessToken: "regression-fake-token" };

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

interface FixtureConversation {
  conversationId: string;
  businessName: string;
  messages: { role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"; content: string; imageAnalysis: string | null }[];
}

async function seedBusiness(fixture: CatalogBusiness) {
  const email = `regression+${fixture.name.toLowerCase().replace(/\W+/g, "-")}@onix.internal`;

  const existing = await prisma.business.findUnique({ where: { email } });
  if (existing) {
    // Fresh reseed every run so results are reproducible regardless of what a prior run left behind. Order
    // first - a real sale replayed in a prior run leaves an Order row FK'd to its Conversation.
    await prisma.message.deleteMany({ where: { conversation: { customer: { businessId: existing.id } } } });
    await prisma.order.deleteMany({ where: { businessId: existing.id } });
    await prisma.conversation.deleteMany({ where: { customer: { businessId: existing.id } } });
    await prisma.customer.deleteMany({ where: { businessId: existing.id } });
    await prisma.product.deleteMany({ where: { businessId: existing.id } });
    await prisma.paymentMethod.deleteMany({ where: { businessId: existing.id } });
    await prisma.shippingCityRule.deleteMany({ where: { businessId: existing.id } });
    await prisma.shippingRate.deleteMany({ where: { businessId: existing.id } });
    await prisma.faqEntry.deleteMany({ where: { businessId: existing.id } });
    await prisma.business.delete({ where: { id: existing.id } });
  }

  const business = await prisma.business.create({
    data: {
      name: `[REGRESSION] ${fixture.name}`,
      email,
      passwordHash: "regression-only-not-a-real-login",
      active: true,
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
      shippingRates: { create: fixture.shippingRates.map((r) => ({ ...r, cost: r.cost })) },
      shippingCityRules: {
        create: fixture.shippingCityRules.map((r) => ({ city: r.city, normalizedCity: normalizeForMatch(r.city), label: r.label })),
      },
      faqEntries: { create: fixture.faqEntries },
    },
  });
  return business;
}

async function replayConversation(businessId: string, fixture: FixtureConversation, log: string[]) {
  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `regression-${fixture.conversationId}`, name: "Cliente Ejemplo" },
  });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });

  const context = {
    businessId,
    conversationId: conversation.id,
    customerId: customer.id,
    credentials: FAKE_CREDENTIALS,
    recipientPhone: customer.phoneNumber,
  };

  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  const personality = {
    assistantName: business.assistantName,
    tone: business.botTone,
    dialect: business.botDialect,
    greeting: business.botGreeting,
    neverSay: business.botNeverSay,
    customInstructions: business.customInstructions,
    autoSendPhotoOnQuote: business.autoSendPhotoOnQuote,
    requirePaymentProof: business.requirePaymentProof,
    category: business.businessCategory,
  };

  let turnsChecked = 0;
  let interventions = 0;

  for (let i = 0; i < fixture.messages.length; i++) {
    const m = fixture.messages[i];
    if (m.role !== "CUSTOMER") continue;

    await recordMessage(businessId, conversation.id, "CUSTOMER", m.content, undefined, undefined, m.imageAnalysis ?? undefined);
    turnsChecked++;

    const captured: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      // Expected noise under fake credentials, not a code regression: any WhatsApp send (the CSAT survey
      // included) fails here because the harness's phoneNumberId/accessToken are deliberately invalid, by
      // design, so nothing ever reaches a real customer or owner. A real regression is a backstop
      // intervention (payment/shipping hallucination, catalog/escalation promise-without-doing), not
      // "the fake token got rejected."
      const first = typeof args[0] === "string" ? args[0] : "";
      if (first.includes("encuesta de satisfaccion")) return;
      captured.push(args);
    };

    let reply = "";
    let threw: unknown = null;
    try {
      reply = await generateReply(conversation.id, context, personality, m.content);
      if (process.env.DEBUG_TOOLCALLS) console.log("[reply]", JSON.stringify(reply));
    } catch (error) {
      threw = error;
    } finally {
      console.error = originalError;
    }

    if (threw) {
      interventions++;
      log.push(`  turn ${i} THREW: ${threw instanceof Error ? threw.message : String(threw)}`);
      log.push(`    customer said: ${m.content.slice(0, 200)}`);
    } else if (captured.length > 0) {
      interventions++;
      log.push(`  turn ${i} backstop fired (${captured.length}x):`);
      log.push(`    customer said: ${m.content.slice(0, 200)}`);
      log.push(`    bot replied:   ${reply.slice(0, 200)}`);
      for (const c of captured) log.push(`    -> ${c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`.slice(0, 300));
    }

    // Feed the REAL historical assistant reply forward as context for the next turn, not the reply just
    // generated - keeps every turn's replay grounded in what actually happened, instead of compounding
    // simulated drift the further a conversation goes.
    const next = fixture.messages[i + 1];
    if (next && next.role === "ASSISTANT") {
      await recordMessage(businessId, conversation.id, "ASSISTANT", next.content, undefined, undefined, next.imageAnalysis ?? undefined);
    }
  }

  return { turnsChecked, interventions };
}

async function main() {
  const limitArg = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  // REGRESSION_IDS=conv-12,conv-34 npm run regression - reruns only those conversationIds while iterating
  // on a fix, instead of the full fixture. Run the full, unfiltered suite once before merging/deploying.
  const idFilter = process.env.REGRESSION_IDS?.split(",").map((s) => s.trim()).filter(Boolean);

  const catalogs = catalogFixture as CatalogBusiness[];
  let conversations = conversationsFixture as FixtureConversation[];
  if (idFilter && idFilter.length > 0) {
    conversations = conversations.filter((c) => idFilter.includes(c.conversationId));
  } else {
    conversations = conversations.slice(0, limitArg);
  }

  const businessByName = new Map<string, string>();
  for (const c of catalogs) {
    const business = await seedBusiness(c);
    businessByName.set(c.name, business.id);
    console.log(`Seeded [REGRESSION] ${c.name} (${business.id})`);
  }

  let totalTurns = 0;
  let totalInterventions = 0;
  const fullLog: string[] = [];

  for (const conv of conversations) {
    const businessId = businessByName.get(conv.businessName);
    if (!businessId) {
      console.log(`Skipping ${conv.conversationId} - no seeded business for "${conv.businessName}"`);
      continue;
    }
    const log: string[] = [];
    const { turnsChecked, interventions } = await replayConversation(businessId, conv, log);
    totalTurns += turnsChecked;
    totalInterventions += interventions;
    const status = interventions === 0 ? "clean" : `${interventions} flagged`;
    console.log(`${conv.conversationId} (${conv.businessName}, ${turnsChecked} turns) - ${status}`);
    if (log.length > 0) {
      fullLog.push(`\n=== ${conv.conversationId} (${conv.businessName}) ===`, ...log);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Conversations replayed: ${conversations.length}`);
  console.log(`Customer turns replayed: ${totalTurns}`);
  console.log(`Turns with a backstop intervention or hard failure: ${totalInterventions}`);
  if (fullLog.length > 0) {
    console.log("\nDetail:");
    console.log(fullLog.join("\n"));
  }
}

main()
  .catch((error) => {
    console.error("Regression suite crashed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
