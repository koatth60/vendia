import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { handleOwnerReply } from "./whatsapp";
import { runCatalogTool, type ToolContext } from "../ai/tools";
import { getAgreedPrices, agreedKey } from "../orders/agreedPrices";
import type { WhatsappCredentials } from "../whatsapp/outbound";

// EL PRECIO ACORDADO (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 12), de punta a punta y contra la base de
// verdad: el agente abre la pregunta con las ranuras adentro, la duena responde por WhatsApp, y recien
// con su confirmacion explicita el precio existe.
//
// EL CASO REAL que reproduce esto: conversacion cmu4gykpm003le82keve7ngck, negocio MAGByLizN,
// 2026-09-16. La clienta pidio descuento por dos productos, la duena escribio los precios en el chat, y
// el agente le cobro los de catalogo dos veces seguidas porque un precio acordado no existia en la base.

let businessId: string;
let credentials: WhatsappCredentials;
let airpodsId: string;
let alexaId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let originalFetch: typeof fetch;
let ownerMessages: string[];
let customerMessages: string[];
const OWNER_PHONE = "573000000091";
let customerPhone: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: OWNER_PHONE,
      contactName: "Liz",
    },
  });
  businessId = business.id;
  credentials = { phoneNumberId: "test-id", accessToken: "test-token" };
  airpodsId = (
    await prisma.product.create({
      data: { businessId, name: `AIRPODS PRO 3 ${randomUUID()}`, description: "Audifonos", price: 75000, currency: "COP", stock: 5 },
    })
  ).id;
  alexaId = (
    await prisma.product.create({
      data: { businessId, name: `PARLANTE TIPO ALEXA ${randomUUID()}`, description: "Parlante", price: 70000, currency: "COP", stock: 5 },
    })
  ).id;
});

after(async () => {
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.productMedia.deleteMany({ where: { product: { businessId } } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  customerPhone = `57300${Date.now()}${Math.floor(Math.random() * 1000)}`;
  customerId = (await prisma.customer.create({ data: { businessId, phoneNumber: customerPhone, name: "Mary" } })).id;
  conversationId = (await prisma.conversation.create({ data: { customerId } })).id;
  // La ventana de 24h se mide contra el ultimo mensaje del cliente; sin el, nada sale para el cliente.
  await prisma.message.create({
    data: { conversationId, role: "CUSTOMER", content: "Y depronto tiene algún descuento para los dos" },
  });
  context = {
    businessId,
    conversationId,
    customerId,
    credentials,
    recipientPhone: customerPhone,
  };
  originalFetch = globalThis.fetch;
  ownerMessages = [];
  customerMessages = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    // La primera alerta al dueno sale como PLANTILLA aprobada (sendOwnerAlert), no como texto: su cuerpo
    // viaja en los parametros y con los saltos de linea colapsados. Las respuestas del servidor
    // (repreguntas, propuesta, confirmacion) si son texto plano.
    const text =
      body.text?.body ?? body.template?.components?.[0]?.parameters?.[0]?.text ?? "";
    if (!text) return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
    if (body.to === OWNER_PHONE) ownerMessages.push(text);
    else customerMessages.push(text);
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function askOwnerAboutPrice() {
  const result = (await runCatalogTool(context, "ask_owner_about_price", {
    items: [
      { productName: "AIRPODS PRO 3", quantity: 1 },
      { productName: "PARLANTE TIPO ALEXA", quantity: 1 },
    ],
  })) as { asked?: boolean };
  assert.equal(result.asked, true, "ask_owner_about_price deberia haber escalado la consulta");
  const pending = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });
  assert.equal(pending.kind, "PRICE");
  return pending;
}

async function ownerSays(text: string, quotedWamid: string) {
  await handleOwnerReply(businessId, credentials, OWNER_PHONE, {
    type: "text",
    text: { body: text },
    context: { id: quotedWamid },
  });
}

test("la pregunta que sale lleva los items exactos y sus precios de hoy, escritos por el servidor", async () => {
  const pending = await askOwnerAboutPrice();
  const pregunta = ownerMessages[0] ?? "";
  assert.ok(pregunta.includes("AIRPODS PRO 3"), `la pregunta no nombra el producto: ${pregunta}`);
  assert.ok(pregunta.includes("$75.000"), `la pregunta no trae el precio real: ${pregunta}`);
  assert.ok(pregunta.includes("$70.000"), `la pregunta no trae el segundo precio real: ${pregunta}`);
  const slots = (pending.payload as { items: { productId: string; unitPrice: number }[] }).items;
  assert.deepEqual(
    slots.map((s) => s.unitPrice),
    [75000, 70000]
  );
  // Nada escrito todavia: preguntar no es acordar.
  assert.equal((await getAgreedPrices(conversationId)).size, 0);
});

// (d) del pedido: una respuesta ambigua NO escribe nada y vuelve a preguntar. Es el mensaje literal de la
// duena del caso real - trae un precio de combo y dos unitarios, cuatro numeros para dos ranuras.
test("una respuesta ambigua de la duena no escribe ningun precio y el servidor vuelve a preguntar", async () => {
  const pending = await askOwnerAboutPrice();
  await ownerSays("Te dejaría los dos en 135 mil / Pro 3 70 / Alexa $65", pending.wamid);

  assert.equal((await getAgreedPrices(conversationId)).size, 0, "no se puede escribir un precio de una respuesta ambigua");
  const repregunta = ownerMessages[ownerMessages.length - 1] ?? "";
  assert.ok(repregunta.includes("No guardé nada"), `no avisó que no guardó nada: ${repregunta}`);
  assert.ok(repregunta.includes("4 números"), `no dijo cuántos números encontró: ${repregunta}`);
  assert.ok(repregunta.includes("$75.000"), `la repregunta no vuelve a traer los precios reales: ${repregunta}`);
  // La pregunta sigue abierta, y ahora se cita el mensaje nuevo.
  const sigueAbierta = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });
  assert.notEqual(sigueAbierta.wamid, pending.wamid);
  assert.equal(customerMessages.length, 0, "al cliente no se le dice nada mientras no haya precio");
});

