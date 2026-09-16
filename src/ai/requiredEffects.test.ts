import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import { runCatalogTool, type ToolContext } from "./tools";
import { seedReplayBusiness, teardownReplayBusiness } from "./replay/seed";
import {
  computeRequiredEffects,
  verifyRequiredEffects,
  resetRequiredEffectStats,
  requiredEffectStats,
  FALLBACK_SALE_REGISTERED_TEXT,
  ESCALATION_TEXT,
} from "./requiredEffects";
import type { BotPersonality } from "./prompts/systemPrompt";

// EFECTOS REQUERIDOS. Reproduce el turno de Milena (conversacion cmu3htnp0009y4k2kzxhy9dlz, 2026-09-16):
// la clienta manda la foto del comprobante con la venta ya armada y el modelo NO llama close_conversation
// - escribe "estoy validando tu comprobante" y ya. Todo el mecanismo se prueba sin gastar un peso:
// `deepseek.chat.completions.create` se mockea igual que en agent.loopExhaustion.test.ts, y el fetch a la
// Graph API de WhatsApp tambien (ningun mensaje real sale de aca - ver la regla del repositorio sobre no
// probar nunca con credenciales reales).

let businessId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let personality: BotPersonality;
let originalCreate: typeof deepseek.chat.completions.create;
let originalFetch: typeof fetch;
let ownerSends: { to: string | null; body: string }[];

// Respuesta del modelo SIN tool_calls: el defecto exacto de produccion.
function textOnly(text: string) {
  return {
    model: "deepseek-flash",
    choices: [{ message: { role: "assistant", content: text, tool_calls: [] } }],
    usage: undefined,
  };
}

function withToolCall(name: string, args: Record<string, unknown>) {
  return {
    model: "deepseek-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `call_${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: undefined,
  };
}

/** Programa respuestas del modelo en orden y cuenta cuantas veces se llamo con tool_choice forzado. */
function programModel(responses: unknown[]): { forced: string[]; calls: number } {
  const state = { forced: [] as string[], calls: 0 };
  const queue = [...responses];
  // @ts-expect-error stub de test, forma mas angosta que el tipo real del SDK - mismo patron que
  // agent.loopExhaustion.test.ts y replay.ts.
  deepseek.chat.completions.create = async (params: { tool_choice?: unknown }) => {
    state.calls++;
    const choice = params?.tool_choice;
    if (choice && typeof choice === "object" && "function" in choice) {
      state.forced.push(String((choice as { function: { name: string } }).function.name));
    }
    const next = queue.shift();
    if (!next) throw new Error("El test se quedo sin respuestas del modelo programadas");
    return next;
  };
  return state;
}

// Deja la venta armada en SaleState con producto, precio y forma de pago resueltos - el estado real que
// tenia la conversacion de Milena cuando llego la foto.
async function armSale(): Promise<void> {
  const product = await prisma.product.findFirstOrThrow({
    where: { businessId, active: true, variants: { none: {} } },
    select: { id: true },
  });
  const method = await prisma.paymentMethod.findFirstOrThrow({ where: { businessId, active: true }, select: { id: true } });
  const added = (await runCatalogTool(context, "set_order_item", { productId: product.id, quantity: 1 })) as { ok?: boolean };
  assert.ok(added.ok, "el test necesita un item real en el pedido en curso");
  const paid = (await runCatalogTool(context, "set_payment_method", { paymentMethodId: method.id })) as { ok?: boolean };
  assert.ok(paid.ok, "el test necesita una forma de pago resuelta");
}

async function customerSendsReceiptPhoto(): Promise<void> {
  await prisma.message.create({
    data: { conversationId, role: "CUSTOMER", content: "[Imagen] comprobante de pago", mediaType: "IMAGE", mediaS3Key: `k-${randomUUID()}` },
  });
}

beforeEach(async () => {
  const seeded = await seedReplayBusiness("MAGByLizN", { saleStateEnabled: true, requiredEffectsEnabled: true });
  businessId = seeded.businessId;
  personality = seeded.personality;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `re-${randomUUID()}` } });
  customerId = customer.id;
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
  context = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "test-phone-id", accessToken: "test-token" },
    recipientPhone: customer.phoneNumber,
  };

  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
  originalFetch = globalThis.fetch;
  ownerSends = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    ownerSends.push({ to: body.to ?? null, body: JSON.stringify(body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }),
      text: async () => "{}",
    } as Response;
  }) as typeof fetch;
  resetRequiredEffectStats();
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  globalThis.fetch = originalFetch;
  await teardownReplayBusiness(businessId);
});

