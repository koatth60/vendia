// Reintentos sin espera real: la escalera de produccion para un 429 es 2s + 8s, y esta prueba solo
// necesita comprobar que reintenta, no cuanto duerme. Se define ANTES de importar la capa, que lee la
// variable al cargarse.
process.env.WHATSAPP_RETRY_BACKOFF_MS = "0";
// Misma razon que arriba: la pausa entre los dos envios de un mensaje partido (Fase 10) no tiene
// por que hacer esperar de verdad a una prueba.
process.env.WHATSAPP_SPLIT_PAUSE_MS = "0";

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  classifyOutboundError,
  computeTypingDelayMs,
  drainOutboundQueue,
  markCustomerMessageSeen,
  sendAlertToOwner,
  sendToCustomer,
  splitLongMessage,
  MAX_QUEUE_ATTEMPTS,
  META_ERROR_CODES,
  GraphApiError,
  type WhatsappCredentials,
} from "./outbound";

// Criterio de aceptacion de la Fase 7 (ONIX-PLAN-MAESTRO.md): "pruebas con fetch mockeado que devuelven
// 131047, 190, 429 y 500: cada una produce la decision correcta y nunca deja al cliente sin mensaje ni
// al dueno sin aviso". Cada caso de abajo comprueba las tres cosas a la vez: que decision se tomo,
// cuantas veces se intento, y que le quedo al cliente y a la duena.

const credentials: WhatsappCredentials = { phoneNumberId: "test-phone-id", accessToken: "test-token" };

let businessId: string;
let customerId: string;
let conversationId: string;
let customerPhone: string;
let originalFetch: typeof fetch;

// Cada llamada al Graph API que hizo la capa, en orden, para poder contar intentos.
let calls: { type: string; to: string; text?: string }[] = [];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Outbound Test ${randomUUID()}`,
      email: `outbound-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      contactPhone: "573000000009",
      contactName: "Owner",
      whatsappPhoneNumberId: "test-phone-id",
      whatsappAccessToken: "test-token",
      followUpTemplateName: "reenganche_generico",
      followUpTemplateLanguage: "es",
    },
  });
  businessId = business.id;
  customerPhone = `573007${Date.now()}`;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: customerPhone, name: "Cliente" } });
  customerId = customer.id;
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.queuedOutboundMessage.deleteMany({ where: { businessId } });
  await prisma.deliveryFailure.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  calls = [];
  await prisma.deliveryFailure.deleteMany({ where: { businessId } });
  await prisma.queuedOutboundMessage.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  // La ventana de 24h se mide contra el ultimo mensaje del cliente: con este, esta abierta.
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: "Hola" } });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Responde como Meta: un error suyo viene con cuerpo JSON { error: { code, message } }, que es lo unico
// estable por lo que se puede ramificar.
function stubFetch(responder: (body: { type: string; to: string }, call: number) => { ok: true } | { status: number; code?: number }) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    const to = parsed.to ?? parsed.recipient ?? "";
    calls.push({ type: parsed.type, to, text: parsed.text?.body });
    const outcome = responder({ type: parsed.type, to }, calls.length);
    if ("ok" in outcome) {
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }) } as Response;
    }
    return {
      ok: false,
      status: outcome.status,
      text: async () => JSON.stringify({ error: { code: outcome.code, message: "Error de prueba de Meta" } }),
    } as Response;
  }) as typeof fetch;
}

