import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import { runCatalogTool, type ToolContext } from "./tools";
import { recordMediaSent } from "../orders/saleState";
import { seedReplayBusiness, teardownReplayBusiness } from "./replay/seed";
import {
  computeRequiredEffects,
  verifyRequiredEffects,
  resetRequiredEffectStats,
  requiredEffectStats,
  FALLBACK_SALE_REGISTERED_TEXT,
  FALLBACK_IMAGE_RECEIVED_TEXT,
  ESCALATION_TEXT,
} from "./requiredEffects";
import type { BotPersonality } from "./prompts/systemPrompt";

// EFECTOS REQUERIDOS. Reproduce el turno de Milena (conversacion cmu3htnp0009y4k2kzxhy9dlz, 2026-09-16):
// la clienta manda la foto del comprobante y el modelo NO llama ninguna herramienta - escribe "estoy
// validando tu comprobante" y ya. Todo el mecanismo se prueba sin gastar un peso:
// `deepseek.chat.completions.create` se mockea igual que en agent.loopExhaustion.test.ts, y el fetch a la
// Graph API de WhatsApp tambien (ningun mensaje real sale de aca - ver la regla del repositorio sobre no
// probar nunca con credenciales reales).
//
// El caso de aceptacion es "el estado real de Milena" mas abajo: negocio con saleStateEnabled = FALSE,
// SaleState existente pero vacio salvo mediaSent. Ese es el estado que la primera version del disparador
// no detectaba, y por eso prender la bandera en produccion no habria hecho nada.

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

interface ProgrammedModel {
  forced: string[];
  calls: number;
  /** Nombres de las herramientas ofrecidas en cada llamada, y el texto system completo de la primera. */
  toolNamesPerCall: string[][];
  firstSystemText: string;
}

/** Programa respuestas del modelo en orden y registra con que se lo llamo. */
function programModel(responses: unknown[]): ProgrammedModel {
  const state: ProgrammedModel = { forced: [], calls: 0, toolNamesPerCall: [], firstSystemText: "" };
  const queue = [...responses];
  // @ts-expect-error stub de test, forma mas angosta que el tipo real del SDK - mismo patron que
  // agent.loopExhaustion.test.ts y replay.ts.
  deepseek.chat.completions.create = async (params: {
    tool_choice?: unknown;
    tools?: { function: { name: string } }[];
    messages?: { role: string; content?: unknown }[];
  }) => {
    state.calls++;
    state.toolNamesPerCall.push((params?.tools ?? []).map((t) => t.function.name));
    if (state.calls === 1) {
      state.firstSystemText = (params?.messages ?? [])
        .filter((m) => m.role === "system")
        .map((m) => String(m.content ?? ""))
        .join("\n");
    }
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

async function seedFor(opts: { saleStateEnabled: boolean; requiredEffectsEnabled: boolean }): Promise<void> {
  const seeded = await seedReplayBusiness("MAGByLizN", opts);
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
}

// Deja la venta armada en SaleState con producto, precio y forma de pago resueltos. Solo sirve con
// saleStateEnabled: es el motor de venta completo, no el estado que tenia Milena.
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
  businessId = "";
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
  if (businessId) await teardownReplayBusiness(businessId);
});

// ---------------------------------------------------------------------------------------------------
// EL CRITERIO DE ACEPTACION. Estado real de la conversacion de Milena, leido de la base de produccion.
// ---------------------------------------------------------------------------------------------------

