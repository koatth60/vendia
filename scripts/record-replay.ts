import type OpenAI from "openai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/db/client";
import { recordMessage } from "../src/conversation/service";
import { deepseek } from "../src/ai/client";
import { generateReply } from "../src/ai/agent";
import { seedReplayBusiness, teardownReplayBusiness } from "../src/ai/replay/seed";
import type { ConversationFixture, FixtureModelResponse } from "../src/ai/replay/replay";
import conversationsFixture from "../src/ai/regression/fixtures/conversations.json";

// Fase 1 del plan maestro (2026-09-15). Graba, UNA SOLA VEZ, las respuestas reales del modelo para una
// conversacion anonimizada de src/ai/regression/fixtures/conversations.json contra DeepSeek de verdad,
// y las guarda como un fixture de src/ai/replay/fixtures/ - a partir de ahi replay.test.ts la corre
// gratis para siempre.
//
// CUESTA PLATA REAL (una llamada por iteracion de tool-calling, igual que scripts/run-regression-suite.ts).
// No forma parte de npm test ni de ningun otro script automatico. Correr a mano, una vez por
// conversacion, y solo cuando de verdad haga falta un fixture nuevo o regrabar uno porque el contrato
// de herramientas cambio (Fases 2-5 del plan maestro).
//
// Uso:
//   npx tsx scripts/record-replay.ts <conversationId> <nombre-del-fixture>
//   npx tsx scripts/record-replay.ts cmtp3ww9400066c2kmsfyw2us igmt9z-aurora-sin-config
//
// El nombre de archivo resultante es src/ai/replay/fixtures/<nombre-del-fixture>.json
//
// SALE_STATE_ENABLED=1 antes del comando graba con Business.saleStateEnabled=true (Fase 2+ del plan
// maestro) - usar para regrabar un fixture existente y confirmar que el motor de venta ejecutable de
// verdad cierra el defecto que ese fixture prueba, en vez de solo describirlo en prosa grabada.

interface FixtureConversation {
  conversationId: string;
  businessName: string;
  messages: { role: "CUSTOMER" | "ASSISTANT" | "SYSTEM"; content: string; imageAnalysis: string | null }[];
}

const FAKE_CREDENTIALS = { phoneNumberId: "record-replay-fake-phone-id", accessToken: "record-replay-fake-token" };

async function main() {
  const conversationId = process.argv[2];
  const outName = process.argv[3];
  if (!conversationId || !outName) {
    console.error("Uso: npx tsx scripts/record-replay.ts <conversationId> <nombre-del-fixture>");
    process.exitCode = 1;
    return;
  }

  const source = (conversationsFixture as FixtureConversation[]).find((c) => c.conversationId === conversationId);
  if (!source) {
    console.error(`No se encontro conversationId="${conversationId}" en src/ai/regression/fixtures/conversations.json`);
    process.exitCode = 1;
    return;
  }

  console.log(`Grabando "${source.businessName}" / ${conversationId} contra DeepSeek real. Esto cuesta plata (centavos).`);

  const saleStateEnabled = process.env.SALE_STATE_ENABLED === "1";
  const { businessId, personality } = await seedReplayBusiness(source.businessName, { saleStateEnabled });
  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `record-replay-${conversationId}`, name: "Cliente Ejemplo" },
  });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  const context = {
    businessId,
    conversationId: conversation.id,
    customerId: customer.id,
    credentials: FAKE_CREDENTIALS,
    recipientPhone: customer.phoneNumber,
  };

  const originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  const fixture: ConversationFixture = {
    name: outName,
    seed: { catalogName: source.businessName, ...(saleStateEnabled ? { saleStateEnabled: true } : {}) },
    turns: [],
  };

  try {
    for (let i = 0; i < source.messages.length; i++) {
      const m = source.messages[i];
      if (m.role !== "CUSTOMER") continue;

      await recordMessage(businessId, conversation.id, "CUSTOMER", m.content, undefined, undefined, m.imageAnalysis ?? undefined);

      const recorded: FixtureModelResponse[] = [];
      // @ts-expect-error narrower stub than the real SDK type, same pattern as replay.ts/loopExhaustion test
      deepseek.chat.completions.create = async (params: Parameters<typeof originalCreate>[0]) => {
        const response = await originalCreate(params);
        // El SDK tipa create() como ChatCompletion | Stream<ChatCompletionChunk> porque el mismo metodo
        // sirve para streaming. Onix nunca pide stream, asi que en ejecucion siempre es ChatCompletion:
        // este chequeo lo estrecha para el compilador sin un any suelto, y si algun dia llegara un
        // stream falla ruidoso en vez de grabar un fixture vacio.
        if (!("choices" in response)) {
          throw new Error("record-replay: DeepSeek devolvio un stream; este script solo graba respuestas completas.");
        }
        const message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined = response.choices[0]?.message;
        recorded.push({
          content: message?.content ?? undefined,
          // Mismo estrechamiento que agent.ts:1320: el SDK admite tool calls "custom" que no traen
          // .function, y Onix solo usa las de tipo "function".
          toolCalls: (message?.tool_calls ?? [])
            .filter((tc) => tc.type === "function")
            .map((tc) => ({
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || "{}"),
            })),
        });
        return response;
      };

      console.log(`  turno: "${m.content.slice(0, 60)}"`);
      const { text: reply } = await generateReply(conversation.id, context, personality, m.content);
      await recordMessage(businessId, conversation.id, "ASSISTANT", reply);
      console.log(`    -> ${recorded.length} llamada(s) al modelo, respuesta final: "${reply.slice(0, 80)}"`);

      fixture.turns.push({ customer: m.content, modelResponses: recorded });
    }

    const outPath = join(__dirname, "..", "src", "ai", "replay", "fixtures", `${outName}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
    console.log(`\nGuardado en ${outPath}`);
    console.log("Reviselo a mano y agreguele los bloques \"expect\" antes de confiar en el para npm test.");
  } finally {
    deepseek.chat.completions.create = originalCreate;
    await teardownReplayBusiness(businessId);
  }
}

main()
  .catch((error) => {
    console.error("record-replay crasheo:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