function sendText(text = "Mensaje real", overrides: Partial<Parameters<typeof sendToCustomer>[0]> = {}) {
  return sendToCustomer({
    businessId,
    conversationId,
    credentials,
    to: customerPhone,
    content: { kind: "text", text },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Clasificacion: el numero, no el texto
// ---------------------------------------------------------------------------

test("cada codigo de Meta se clasifica por numero y decide solo si se reintenta", () => {
  const cases: [number | null, number, string, boolean][] = [
    [META_ERROR_CODES.WINDOW_CLOSED, 470, "WINDOW_CLOSED", false],
    [META_ERROR_CODES.OPTED_OUT, 400, "OPTED_OUT", false],
    [META_ERROR_CODES.TOKEN_EXPIRED, 401, "TOKEN_EXPIRED", false],
    [META_ERROR_CODES.TEMPLATE_FORMAT, 400, "TEMPLATE_FORMAT", false],
    [130429, 400, "RATE_LIMITED", true],
    [null, 429, "RATE_LIMITED", true],
    [null, 500, "TRANSIENT", true],
    [null, 400, "PERMANENT", false],
  ];
  for (const [code, status, kind, retryable] of cases) {
    const failure = classifyOutboundError(new GraphApiError({ message: "x", status, code }));
    assert.equal(failure.kind, kind, `code=${code} status=${status}`);
    assert.equal(failure.retryable, retryable, `code=${code} status=${status}`);
  }
});

test("un timeout o una caida de red no traen codigo de Meta y se tratan como reintentables", () => {
  const failure = classifyOutboundError(new GraphApiError({ message: "sin respuesta", timedOut: true }));
  assert.equal(failure.kind, "TRANSIENT");
  assert.equal(failure.retryable, true);
});

// ---------------------------------------------------------------------------
// 131047 - ventana cerrada
// ---------------------------------------------------------------------------

test("131047: no se reintenta el texto, sale la plantilla de reenganche y queda el fallo registrado", async () => {
  stubFetch((body) => (body.type === "text" ? { status: 470, code: META_ERROR_CODES.WINDOW_CLOSED } : { ok: true }));

  const result = await sendText();

  assert.equal(result.outcome, "SENT_AS_TEMPLATE");
  assert.equal(result.delivered, true, "el cliente tiene que recibir algo");
  assert.equal(calls.filter((c) => c.type === "text").length, 1, "reintentar el mismo texto fuera de ventana no sirve de nada");
  assert.equal(calls.filter((c) => c.type === "template").length, 1);

  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId } });
  assert.ok(failure, "el mensaje real no llego: la duena tiene que verlo en el panel");
  assert.equal(failure!.errorCode, META_ERROR_CODES.WINDOW_CLOSED);
});

test("131047 con politica de cola: el texto real se guarda para entregarlo cuando el cliente vuelva", async () => {
  stubFetch((body) => (body.type === "text" ? { status: 470, code: META_ERROR_CODES.WINDOW_CLOSED } : { ok: true }));

  const result = await sendText("La respuesta de la duena", { onWindowClosed: "queue", queueOrigin: "OWNER_ANSWER" });

  assert.equal(result.outcome, "QUEUED");
  assert.equal(result.queued, true);
  const queued = await prisma.queuedOutboundMessage.findMany({ where: { businessId } });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].body, "La respuesta de la duena", "el texto real no se pierde");
  assert.equal(queued[0].origin, "OWNER_ANSWER");
});

test("ventana cerrada segun la base: ni se intenta el texto, se va directo a la plantilla", async () => {
  // Sin mensajes del cliente, la ventana esta cerrada y la capa lo sabe ANTES de llamar a Meta - que es
  // el punto: Meta acepta el texto y devuelve un wamid real, y recien avisa horas despues.
  await prisma.message.deleteMany({ where: { conversationId } });
  stubFetch(() => ({ ok: true }));

  const result = await sendText();

  assert.equal(result.outcome, "SENT_AS_TEMPLATE");
  assert.deepEqual(calls.map((c) => c.type), ["template"], "no se manda texto libre fuera de ventana");
});

// ---------------------------------------------------------------------------
// 190 - token vencido
// ---------------------------------------------------------------------------

test("190: no se reintenta, se registra como critico y no se finge que el mensaje salio", async () => {
  stubFetch(() => ({ status: 401, code: META_ERROR_CODES.TOKEN_EXPIRED }));

  const result = await sendText();

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 1, "un token vencido no se arregla reintentando");
  assert.equal(result.failure?.kind, "TOKEN_EXPIRED");

  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId } });
  assert.ok(failure);
  assert.equal(failure!.errorCode, META_ERROR_CODES.TOKEN_EXPIRED);
  assert.equal(failure!.critical, true, "la conexion del negocio esta caida: tiene que saltar arriba en el panel");

  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  assert.ok(business.whatsappConnectionBrokenAt, "un 190 tiene que marcar la conexion como caida para que el panel lo muestre");
});

test("190 avisando al dueno: tampoco se pierde en silencio", async () => {
  stubFetch(() => ({ status: 401, code: META_ERROR_CODES.TOKEN_EXPIRED }));

  const result = await sendAlertToOwner(businessId, credentials, "573000000009", "Un cliente te esta esperando");

  assert.equal(result.delivered, false);
  assert.equal(result.failure?.kind, "TOKEN_EXPIRED");
  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId, recipientPhone: "573000000009" } });
  assert.ok(failure, "un aviso al dueno que no sale tiene que quedar registrado igual");
});

// ---------------------------------------------------------------------------
// 429 - limite de tasa
// ---------------------------------------------------------------------------

test("429: se reintenta y, si el limite cede, el cliente recibe su mensaje", async () => {
  stubFetch((_body, call) => (call === 1 ? { status: 429 } : { ok: true }));

  const result = await sendText();

  assert.equal(result.outcome, "SENT");
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2, "el segundo intento es el que entrega");
  const failures = await prisma.deliveryFailure.count({ where: { businessId } });
  assert.equal(failures, 0, "se entrego: no hay nada que reportarle a la duena");
});