test("estado real de Milena (saleStateEnabled=false, solo mediaSent): la duena queda avisada", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });

  // Lo unico que el servidor habia escrito esa noche: la foto del producto salio de verdad por WhatsApp.
  // Se escribe por el camino real (recordMediaSent), no insertando la fila a mano.
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");

  // La fila queda EXACTAMENTE como en produccion: existe pero esta vacia.
  const fila = await prisma.saleState.findUniqueOrThrow({ where: { conversationId } });
  assert.deepEqual(fila.items, []);
  assert.equal(fila.customerName, null);
  assert.equal(fila.paymentMethodId, null);
  assert.equal(fila.address, null);
  assert.deepEqual(fila.mediaSent, ["Reloj Inteligente Serie 11 Mini (Plateado)"]);
  const conversacionAntes = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.equal(conversacionAntes.pendingOrderSummary, null);
  assert.equal(conversacionAntes.pendingOrderItems, null);
  assert.equal(conversacionAntes.pendingConfirmationMessageId, null);
  assert.equal(conversacionAntes.humanControl, false);
  assert.equal(await prisma.order.count({ where: { conversationId } }), 0);

  // El disparador tiene que ver este estado. Si esto falla, el mecanismo sigue muerto.
  const exigidos = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(exigidos.length, 1, "con la foto ya enviada, una imagen entrante TIENE que exigir un efecto");
  assert.equal(exigidos[0].kind, "OWNER_NOTIFIED_ABOUT_IMAGE");
  assert.equal(exigidos[0].tool, "ask_owner_about_photo");

  await customerSendsReceiptPhoto();
  // El turno de Milena tal cual: prosa que promete, cero tool_calls, tres veces.
  const model = programModel([
    textOnly("Estoy validando tu comprobante y confirmando con el equipo."),
    textOnly("Sigo validando tu comprobante."),
    textOnly("Ya casi, confirmando con el equipo."),
  ]);

  const reply = await generateReply(conversationId, context, personality, "");

  // LO QUE IMPORTA: la duena quedo avisada, y esta probado contra la base, no contra el resultado de una
  // funcion.
  const aviso = await prisma.ownerMessageLog.findFirst({ where: { conversationId, direction: "OUT", success: true } });
  assert.ok(aviso, "la duena tiene que quedar avisada");
  assert.match(aviso.body, /IMAGEN/);
  assert.match(aviso.body, /comprobante/i);
  assert.match(aviso.body, /Reloj Inteligente Serie 11 Mini \(Plateado\)/, "el aviso lleva lo que el servidor si sabe");
  assert.match(aviso.body, /NO registro ningun pedido/);
  assert.ok(ownerSends.length > 0, "tiene que haber salido un mensaje de WhatsApp a la duena");

  // Y NO se invento un pedido sobre una imagen ambigua.
  assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).pendingConfirmationMessageId, null);

  assert.deepEqual(model.forced, ["ask_owner_about_photo", "ask_owner_about_photo"], "se fuerza la herramienta del aviso");
  assert.equal(requiredEffectStats.retries, 2);
  assert.equal(requiredEffectStats.retryResolved, 0);
  assert.equal(requiredEffectStats.fallbackUsed, 1);
  assert.equal(requiredEffectStats.fallbackResolved, 1, "el fallback por codigo produjo el efecto");
  assert.equal(requiredEffectStats.escalated, 0);
  assert.equal(reply, FALLBACK_IMAGE_RECEIVED_TEXT, "el texto lo escribimos nosotros, y no afirma que exista un pedido");

  // Condicion de seguridad del despliegue: con saleStateEnabled apagado, el modelo ve exactamente las
  // mismas herramientas y el mismo prompt que hoy.
  for (const nombres of model.toolNamesPerCall) {
    for (const prohibida of ["set_order_item", "set_payment_method", "remove_order_item", "set_shipping_modality"]) {
      assert.ok(!nombres.includes(prohibida), `sin la bandera el modelo no puede ver ${prohibida}`);
    }
  }
  assert.ok(!model.firstSystemText.includes("PEDIDO EN CURSO:"), "sin la bandera no se inyecta el bloque de SaleState");
});

test("el aviso lleva la ciudad y la tarifa que el servidor confirmo, y los datos de entrega guardados", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  // Los dos caminos que ahora espejan hacia SaleState sin depender de la bandera. Se ejecutan por las
  // herramientas reales, no escribiendo la fila a mano.
  const regla = await prisma.shippingCityRule.findFirstOrThrow({ where: { businessId }, select: { city: true } });
  const tarifa = (await runCatalogTool(context, "get_shipping_rate_for_city", { city: regla.city })) as { matched?: boolean };
  assert.equal(tarifa.matched, true, "el test necesita una ciudad con tarifa real configurada");
  await runCatalogTool(context, "save_customer_contact_info", { idNumber: "1023456789", deliveryPhone: "3001234567" });

  await customerSendsReceiptPhoto();
  programModel([textOnly("Estoy validando."), textOnly("Sigo validando."), textOnly("Ya casi.")]);
  await generateReply(conversationId, context, personality, "");

  const aviso = await prisma.ownerMessageLog.findFirstOrThrow({ where: { conversationId, direction: "OUT", success: true } });
  assert.match(aviso.body, new RegExp(`Envio confirmado: ${regla.city}`));
  assert.match(aviso.body, /cedula 1023456789/);
  assert.match(aviso.body, /celular 3001234567/);
});

