import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import type { ToolContext } from "./tools";

// Pieza 6 del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 3): el caso real de
// produccion, contra generateReply de verdad, con el modelo mockeado (cero red a DeepSeek, cero costo).
//
// Lo que se fija aca es que el estado comercial del CLIENTE llegue al contexto del turno como dato, leido
// de la base antes de la primera llamada al modelo: un pedido abierto en la conversacion A tiene que
// existir para el agente cuando el cliente escribe desde la conversacion B. El recorte y el formato se
// prueban puros en src/orders/customerCommerceState.test.ts.

let businessId: string;
let customerId: string;
let conversationA: string;
let conversationB: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;
let originalFetch: typeof fetch;
let capturedMessages: { role: string; content: unknown }[][] = [];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000021",
      contactName: "Owner",
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573097${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.agentTurn.deleteMany({ where: { businessId } });
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  conversationA = (await prisma.conversation.create({ data: { customerId } })).id;
  conversationB = (await prisma.conversation.create({ data: { customerId } })).id;
  context = {
    businessId,
    conversationId: conversationB,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573001112244",
  };
  capturedMessages = [];
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }),
      text: async () => "{}",
    }) as Response) as typeof fetch;
  // @ts-expect-error test stub, narrower shape than the real SDK type - mismo patron que agent.catalogScope.test.ts.
  deepseek.chat.completions.create = async (params: { messages: { role: string; content: unknown }[] }) => {
    capturedMessages.push(params.messages);
    return {
      choices: [{ message: { role: "assistant", content: "Dejame ver eso 😊", tool_calls: [] } }],
      usage: undefined,
    };
  };
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  globalThis.fetch = originalFetch;
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.agentTurn.deleteMany({ where: { conversationId: { in: [conversationA, conversationB] } } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
});

function orderBlock(): string | null {
  for (const messages of capturedMessages) {
    for (const m of messages) {
      if (m.role === "system" && typeof m.content === "string" && m.content.startsWith("PEDIDOS DE ESTE CLIENTE")) {
        return m.content;
      }
    }
  }
  return null;
}

test("caso real: el pedido abierto en la conversacion A existe para el agente en la conversacion B", async () => {
  // Produccion 2026-09-15 (y otra vez el 2026-09-16 con Laura Manjarrez): la clienta pidio cancelar desde
  // una conversacion distinta de la que tenia el pedido, y para el modelo ese pedido no existia.
  await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: conversationA,
      summary: "1x PARLANTE TIPO ALEXA",
      totalAmount: 80000,
      currency: "COP",
    },
  });

  await generateReply(conversationB, context, null, "quiero cancelar mi pedido");

  const bloque = orderBlock();
  assert.ok(bloque, "el estado de pedidos del cliente tiene que llegar al contexto del turno");
  assert.ok(bloque!.includes("PARLANTE TIPO ALEXA"), `el pedido de la otra conversacion: ${bloque}`);
  assert.ok(bloque!.includes('"estado":"pendiente"'), bloque!);
  assert.ok(bloque!.includes('"enEstaConversacion":false'), "y viene marcado como de otra conversacion");
});

test("el dato entra sin que el cliente nombre el pedido: el disparador es la base, no lo que escribio", async () => {
  // La regla de admision de efectos requeridos (seccion 6 del plan): el disparador se calcula de la base,
  // nunca de interpretar la prosa del cliente. Sin deteccion de intencion, sin palabra clave.
  await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: conversationA,
      summary: "1x AIRPODS SERIE 4",
      totalAmount: 65000,
      currency: "COP",
    },
  });

  await generateReply(conversationB, context, null, "hola, buenos dias");

  const bloque = orderBlock();
  assert.ok(bloque, "un saludo tambien trae el estado: no depende de lo que diga el cliente");
  assert.ok(bloque!.includes("AIRPODS SERIE 4"), bloque!);
});

test("un cliente sin pedidos no agrega ningun mensaje al turno", async () => {
  await generateReply(conversationB, context, null, "hola");
  assert.equal(orderBlock(), null, "sin pedidos no se paga un solo token");
});