test("computeRequiredEffects exige el efecto solo cuando hay foto + venta en curso, bot al mando y sin pedido", async () => {
  // Sin venta en curso todavia: una foto no obliga a nada (es el caso normal de "te mando la foto del
  // producto que quiero").
  await customerSendsReceiptPhoto();
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);

  await armSale();
  const conVenta = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(conVenta.length, 1);
  assert.equal(conVenta[0].kind, "SALE_REGISTERED_AND_OWNER_NOTIFIED");
  assert.equal(conVenta[0].tool, "close_conversation");

  // Un mensaje de texto, con la misma venta armada, no exige nada.
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: null }), []);

  // Bajo control humano tampoco: ahi decide una persona, no el motor.
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: true } });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: false } });

  // Y con el aviso al dueno ya mandado (pendingConfirmationMessageId) el efecto ya ocurrio: no se exige
  // de nuevo. Este es el candado de idempotencia.
  await prisma.conversation.update({ where: { id: conversationId }, data: { pendingConfirmationMessageId: `wamid.${randomUUID()}` } });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);
});

test("la bandera apagada deja el turno exactamente igual que hoy", async () => {
  await armSale();
  await customerSendsReceiptPhoto();
  const model = programModel([textOnly("Estoy validando tu comprobante, dame un momento.")]);

  const reply = await generateReply(conversationId, context, { ...personality, requiredEffectsEnabled: false }, "");

  assert.equal(model.calls, 1, "sin la bandera no hay reintento: una sola llamada al modelo");
  assert.match(reply, /validando/);
  assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  assert.equal(requiredEffectStats.turnsWithRequiredEffects, 0);
});