test("429 sostenido: se agotan los intentos y queda registrado, no se pierde", async () => {
  stubFetch((body) => (body.type === "text" ? { status: 429 } : { ok: true }));

  const result = await sendText();

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.attempts, 3);
  assert.equal(result.failure?.kind, "RATE_LIMITED");
  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId } });
  assert.ok(failure, "la duena tiene que enterarse de que ese mensaje no salio");
});

// ---------------------------------------------------------------------------
// 500 - error del lado de Meta
// ---------------------------------------------------------------------------

test("500: se reintenta y el cliente termina recibiendo el mensaje", async () => {
  stubFetch((_body, call) => (call < 3 ? { status: 500 } : { ok: true }));

  const result = await sendText();

  assert.equal(result.outcome, "SENT");
  assert.equal(result.attempts, 3);

  const recorded = await prisma.message.findMany({ where: { conversationId, role: "ASSISTANT" } });
  assert.equal(recorded.length, 0, "sin recordAs la capa no escribe el Message: lo hace quien llama");
});

test("500 sostenido: tras agotar los intentos queda el fallo, nunca un exito falso", async () => {
  stubFetch((body) => (body.type === "text" ? { status: 500 } : { ok: true }));

  const result = await sendText();

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 3);
  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId } });
  assert.ok(failure);
  assert.equal(failure!.critical, false, "un 500 de Meta es transitorio, no una cuenta caida");
});

// ---------------------------------------------------------------------------
// 131050 - el cliente bloqueo al negocio
// ---------------------------------------------------------------------------

test("131050: se deja de insistir de inmediato y se marca como critico", async () => {
  stubFetch(() => ({ status: 400, code: META_ERROR_CODES.OPTED_OUT }));

  const result = await sendText();

  assert.equal(result.outcome, "OPTED_OUT");
  assert.equal(result.attempts, 1, "insistirle a quien bloqueo al negocio es spam");
  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId } });
  assert.equal(failure?.critical, true);
});

// ---------------------------------------------------------------------------
// La cola: un item que falla ya no bloquea a los que siguen
// ---------------------------------------------------------------------------

test("la cola entrega los items siguientes aunque uno se agote, y el agotado deja rastro", async () => {
  const doomed = await prisma.queuedOutboundMessage.create({
    data: { businessId, conversationId, body: "Mensaje que no va a salir", origin: "OWNER_ANSWER", attempts: MAX_QUEUE_ATTEMPTS - 1 },
  });
  const next = await prisma.queuedOutboundMessage.create({
    data: { businessId, conversationId, body: "Mensaje que si tiene que salir", origin: "OWNER_ANSWER" },
  });

  stubFetch((body) => (body.type === "text" && calls.length <= 3 ? { status: 500 } : { ok: true }));

  const tally = await drainOutboundQueue();

  assert.equal(tally.dead, 1);
  assert.equal(tally.sent, 1);

  const deadRow = await prisma.queuedOutboundMessage.findUniqueOrThrow({ where: { id: doomed.id } });
  assert.ok(deadRow.failedAt, "el item agotado se marca, no se reintenta para siempre");
  assert.ok(deadRow.lastError, "y guarda por que se agoto");

  const sentRow = await prisma.queuedOutboundMessage.findUniqueOrThrow({ where: { id: next.id } });
  assert.ok(sentRow.sentAt, "el item que venia detras no queda bloqueado por el anterior");

  const failure = await prisma.deliveryFailure.findFirst({ where: { businessId } });
  assert.ok(failure, "un item agotado siempre genera un DeliveryFailure");
});

test("la cola no gasta intentos mientras la ventana sigue cerrada: solo espera", async () => {
  await prisma.message.deleteMany({ where: { conversationId } });
  const waiting = await prisma.queuedOutboundMessage.create({
    data: { businessId, conversationId, body: "Espera al cliente", origin: "PANEL" },
  });
  stubFetch(() => ({ ok: true }));

  const tally = await drainOutboundQueue();

  assert.equal(tally.waiting, 1);
  assert.equal(calls.length, 0, "no se llama a Meta para algo que no puede entregarse todavia");
  const row = await prisma.queuedOutboundMessage.findUniqueOrThrow({ where: { id: waiting.id } });
  assert.equal(row.attempts, 0, "esperar al cliente no es un intento fallido");
});

test("un fallo transitorio en la cola agenda el proximo intento en vez de rendirse", async () => {
  const item = await prisma.queuedOutboundMessage.create({
    data: { businessId, conversationId, body: "Reintentable", origin: "PANEL" },
  });
  stubFetch(() => ({ status: 500 }));

  const tally = await drainOutboundQueue();

  assert.equal(tally.retry, 1);
  const row = await prisma.queuedOutboundMessage.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(row.attempts, 1);
  assert.equal(row.failedAt, null);
  assert.ok(row.nextAttemptAt.getTime() > Date.now(), "el proximo intento queda agendado a futuro");
});