// (c) del pedido: un precio mayor al del catalogo se rechaza. Lo valida el servidor, en codigo.
test("un precio mayor al del catalogo se rechaza y no se escribe nada", async () => {
  const pending = await askOwnerAboutPrice();
  await ownerSays("80000, 65000", pending.wamid);

  assert.equal((await getAgreedPrices(conversationId)).size, 0);
  const rechazo = ownerMessages[ownerMessages.length - 1] ?? "";
  assert.ok(rechazo.includes("no puede ser mayor"), `no explicó el rechazo: ${rechazo}`);
  assert.ok(rechazo.includes("AIRPODS PRO 3"), `no dijo cuál precio estaba mal: ${rechazo}`);
  assert.equal(await prisma.pendingOwnerQuestion.count({ where: { conversationId } }), 1);
});

test("los numeros resueltos son una PROPUESTA: sin confirmacion no hay precio acordado", async () => {
  const pending = await askOwnerAboutPrice();
  await ownerSays("70000, 65000", pending.wamid);

  const propuesta = ownerMessages[ownerMessages.length - 1] ?? "";
  assert.ok(propuesta.includes("¿Confirmás"), `no devolvió la propuesta para confirmar: ${propuesta}`);
  assert.ok(propuesta.includes("$70.000") && propuesta.includes("$65.000"), propuesta);
  assert.equal((await getAgreedPrices(conversationId)).size, 0, "la propuesta no es un precio vigente");
  assert.equal(customerMessages.length, 0);

  // Y si la duena dice que no, se borra la propuesta y se vuelve al formulario en blanco.
  const conPropuesta = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });
  await ownerSays("no", conPropuesta.wamid);
  assert.equal((await getAgreedPrices(conversationId)).size, 0);
  const limpia = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });
  assert.equal((limpia.payload as { propuesta?: unknown }).propuesta, undefined);
});

// (a) del pedido, primera mitad: el camino completo del caso real. La duena responde ambiguo, el servidor
// vuelve a preguntar, responde con el formato pedido, confirma, y recien ahi el precio existe en la base.
// La segunda mitad (que esos precios lleguen al resumen) vive en src/ai/agent.agreedPrice.test.ts.
test("el caso real, de punta a punta: los precios de la duena quedan escritos tras su confirmacion", async () => {
  const pending = await askOwnerAboutPrice();

  await ownerSays("Te dejaría los dos en 135 mil / Pro 3 70 / Alexa $65", pending.wamid);
  const trasAmbigua = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });

  await ownerSays("70000, 65000", trasAmbigua.wamid);
  const conPropuesta = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });

  await ownerSays("si", conPropuesta.wamid);

  const acordados = await getAgreedPrices(conversationId);
  assert.equal(acordados.get(agreedKey(airpodsId, null))?.unitPrice, 70000);
  assert.equal(acordados.get(agreedKey(alexaId, null))?.unitPrice, 65000);
  assert.equal(await prisma.pendingOwnerQuestion.count({ where: { conversationId } }), 0, "la pregunta queda resuelta");

  // El aviso al cliente lo compone el SERVIDOR con las cifras que acaba de escribir: el fallback sin
  // modelo adentro, que es lo que hace de esto una garantia y no una mitigacion.
  const aviso = customerMessages[customerMessages.length - 1] ?? "";
  assert.ok(aviso.includes("$70.000"), `el cliente no recibió el precio acordado: ${aviso}`);
  assert.ok(aviso.includes("$65.000"), aviso);
});

test("la fuente del precio queda registrada como respuesta de la duena, nunca como otra cosa", async () => {
  const pending = await askOwnerAboutPrice();
  await ownerSays("70000, 65000", pending.wamid);
  const conPropuesta = await prisma.pendingOwnerQuestion.findFirstOrThrow({ where: { conversationId } });
  await ownerSays("si", conPropuesta.wamid);
  const filas = await prisma.agreedPrice.findMany({ where: { conversationId } });
  assert.equal(filas.length, 2);
  assert.ok(filas.every((f) => f.source === "OWNER_REPLY"));
});
