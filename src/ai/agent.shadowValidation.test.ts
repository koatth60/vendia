import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import { parseFinding } from "../catalog/outputValidation";
import type { ToolContext } from "./tools";

// Pieza 5 del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md), MODO SOMBRA.
//
// Esta es la prueba que importa de esta fase: con la validacion corriendo, el texto que recibe el
// cliente es EXACTAMENTE el mismo que sin ella, byte por byte, incluso cuando la validacion marca todo
// lo que hay para marcar. El hallazgo queda en AgentTurn.shadowFindings y en ningun otro lado.
//
// Gratis y determinista: se mockea deepseek.chat.completions.create (mismo patron que
// agent.loopExhaustion.test.ts) y el fetch a la Graph API. Cero llamadas reales a DeepSeek o WhatsApp.
//
// El caso replica el defecto real de produccion del 2026-09-15 (conversacion cmu0ehwqx00076k2k64mjaats):
// un turno con CERO llamadas a herramientas en el que el modelo invento una categoria entera de
// cargadores. El negocio sembrado tiene un solo producto.

let businessId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;
let originalFetch: typeof fetch;

// Tal cual salio en produccion. Que el bot escriba esto es el defecto; que el cliente lo reciba igual
// durante la fase de sombra es la decision, y es lo que esta prueba fija.
const RESPUESTA_INVENTADA = [
  "¡Claro! Estos son nuestros cargadores:",
  "",
  "1. *Cargador iPhone* — $60.000",
  "2. *Cargador Tipo C* — $50.000",
  "3. *Base de Carga Inalámbrica 3 en 1* — $90.000",
  "",
  "¿Cuál te interesa?",
].join("\n");

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test sombra ${randomUUID()}`,
      email: `shadow-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000009",
      contactName: "Owner",
      products: {
        create: [
          {
            name: "Batería portátil power bank 12000 mah",
            description: "Batería portátil de 12000 mah",
            price: "70000",
            currency: "COP",
            stock: 4,
            category: "Tecnología (cargadores)",
            active: true,
          },
        ],
      },
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573099${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.agentTurn.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.product.deleteMany({ where: { businessId } });
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
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) }) as Response) as typeof fetch;
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  globalThis.fetch = originalFetch;
  await prisma.agentTurn.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

function respuestaSinHerramientas(text: string) {
  return { choices: [{ message: { role: "assistant", content: text, tool_calls: [] } }], usage: undefined };
}

async function turnoRegistrado() {
  return prisma.agentTurn.findFirstOrThrow({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { scope: true, toolsCalled: true, shadowFindings: true },
  });
}

test("el cliente recibe el texto inventado sin tocar, y el hallazgo queda registrado aparte", async () => {
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => respuestaSinHerramientas(RESPUESTA_INVENTADA);

  const { text, blocks } = await generateReply(conversationId, context, null, "hola, me recomiendas algo?");

  // LA PRUEBA IMPORTANTE. Byte por byte lo que escribio el modelo: la validacion no borra la lista, no
  // corrige el precio, no agrega una retractacion y no reemplaza la respuesta.
  assert.equal(text, RESPUESTA_INVENTADA);
  assert.equal(blocks.length, 0, "este mensaje del cliente no resuelve alcance: no hay bloques del servidor");

  const turno = await turnoRegistrado();
  assert.equal(turno.scope, "none", "el turno tiene que ser de los que la Fase B no cubre");
  assert.equal(turno.toolsCalled.length, 0, "el defecto real ocurrio en un turno sin llamadas a herramientas");

  const findings = turno.shadowFindings.map(parseFinding).filter((f) => f !== null);
  const precios = findings.filter((f) => f?.kind === "precio_inexistente").map((f) => f?.value);
  const nombres = findings.filter((f) => f?.kind === "producto_inexistente").map((f) => f?.value);
  assert.deepEqual(precios.sort(), ["$50.000", "$60.000", "$90.000"]);
  assert.deepEqual(nombres.sort(), ["Base de Carga Inalámbrica 3 en 1", "Cargador Tipo C", "Cargador iPhone"]);
});

test("una respuesta con el precio real del unico producto del catalogo no marca nada", async () => {
  const respuestaCorrecta = "Tengo este:\n\n1. *Batería portátil power bank 12000 mah* — $70.000";
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => respuestaSinHerramientas(respuestaCorrecta);

  const { text } = await generateReply(conversationId, context, null, "hola, me recomiendas algo?");

  assert.equal(text, respuestaCorrecta);
  assert.deepEqual((await turnoRegistrado()).shadowFindings, []);
});

test("una respuesta sin listas ni precios no marca nada", async () => {
  const saludo = "¡Hola! Con gusto te ayudo. ¿Para qué ciudad sería el envío?";
  // @ts-expect-error test stub, narrower shape than the real SDK type
  deepseek.chat.completions.create = async () => respuestaSinHerramientas(saludo);

  const { text } = await generateReply(conversationId, context, null, "hola");

  assert.equal(text, saludo);
  assert.deepEqual((await turnoRegistrado()).shadowFindings, []);
});
