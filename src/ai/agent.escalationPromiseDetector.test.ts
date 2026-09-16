import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import type { ToolContext } from "./tools";

// F1 del diagnostico (ONIX-DIAGNOSTICO-2026-09.md): el modelo dice en prosa "ya le avise al equipo"/
// "voy a consultar con el dueno" sin haber llamado ask_owner - la promesa nunca queda respaldada por
// ninguna PendingOwnerQuestion real. Este detector es deliberadamente SIN EFECTO (no llama ask_owner,
// no toca el texto que ve el cliente): solo registra un AgentIncident con guard
// "escalacion_prometida_sin_herramienta" para poder medir cuanto pasa esto antes de decidir una
// correccion real en una fase futura.

let businessId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test EscalationPromise ${randomUUID()}`, email: `test-escpromise-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573098${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.agentIncident.deleteMany({ where: { businessId } });
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
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

function fakeTextResponse(text: string) {
  return { choices: [{ message: { role: "assistant", content: text, tool_calls: [] } }], usage: undefined };
}

test("records an incident when the model promises to consult the owner without ever calling ask_owner", async () => {
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => fakeTextResponse("Dejame confirmar eso con el equipo y te aviso en un momento.");

  const { text: reply } = await generateReply(conversationId, context, null, "tienen descuento por volumen?");

  assert.match(reply, /confirmar eso con el equipo/, "the detector must never rewrite the model's text");
  const incidents = await prisma.agentIncident.findMany({ where: { conversationId, guard: "escalacion_prometida_sin_herramienta" } });
  assert.equal(incidents.length, 1);
});

test("does not record an incident when the promise is backed by a real ask_owner call this turn", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { contactPhone: "573000000099", contactName: "Dueno" } });
  let callCount = 0;
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) }) as Response) as typeof fetch;
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: `call_${randomUUID()}`,
                  type: "function",
                  function: { name: "ask_owner", arguments: JSON.stringify({ question: "descuento por volumen?" }) },
                },
              ],
            },
          },
        ],
        usage: undefined,
      };
    }
    return fakeTextResponse("Dejame confirmar eso con el equipo y te aviso en un momento.");
  };

  await generateReply(conversationId, context, null, "tienen descuento por volumen?");

  const incidents = await prisma.agentIncident.findMany({ where: { conversationId, guard: "escalacion_prometida_sin_herramienta" } });
  assert.equal(incidents.length, 0);
});

test("does not record an incident when the text has no escalation-promise wording", async () => {
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => fakeTextResponse("Claro, tenemos envio gratis a Bogota.");

  await generateReply(conversationId, context, null, "hacen envios a Bogota?");

  const incidents = await prisma.agentIncident.findMany({ where: { conversationId, guard: "escalacion_prometida_sin_herramienta" } });
  assert.equal(incidents.length, 0);
});
