import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import type { ToolContext } from "./tools";

// Fase C of the 2026-09-13 audit (F2): the tool-calling loop caps at 5 iterations
// (agent.ts, `for (let iteration = 0; iteration < 5; iteration++)`). If the model still wants to call
// tools on the 5th one, the loop used to just return `lastText` raw - often literally the intermediate
// "dame un momento, reviso el catalogo" text the model wrote ALONGSIDE a tool call, never a real answer,
// and invisible in production (no log at all). Free to test: mock `deepseek.chat.completions.create`
// directly (a plain mutable OpenAI client instance, see ai/client.ts) instead of hitting DeepSeek for
// real - no cost, no `*Paid.ts` needed.

let businessId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;
let originalFetch: typeof fetch;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000009",
      contactName: "Owner",
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573099${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
  context = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573001112233",
  };
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  globalThis.fetch = originalFetch;
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

function fakeToolCallResponse(text: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
          tool_calls: [
            { id: `call_${randomUUID()}`, type: "function", function: { name: "get_payment_methods", arguments: "{}" } },
          ],
        },
      },
    ],
    usage: undefined,
  };
}

function fakeFinalResponse(text: string | null) {
  return { choices: [{ message: { role: "assistant", content: text, tool_calls: [] } }], usage: undefined };
}

test("generateReply asks for a real final answer instead of returning the dangling intermediate promise when the loop exhausts", async () => {
  let callCount = 0;
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => {
    callCount++;
    if (callCount <= 5) return fakeToolCallResponse("Dame un momento, reviso el catalogo...");
    return fakeFinalResponse("Tenemos envio gratis a Bogota y pago contraentrega.");
  };

  const reply = await generateReply(conversationId, context, null, "que formas de pago tienen?");

  assert.equal(callCount, 6, "must make exactly one extra untooled call after the 5 tool-calling iterations");
  assert.match(reply, /envio gratis a Bogota/);
  assert.doesNotMatch(reply, /Dame un momento/, "must not surface the dangling intermediate promise");
});

test("generateReply alerts the owner when the loop exhausts and even the final untooled call comes back empty", async () => {
  const sentToOwner: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "template") {
      sentToOwner.push(body.template?.components?.[0]?.parameters?.[0]?.text ?? "");
    } else if (body.type === "text") {
      sentToOwner.push(body.text?.body ?? "");
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;

  let callCount = 0;
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => {
    callCount++;
    if (callCount <= 5) return fakeToolCallResponse("");
    return fakeFinalResponse(null);
  };

  const reply = await generateReply(conversationId, context, null, "que formas de pago tienen?");

  assert.equal(reply, "Disculpa, tuve un problema procesando tu consulta. Un asesor te va a contactar pronto.");
  assert.ok(
    sentToOwner.some((t) => /respuesta generica/i.test(t)),
    "owner must be alerted that the customer got a degraded reply"
  );
});