test("una imagen sin nada que el servidor haya escrito no exige nada", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await customerSendsReceiptPhoto();

  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), [], "sin mediaSent ni items no hay nada que exigir");

  const model = programModel([textOnly("Contame que necesitas y te ayudo.")]);
  await generateReply(conversationId, context, personality, "");

  assert.equal(model.calls, 1, "ni un reintento");
  assert.deepEqual(model.forced, []);
  assert.equal(ownerSends.length, 0, "no se molesta a la duena");
  assert.equal(requiredEffectStats.turnsWithRequiredEffects, 0);
});

test("la bandera apagada deja el turno exactamente igual que hoy", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: false });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();
  const model = programModel([textOnly("Estoy validando tu comprobante, dame un momento.")]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.equal(model.calls, 1, "sin la bandera no hay reintento: una sola llamada al modelo");
  assert.match(reply, /validando/);
  assert.equal(ownerSends.length, 0, "sin la bandera no sale ningun aviso nuevo");
  assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  assert.equal(requiredEffectStats.turnsWithRequiredEffects, 0);
});

test("el modelo SI avisa a la duena por su cuenta: no se reintenta ni se avisa dos veces", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();
  const model = programModel([
    withToolCall("ask_owner_about_photo", {}),
    textOnly("Le pase tu imagen al equipo, apenas me confirmen te aviso."),
  ]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.deepEqual(model.forced, [], "no se fuerza nada cuando el efecto ya ocurrio");
  assert.equal(model.calls, 2, "las dos llamadas del turno normal, ni una mas");
  assert.equal(requiredEffectStats.missingAfterFirstAttempt, 0);
  assert.equal(requiredEffectStats.fallbackUsed, 0);
  assert.equal(reply, "Le pase tu imagen al equipo, apenas me confirmen te aviso.", "la respuesta del modelo se respeta");
  assert.ok(await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId } }), "quedo la pregunta abierta al dueno");
});

test("no se puede avisar a la duena de ninguna forma: se escala y la respuesta no afirma nada", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();
  // Todo envio a la Graph API falla: ni el modelo ni el fallback pueden producir el efecto.
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as unknown as Response) as typeof fetch;
  programModel([textOnly("Estoy validando."), textOnly("Sigo validando."), textOnly("Ya casi.")]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.equal(reply, ESCALATION_TEXT, "no puede salir un texto que afirme que algo paso");
  assert.equal(requiredEffectStats.fallbackUsed, 1);
  assert.equal(requiredEffectStats.fallbackResolved, 0);
  assert.equal(requiredEffectStats.escalated, 1);
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).humanControl, true);
  assert.ok(
    await prisma.agentIncident.findFirst({ where: { conversationId, guard: "efecto_requerido_sin_cumplir" } }),
    "tiene que quedar el incidente con su guard propio"
  );
});

// ---------------------------------------------------------------------------------------------------
// Condiciones del disparador, una por una.
// ---------------------------------------------------------------------------------------------------

test("condiciones del disparador: tipo de medio, control humano y candado de idempotencia", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();

  assert.equal((await computeRequiredEffects(conversationId, { mediaType: "IMAGE" })).length, 1);

  // Un mensaje de texto, con la misma evidencia, no exige nada.
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: null }), []);

  // Bajo control humano tampoco: ahi decide una persona, no el motor.
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: true } });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: false } });

  // Con el aviso de confirmacion ya mandado el efecto ya ocurrio: no se exige de nuevo.
  await prisma.conversation.update({ where: { id: conversationId }, data: { pendingConfirmationMessageId: `wamid.${randomUUID()}` } });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);
});

