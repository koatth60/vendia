import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { sendToCustomer } from "./outbound";

// UN CLIENTE SIMULADO NO RECIBE NADA DE META (2026-09-18).
//
// Pedido del dueño: generar conversaciones de prueba y mirarlas desde la Bandeja, con el catálogo y la
// personalidad reales. Lo único que cambia es la última milla. Estas pruebas fijan las dos mitades:
// que el mensaje se GUARDE (si no, no se ve en el panel y la herramienta no sirve) y que NO SE LLAME a
// la API de Meta (si no, un número inventado se convierte en un mensaje a un desconocido).

let businessId: string;
let simuladoId: string;
let realId: string;
let conversacionSimulada: string;
let conversacionReal: string;
let originalFetch: typeof fetch;
let llamadasAMeta: string[];

before(async () => {
  businessId = (
    await prisma.business.create({
      data: { name: `Sim ${randomUUID()}`, email: `sim-${randomUUID()}@example.com`, passwordHash: "x" },
    })
  ).id;
  simuladoId = (
    await prisma.customer.create({ data: { businessId, phoneNumber: `57300000000${1}`, simulated: true } })
  ).id;
  realId = (await prisma.customer.create({ data: { businessId, phoneNumber: `573095${Date.now()}` } })).id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.deliveryFailure.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  conversacionSimulada = (await prisma.conversation.create({ data: { customerId: simuladoId } })).id;
  conversacionReal = (await prisma.conversation.create({ data: { customerId: realId } })).id;
  // La ventana de 24h se mide contra el último mensaje del cliente: sin él, todo envío libre se
  // considera fuera de ventana y no probaríamos nada.
  await prisma.message.create({ data: { conversationId: conversacionSimulada, role: "CUSTOMER", content: "hola" } });
  await prisma.message.create({ data: { conversationId: conversacionReal, role: "CUSTOMER", content: "hola" } });

  llamadasAMeta = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadasAMeta.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.REAL" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
});

const credenciales = { phoneNumberId: "pni-de-prueba", accessToken: "token-de-prueba" };

test("hacia un cliente simulado no se llama a la API de Meta, y el mensaje igual queda guardado", async () => {
  const resultado = await sendToCustomer({
    businessId,
    conversationId: conversacionSimulada,
    credentials: credenciales,
    to: "573000000001",
    content: { kind: "text", text: "Hola, tenemos el Parlante Charge 6 en $70.000" },
    recordAs: { text: "Hola, tenemos el Parlante Charge 6 en $70.000" },
  });

  assert.equal(resultado.delivered, true, "para el resto del sistema el envio salio: si no, el turno se trataria como fallido");
  assert.equal(llamadasAMeta.length, 0, "un numero inventado no puede terminar en un mensaje a un desconocido");
  assert.match(resultado.wamid, /^sim\./, "el wamid dice que fue simulado, para poder distinguirlo despues");

  const guardado = await prisma.message.findFirst({
    where: { conversationId: conversacionSimulada, role: "ASSISTANT" },
    select: { content: true },
  });
  assert.match(guardado!.content, /Parlante Charge 6/, "sin el mensaje guardado no se ve nada en la Bandeja");
});

test("hacia un cliente real se llama a Meta como siempre", async () => {
  // La otra mitad, y la que importa mas: la simulacion no puede haber apagado el envio de verdad.
  const resultado = await sendToCustomer({
    businessId,
    conversationId: conversacionReal,
    credentials: credenciales,
    to: "573001112233",
    content: { kind: "text", text: "Hola" },
    recordAs: { text: "Hola" },
  });

  assert.equal(resultado.delivered, true);
  assert.equal(llamadasAMeta.length, 1);
  assert.match(llamadasAMeta[0], /graph\.facebook\.com/);
  assert.equal(resultado.wamid, "wamid.REAL");
});