// ---------------------------------------------------------------------------
// Fase 10 del plan maestro (2026-09-15), eje 19: acuse de recibo, largo del mensaje y ritmo
// ---------------------------------------------------------------------------

test("splitLongMessage deja intacto un texto corto", () => {
  assert.deepEqual(splitLongMessage("Hola, ¿cómo estás?"), ["Hola, ¿cómo estás?"]);
});

test("splitLongMessage parte un texto largo en exactamente dos pedazos, cortando en un espacio", () => {
  const first = "Primera parte. ".repeat(50); // 750 caracteres, todo con espacios
  const second = "Segunda parte.";
  const [chunk1, chunk2] = splitLongMessage(first + second, 700);

  assert.equal(chunk1.length <= 700, true, `el primer pedazo no deberia superar el limite (midio ${chunk1.length})`);
  assert.equal(chunk1.endsWith(" "), false, "no deberia dejar espacio colgando al final");
  assert.equal((chunk1 + " " + chunk2).includes("Segunda parte."), true);
  // Ninguna palabra queda partida a la mitad: el primer caracter del segundo pedazo empieza una
  // palabra nueva, no continua la ultima del primero.
  assert.notEqual(chunk2[0], " ");
});

test("splitLongMessage prefiere cortar en un salto de parrafo antes que en un espacio suelto", () => {
  const text = "A".repeat(300) + "\n\n" + "B".repeat(500);
  const [chunk1, chunk2] = splitLongMessage(text, 700);
  assert.equal(chunk1, "A".repeat(300));
  assert.equal(chunk2, "B".repeat(500));
});

test("splitLongMessage corta duro si no hay ningun espacio (una sola palabra larga)", () => {
  const text = "A".repeat(900);
  const chunks = splitLongMessage(text, 700);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 700);
  assert.equal(chunks[1].length, 200);
});

test("computeTypingDelayMs tiene piso, techo, y crece con el largo del mensaje", () => {
  assert.equal(computeTypingDelayMs(0), 500);
  const short = computeTypingDelayMs(10);
  const long = computeTypingDelayMs(100);
  assert.ok(short < long, "un mensaje mas largo tiene que dar una demora mayor o igual");
  assert.equal(computeTypingDelayMs(5000), 4000, "nunca deberia superar el tope de ~4s");
});

test("markCustomerMessageSeen manda status=read con el indicador de escribiendo", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;

  await markCustomerMessageSeen(credentials, "wamid.XYZ");

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid.XYZ",
    typing_indicator: { type: "text" },
  });
});

test("markCustomerMessageSeen no revienta el turno si Meta rechaza el acuse", async () => {
  globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "{}" })) as unknown as typeof fetch;
  await assert.doesNotReject(() => markCustomerMessageSeen(credentials, "wamid.XYZ"));
});

test("sendToCustomer parte un texto largo en dos envios reales, con una pausa entre ellos, y registra los dos", async () => {
  stubFetch(() => ({ ok: true }));
  const longText = ("Detalle del producto. ".repeat(40) + "Cierre final.").trim(); // > 700 caracteres

  const result = await sendToCustomer({
    businessId,
    conversationId,
    credentials,
    to: customerPhone,
    content: { kind: "text", text: longText },
    recordAs: { text: longText },
  });

  assert.equal(calls.length, 2, "un mensaje largo tiene que salir en dos llamadas al Graph API");
  assert.equal(result.delivered, true);
  assert.equal(result.outcome, "SENT");

  const messages = await prisma.message.findMany({ where: { conversationId, role: "ASSISTANT" }, orderBy: { createdAt: "asc" } });
  assert.equal(messages.length, 2, "los dos pedazos se registran como dos mensajes separados");
});

test("sendToCustomer no manda el segundo pedazo si el primero no se pudo entregar", async () => {
  stubFetch(() => ({ status: 500 }));
  const longText = "Primera parte. ".repeat(50) + "Segunda parte que no deberia salir.";

  const result = await sendToCustomer({
    businessId,
    conversationId,
    credentials,
    to: customerPhone,
    content: { kind: "text", text: longText },
    recordAs: { text: longText },
  });

  assert.equal(result.delivered, false);
  assert.ok(
    calls.every((c) => !c.text?.includes("Segunda parte")),
    "no deberia intentar mandar el segundo pedazo tras agotar los reintentos del primero"
  );
  const messages = await prisma.message.findMany({ where: { conversationId, role: "ASSISTANT" } });
  assert.equal(messages.length, 0, "nada se registra si nada se entrego");
});