test("el modelo NO llama la herramienta: el reintento la fuerza y el pedido queda registrado", async () => {
  await armSale();
  await customerSendsReceiptPhoto();
  const model = programModel([
    // Turno de Milena tal cual: texto que promete, cero tool_calls.
    textOnly("Estoy validando tu comprobante y confirmando con el equipo."),
    // Reintento: ahora si llama close_conversation.
    withToolCall("close_conversation", { outcome: "SOLD", summary: "1x producto" }),
    textOnly("Listo, ya le pase tu comprobante al equipo."),
  ]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.deepEqual(model.forced, ["close_conversation"], "el reintento tiene que forzar la herramienta que falta");
  assert.equal(requiredEffectStats.retries, 1);
  assert.equal(requiredEffectStats.retryResolved, 1, "el reintento alcanzo");
  assert.equal(requiredEffectStats.fallbackUsed, 0);
  assert.equal(requiredEffectStats.escalated, 0);

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.ok(conversation.pendingConfirmationMessageId, "el dueno tiene que haber quedado avisado y esperando su respuesta");
  assert.ok(ownerSends.length > 0, "tiene que haber salido un mensaje al dueno");
  assert.notEqual(reply, ESCALATION_TEXT);
});

test("el modelo SI la llama al primer intento: no se reintenta nada", async () => {
  await armSale();
  await customerSendsReceiptPhoto();
  const model = programModel([
    withToolCall("close_conversation", { outcome: "SOLD", summary: "1x producto" }),
    textOnly("Le pase tu comprobante al equipo, apenas confirmen te aviso."),
  ]);

  await generateReply(conversationId, context, personality, "");

  assert.deepEqual(model.forced, [], "no se fuerza nada cuando el efecto ya ocurrio");
  assert.equal(model.calls, 2, "las dos llamadas del turno normal, ni una mas");
  assert.equal(requiredEffectStats.turnsWithRequiredEffects, 1);
  assert.equal(requiredEffectStats.missingAfterFirstAttempt, 0);
  assert.equal(requiredEffectStats.retries, 0);
});

test("ni el reintento ni el fallback lo logran: se escala, y la respuesta no afirma nada", async () => {
  await armSale();
  await customerSendsReceiptPhoto();
  // El dueno nunca recibe el aviso (todo envio a la Graph API falla), asi que close_conversation deja la
  // venta sin pendingConfirmationMessageId y sin Order por mas veces que corra: ni el modelo ni el
  // fallback pueden producir el efecto.
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as unknown as Response) as typeof fetch;
  programModel([
    textOnly("Estoy validando tu comprobante."),
    textOnly("Sigo validando tu comprobante."),
    textOnly("Ya casi, confirmando con el equipo."),
  ]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.equal(reply, ESCALATION_TEXT, "no puede salir un texto que afirme que algo paso");
  assert.equal(requiredEffectStats.retries, 2, "maximo 2 reintentos");
  assert.equal(requiredEffectStats.retryResolved, 0);
  assert.equal(requiredEffectStats.fallbackUsed, 1);
  assert.equal(requiredEffectStats.fallbackResolved, 0);
  assert.equal(requiredEffectStats.escalated, 1);

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.equal(conversation.humanControl, true, "la conversacion queda en manos de una persona");
  const incidente = await prisma.agentIncident.findFirst({ where: { conversationId, guard: "efecto_requerido_sin_cumplir" } });
  assert.ok(incidente, "tiene que quedar el incidente con su guard propio");
});

test("el fallback por codigo registra el pedido cuando el modelo no lo hace ni forzado, con texto fijo nuestro", async () => {
  await armSale();
  await customerSendsReceiptPhoto();
  programModel([
    textOnly("Estoy validando tu comprobante."),
    textOnly("Sigo validando tu comprobante."),
    textOnly("Ya casi, confirmando con el equipo."),
  ]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.equal(requiredEffectStats.retries, 2);
  assert.equal(requiredEffectStats.retryResolved, 0, "forzar tool_choice no basta - es el defecto medido el 2026-09-15");
  assert.equal(requiredEffectStats.fallbackUsed, 1);
  assert.equal(requiredEffectStats.fallbackResolved, 1, "el fallback por codigo si produjo el efecto");
  assert.equal(requiredEffectStats.escalated, 0);
  assert.equal(reply, FALLBACK_SALE_REGISTERED_TEXT, "la respuesta la escribimos nosotros, no el modelo");

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.ok(conversation.pendingConfirmationMessageId, "el dueno quedo avisado");
  assert.deepEqual(await verifyRequiredEffects(conversationId, await computeRequiredEffectsForAssert()), []);
});

// computeRequiredEffects devuelve [] una vez que el efecto ocurrio (el candado de idempotencia), asi que
// para verificar hace falta el efecto declarado a mano.
async function computeRequiredEffectsForAssert() {
  return [{ kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED" as const, tool: "close_conversation", reason: "assert" }];
}

test("dos comprobantes seguidos: un solo pedido y un solo aviso al dueno", async () => {
  await armSale();

  await customerSendsReceiptPhoto();
  programModel([textOnly("Estoy validando tu comprobante."), textOnly("Ok."), textOnly("Ok.")]);
  await generateReply(conversationId, context, personality, "");
  const avisosTrasElPrimero = ownerSends.length;
  const pendienteTrasElPrimero = (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).pendingConfirmationMessageId;
  assert.ok(pendienteTrasElPrimero, "el primer comprobante tiene que dejar el aviso mandado");
  assert.ok(avisosTrasElPrimero > 0);

  // Segunda foto, segundos despues: el candado (d) tiene que impedir que se exija nada de nuevo.
  await customerSendsReceiptPhoto();
  const segundo = programModel([textOnly("Ya lo estoy revisando, apenas me confirmen te aviso.")]);
  await generateReply(conversationId, context, personality, "");

  assert.equal(segundo.calls, 1, "el segundo turno no reintenta nada");
  assert.deepEqual(segundo.forced, []);
  assert.equal(ownerSends.length, avisosTrasElPrimero, "ni un aviso de mas al dueno");
  assert.equal(await prisma.order.count({ where: { conversationId } }), 0, "no se crean dos pedidos");
  assert.equal(
    (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).pendingConfirmationMessageId,
    pendienteTrasElPrimero,
    "sigue siendo el mismo aviso, no uno nuevo"
  );
});