test("dos imagenes seguidas: se avisa de nuevo, pero nunca se crea un pedido", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");

  await customerSendsReceiptPhoto();
  programModel([textOnly("Estoy validando."), textOnly("Sigo validando."), textOnly("Ya casi.")]);
  await generateReply(conversationId, context, personality, "");
  const avisosTrasLaPrimera = await prisma.ownerMessageLog.count({ where: { conversationId, success: true } });
  assert.equal(avisosTrasLaPrimera, 1, "la primera imagen deja un aviso");

  // Segunda foto, segundos despues. El aviso de la primera ya esta en la base pero es de ANTES de este
  // turno, asi que el corte por `since` lo ignora y el efecto se vuelve a exigir: se avisa de nuevo.
  // Eso es deliberado - el candado (d) solo cubre el pedido creado, y avisar de mas es barato.
  await customerSendsReceiptPhoto();
  const segundo = programModel([textOnly("Ya lo estoy revisando."), textOnly("Sigo revisando."), textOnly("Ya casi.")]);
  await generateReply(conversationId, context, personality, "");

  assert.deepEqual(segundo.forced, ["ask_owner_about_photo", "ask_owner_about_photo"]);
  assert.equal(await prisma.ownerMessageLog.count({ where: { conversationId, success: true } }), 2, "un aviso por imagen");
  assert.equal(await prisma.order.count({ where: { conversationId } }), 0, "en ningun caso se crea un pedido");
});

// ---------------------------------------------------------------------------------------------------
// El otro efecto: con el motor de venta activo y el pedido completo, el cierre real.
// ---------------------------------------------------------------------------------------------------

test("con saleStateEnabled y el pedido completo el efecto exigido es el cierre, no el aviso", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSale();
  await customerSendsReceiptPhoto();

  const exigidos = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(exigidos.length, 1);
  assert.equal(exigidos[0].kind, "SALE_REGISTERED_AND_OWNER_NOTIFIED");
  assert.equal(exigidos[0].tool, "close_conversation");
});

test("con saleStateEnabled pero SIN forma de pago el efecto baja a aviso, no a cierre", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  const product = await prisma.product.findFirstOrThrow({
    where: { businessId, active: true, variants: { none: {} } },
    select: { id: true },
  });
  await runCatalogTool(context, "set_order_item", { productId: product.id, quantity: 1 });
  await customerSendsReceiptPhoto();

  const exigidos = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(exigidos.length, 1);
  assert.equal(exigidos[0].kind, "OWNER_NOTIFIED_ABOUT_IMAGE", "un pedido a medias no habilita crear el pedido solo");
});

test("el reintento cierra la venta cuando el pedido esta completo", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSale();
  await customerSendsReceiptPhoto();
  const model = programModel([
    textOnly("Estoy validando tu comprobante y confirmando con el equipo."),
    withToolCall("close_conversation", { outcome: "SOLD", summary: "1x producto" }),
    textOnly("Listo, ya le pase tu comprobante al equipo."),
  ]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.deepEqual(model.forced, ["close_conversation"]);
  assert.equal(requiredEffectStats.retryResolved, 1);
  assert.equal(requiredEffectStats.fallbackUsed, 0);
  assert.ok(
    (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).pendingConfirmationMessageId,
    "la duena quedo esperando su respuesta"
  );
  assert.notEqual(reply, ESCALATION_TEXT);
});

test("el fallback por codigo registra el pedido cuando el modelo no lo hace ni forzado", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSale();
  await customerSendsReceiptPhoto();
  programModel([textOnly("Estoy validando."), textOnly("Sigo validando."), textOnly("Ya casi.")]);

  const reply = await generateReply(conversationId, context, personality, "");

  assert.equal(requiredEffectStats.retries, 2);
  assert.equal(requiredEffectStats.retryResolved, 0, "forzar tool_choice no basta - es el defecto medido el 2026-09-15");
  assert.equal(requiredEffectStats.fallbackResolved, 1);
  assert.equal(reply, FALLBACK_SALE_REGISTERED_TEXT, "la respuesta la escribimos nosotros, no el modelo");

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.ok(conversation.pendingConfirmationMessageId, "el dueno quedo avisado");
  assert.deepEqual(
    await verifyRequiredEffects(conversationId, [
      { kind: "SALE_REGISTERED_AND_OWNER_NOTIFIED", tool: "close_conversation", reason: "assert", since: new Date(0) },
    ]),
    []
  );
});
