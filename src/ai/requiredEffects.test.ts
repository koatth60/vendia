import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply } from "./agent";
import { runCatalogTool, type ToolContext } from "./tools";
import { recordMediaSent, getSaleState } from "../orders/saleState";
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
import { getAgentAuthorshipSummary } from "./agentTurns";
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
  // Una forma de pago PREPAGA, explicita: estas pruebas son las del comprobante, y con contraentrega no
  // hay comprobante que mandar. Antes tomaba "la primera activa", que es un orden que el fixture puede
  // cambiar sin que nadie se entere.
  const method = await prisma.paymentMethod.findFirstOrThrow({
    where: { businessId, active: true, settlement: "PREPAID" },
    select: { id: true },
  });
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

  await customerSendsReceiptPhoto();

  // El disparador tiene que ver este estado. Si esto falla, el mecanismo sigue muerto.
  // Desde el 2026-09-17 el disparador es la FILA de la imagen sin atender, no el tipo del ultimo mensaje,
  // asi que la foto tiene que existir antes de preguntar - que es tambien el orden real de produccion.
  const exigidos = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(exigidos.length, 1, "con la foto ya enviada, una imagen entrante TIENE que exigir un efecto");
  assert.equal(exigidos[0].kind, "OWNER_NOTIFIED_ABOUT_IMAGE");
  assert.equal(exigidos[0].tool, "ask_owner_about_photo");
  // El turno de Milena tal cual: prosa que promete, cero tool_calls, tres veces.
  const model = programModel([
    textOnly("Estoy validando tu comprobante y confirmando con el equipo."),
    textOnly("Sigo validando tu comprobante."),
    textOnly("Ya casi, confirmando con el equipo."),
  ]);

  const { text: reply } = await generateReply(conversationId, context, personality, "");

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

  const { text: reply } = await generateReply(conversationId, context, personality, "");

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

  const { text: reply } = await generateReply(conversationId, context, personality, "");

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

  const { text: reply } = await generateReply(conversationId, context, personality, "");

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

  // F1, 2026-09-17: un mensaje de TEXTO despues de la imagen ya no apaga el efecto. Ese era el agujero -
  // la clienta mandaba el comprobante, escribia "te envie lo del envio de paso", y como el ultimo mensaje
  // era texto no se exigia nada: el bot decia "estoy validando con el equipo" sin que se abriera nada.
  assert.equal((await computeRequiredEffects(conversationId, { mediaType: null })).length, 1);

  // Sin ninguna imagen del cliente no hay nada que atender, cualquiera sea el tipo del ultimo mensaje.
  await prisma.message.deleteMany({ where: { conversationId, mediaType: "IMAGE" } });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);
  await customerSendsReceiptPhoto();

  // Bajo control humano tampoco: ahi decide una persona, no el motor.
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: true } });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: false } });

  // Con el aviso de confirmacion ya mandado el efecto ya ocurrio: no se exige de nuevo.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingConfirmationAskedAt: new Date(), pendingConfirmationMessageId: `wamid.${randomUUID()}` },
  });
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: "IMAGE" }), []);

  // Y el candado es `pendingConfirmationAskedAt`, no el wamid (2026-09-16): cuando los tres escalones de
  // envio al dueno fallan no hay wamid y la confirmacion existe igual - sin esto, cada imagen nueva
  // volveria a disparar el efecto sobre una venta que ya esta esperando respuesta.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingConfirmationMessageId: null },
  });
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

  const { text: reply } = await generateReply(conversationId, context, personality, "");

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

  const { text: reply } = await generateReply(conversationId, context, personality, "");

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

// ---------------------------------------------------------------------------------------------------
// LA VENTA LISTA QUE NADIE REGISTRA (2026-09-17, etapa E09). El segundo disparador: sin foto de por
// medio. Medido sobre 14 dias de produccion: 22 pedidos creados, close_conversation llamada en 2
// turnos. Las otras 20 las cerro la duena a mano. El caso es Carlos Mendoza, contraentrega: no hay
// comprobante, asi que el disparador de la imagen no podia salvarlo.
// ---------------------------------------------------------------------------------------------------

/** Deja el checkout COMPLETO: producto, forma de pago, nombre, documento, telefono y direccion. */
async function armSaleCompleta(): Promise<void> {
  // Contraentrega a proposito: es la forma de pago del caso real, y la unica que cierra el pedido en el
  // acto. Con una transferencia, close_conversation pide el comprobante y deja la venta esperando a la
  // duena - ese camino ya lo cubre la prueba del fallback de mas arriba.
  const product = await prisma.product.findFirstOrThrow({
    where: { businessId, active: true, variants: { none: {} } },
    select: { id: true },
  });
  const contraentrega = await prisma.paymentMethod.findFirstOrThrow({
    where: { businessId, active: true, settlement: "ON_DELIVERY" },
    select: { id: true },
  });
  assert.ok((await runCatalogTool(context, "set_order_item", { productId: product.id, quantity: 1 })) as unknown);
  assert.ok((await runCatalogTool(context, "set_payment_method", { paymentMethodId: contraentrega.id })) as unknown);
  // El cliente dice su nombre y RECIEN ahi el modelo llama la herramienta, que es el orden real: desde
  // 2026-09-18 no se puede guardar un nombre que el cliente nunca escribio (ver nombreDeCliente.ts).
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: "soy Carlos Mendoza" } });
  await runCatalogTool(context, "save_customer_name", { name: "Carlos Mendoza" });
  const guardado = (await runCatalogTool(context, "save_customer_contact_info", {
    idNumber: "106484013",
    deliveryPhone: "3150496302",
    address: "Bogotá, barrio Primavera, Transversal 42 #5A-28, casa 4to piso",
  })) as { ok?: boolean };
  assert.ok(guardado.ok !== false, "el test necesita los datos de entrega guardados");
  const { checkout } = (await getSaleState(conversationId))!;
  assert.deepEqual(checkout.faltan, [], "el checkout tiene que quedar completo para este grupo de pruebas");
}

/** Un mensaje del cliente POSTERIOR al momento en que el pedido quedo completo. */
async function customerWritesAgain(text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: text } });
}

test("el caso de Carlos: pedido completo, sin foto, y el modelo no llama nada - el pedido se crea igual", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSaleCompleta();
  await customerWritesAgain("Si");

  // Exactamente lo que paso en produccion: el modelo copia la plantilla de cierre del negocio y no
  // llama ninguna herramienta, en los tres intentos.
  const cierreCopiado = "En total serian $94.000 pesos a pagar contra entrega. Por favor estar pendiente del cel.";
  programModel([textOnly(cierreCopiado), textOnly(cierreCopiado), textOnly(cierreCopiado)]);

  await generateReply(conversationId, context, personality, "Si");

  const order = await prisma.order.findFirst({ where: { conversationId } });
  assert.ok(order, "el pedido tiene que existir aunque el modelo no lo haya cerrado nunca");
  assert.equal(requiredEffectStats.fallbackResolved, 1, "lo cerro el servidor, no el modelo");
});

test("sin una sola imagen en la conversacion, el efecto exigido es el cierre", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSaleCompleta();
  await customerWritesAgain("Si");

  assert.equal(
    await prisma.message.count({ where: { conversationId, mediaType: "IMAGE" } }),
    0,
    "el punto de esta prueba es que NO hay comprobante: contraentrega no lo tiene"
  );
  const exigidos = await computeRequiredEffects(conversationId, { mediaType: null });
  assert.equal(exigidos.length, 1);
  assert.equal(exigidos[0].kind, "SALE_REGISTERED_AND_OWNER_NOTIFIED");
});

test("el disparador invertido: en el turno donde el pedido se completa no se registra nada", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await customerWritesAgain("Contra entrega");
  await armSaleCompleta(); // el estado se completa DESPUES del ultimo mensaje del cliente

  assert.deepEqual(
    await computeRequiredEffects(conversationId, { mediaType: null }),
    [],
    "el cliente todavia no escribio nada con el pedido armado delante: le queda un mensaje entero para decir que no"
  );

  // Y en cuanto escribe, si.
  await customerWritesAgain("Si, correcto");
  const exigidos = await computeRequiredEffects(conversationId, { mediaType: null });
  assert.equal(exigidos.length, 1);
  assert.equal(exigidos[0].kind, "SALE_REGISTERED_AND_OWNER_NOTIFIED");
});

test("un pedido incompleto no se registra solo, por mas que el cliente escriba", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSale(); // producto y forma de pago, pero sin nombre ni direccion
  await customerWritesAgain("Si");

  const { checkout } = (await getSaleState(conversationId))!;
  assert.ok(checkout.faltan.length > 0, "el checkout de esta prueba tiene que estar incompleto");
  assert.deepEqual(await computeRequiredEffects(conversationId, { mediaType: null }), []);
});

test("con un pedido ya registrado no se crea un segundo", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSaleCompleta();
  await customerWritesAgain("Si");
  programModel([textOnly("Listo"), textOnly("Listo"), textOnly("Listo")]);
  await generateReply(conversationId, context, personality, "Si");
  assert.equal(await prisma.order.count({ where: { conversationId } }), 1);

  await customerWritesAgain("Gracias");
  assert.deepEqual(
    await computeRequiredEffects(conversationId, { mediaType: null }),
    [],
    "el candado de idempotencia es la fila Order, no la memoria del turno"
  );
});

// ---------------------------------------------------------------------------------------------------
// E13b (2026-09-18). La pregunta que ya no hacia falta.
//
// Conversacion cmu6b0uja0028od2ka6c04qol (Dennis). El cliente manda la foto de un reloj a las 01:54:18;
// a las 01:58:52 el servidor le manda las dos fotos del Smartwatch gen 9 - o sea, lo identifico SOLO; y
// a las 02:00:25 el turno igual desperto a la duena para preguntarle que producto era.
//
// La causa: "atendida" solo contemplaba avisos a la duena. Que el servidor resolviera la foto y le
// mandara el producto al cliente no contaba como atenderla.
// ---------------------------------------------------------------------------------------------------

test("E13b: si el servidor ya le mando al cliente la media del producto, la imagen queda atendida y no se despierta a la duena", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  // Precondicion del disparador (ver "una imagen sin nada que el servidor haya escrito no exige nada"):
  // tiene que existir actividad de venta escrita por el servidor. En Dennis existia - venia mostrandole
  // productos desde antes de la foto.
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");

  await customerSendsReceiptPhoto();

  // Antes de mandar nada, el efecto SI se exige: es el estado en que quedo Dennis a las 01:54.
  const antes = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(antes.length, 1, "una imagen sin atender tiene que exigir el aviso");
  assert.equal(antes[0].kind, "OWNER_NOTIFIED_ABOUT_IMAGE");

  // Ahora el servidor identifica el producto y le manda la foto al cliente. El hecho se escribe como lo
  // escribe produccion: un Message del ASISTENTE con media Y con relatedProductId apuntando a un
  // producto real del catalogo - no un texto que diga que la mando.
  const producto = await prisma.product.findFirstOrThrow({ where: { businessId } });
  await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: `¡Ese es el *${producto.name}*!`,
      mediaType: "IMAGE",
      mediaS3Key: `k-${randomUUID()}`,
      relatedProductId: producto.id,
    },
  });

  const despues = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.deepEqual(
    despues,
    [],
    "con el producto ya identificado y enviado, despertar a la duena es molestarla por algo resuelto"
  );
});

test("E13b: una media SIN relatedProductId no alcanza para dar la imagen por atendida", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();

  // Media del asistente pero sin producto asociado: puede ser cualquier cosa (un comprobante reenviado,
  // una foto suelta). No prueba que la foto del cliente se haya identificado, asi que NO puede apagar el
  // efecto - si lo apagara, bastaria con mandar cualquier imagen para que la duena no se entere nunca.
  await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: "Te paso una imagen",
      mediaType: "IMAGE",
      mediaS3Key: `k-${randomUUID()}`,
    },
  });

  const exigidos = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(exigidos.length, 1, "sin producto asociado, la imagen sigue sin atender");
  assert.equal(exigidos[0].kind, "OWNER_NOTIFIED_ABOUT_IMAGE");
});

test("E13b: la media del producto tiene que ser POSTERIOR a la imagen del cliente", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");

  // Orden invertido a proposito: primero el servidor manda un producto (por otra cosa), y DESPUES el
  // cliente manda una foto nueva. Esa foto nueva no esta atendida por algo que paso antes de existir.
  const producto = await prisma.product.findFirstOrThrow({ where: { businessId } });
  await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: `Mira el *${producto.name}*`,
      mediaType: "IMAGE",
      mediaS3Key: `k-${randomUUID()}`,
      relatedProductId: producto.id,
    },
  });
  await new Promise((r) => setTimeout(r, 5));
  await customerSendsReceiptPhoto();

  const exigidos = await computeRequiredEffects(conversationId, { mediaType: "IMAGE" });
  assert.equal(exigidos.length, 1, "una media anterior no atiende una imagen posterior");
  assert.equal(exigidos[0].kind, "OWNER_NOTIFIED_ABOUT_IMAGE");
});

// ---------------------------------------------------------------------------------------------------
// E76 (2026-09-18). EL DENOMINADOR DEL AGENTE.
//
// requiredEffectStats ya contaba todo esto, pero en memoria: se pierde en cada reinicio, y el
// 2026-09-17 hubo trece despliegues en un dia. Lo que sigue prueba que cada uno de los cuatro finales
// de la escalera queda escrito en la fila del turno, que es lo unico que sobrevive a un reinicio.
//
// Los cuatro casos son los MISMOS escenarios de arriba, a proposito: si alguno de esos tests cambia de
// final, este de aca tiene que romperse tambien. Duplicar el escenario y no el aserto es lo que hace
// que la columna no pueda quedar mintiendo en silencio.
// ---------------------------------------------------------------------------------------------------

async function autorDelUltimoTurno(): Promise<string | null> {
  const turno = await prisma.agentTurn.findFirstOrThrow({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
  });
  return turno.effectAuthor;
}

test("E76: el turno que el modelo resuelve solo queda escrito como 'modelo'", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();
  programModel([withToolCall("ask_owner_about_photo", {}), textOnly("Le pase tu imagen al equipo.")]);

  await generateReply(conversationId, context, personality, "");

  assert.equal(await autorDelUltimoTurno(), "modelo");
});

test("E76: el turno que hizo falta forzar queda escrito como 'reintento'", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSale();
  await customerSendsReceiptPhoto();
  programModel([
    textOnly("Estoy validando tu comprobante."),
    withToolCall("close_conversation", { outcome: "SOLD", summary: "1x producto" }),
    textOnly("Listo, ya le pase tu comprobante al equipo."),
  ]);

  await generateReply(conversationId, context, personality, "");

  // "reintento" y no "modelo": el efecto ocurrio, pero no porque el agente lo decidiera. Contarlo como
  // modelo seria exactamente el autoengano que esta columna vino a cerrar.
  assert.equal(await autorDelUltimoTurno(), "reintento");
  assert.equal(requiredEffectStats.retryResolved, 1, "el escenario tiene que seguir siendo el del reintento");
});

test("E76: el turno que escribio el codigo queda escrito como 'servidor'", async () => {
  await seedFor({ saleStateEnabled: true, requiredEffectsEnabled: true });
  await armSale();
  await customerSendsReceiptPhoto();
  programModel([textOnly("Estoy validando."), textOnly("Sigo validando."), textOnly("Ya casi.")]);

  const { text: reply } = await generateReply(conversationId, context, personality, "");

  assert.equal(reply, FALLBACK_SALE_REGISTERED_TEXT, "el escenario tiene que seguir siendo el del fallback");
  assert.equal(await autorDelUltimoTurno(), "servidor", "el cliente leyo texto fijo nuestro: eso es un chatbot, y tiene que contarse");
});

test("E76: el turno que termino en una persona queda escrito como 'escalado'", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  await recordMediaSent(conversationId, "Reloj Inteligente Serie 11 Mini (Plateado)");
  await customerSendsReceiptPhoto();
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as unknown as Response) as typeof fetch;
  programModel([textOnly("Estoy validando."), textOnly("Sigo validando."), textOnly("Ya casi.")]);

  await generateReply(conversationId, context, personality, "");

  assert.equal(await autorDelUltimoTurno(), "escalado");
});

test("E76: un turno que no exigia ningun efecto no inventa un autor", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });
  programModel([textOnly("Contame que necesitas y te ayudo.")]);

  await generateReply(conversationId, context, personality, "hola");

  // null y no "modelo": el agente no resolvio nada porque no habia nada que resolver. Meterlo en el
  // numerador inflaria la tasa de exito con turnos que nunca estuvieron en riesgo.
  assert.equal(await autorDelUltimoTurno(), null);
});

test("E76: la tasa sale sobre los turnos que exigian algo, y los turnos sin dato no entran", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });

  const autores = ["modelo", "modelo", "reintento", "servidor", "escalado", null];
  for (const effectAuthor of autores) {
    await prisma.agentTurn.create({ data: { businessId, conversationId, effectAuthor } });
  }

  const resumen = await getAgentAuthorshipSummary(businessId, 7);

  assert.equal(resumen.turnsWithRequiredEffects, 5, "el turno con null no exigia nada: no es denominador");
  assert.deepEqual(resumen.byAuthor, { modelo: 2, reintento: 1, servidor: 1, escalado: 1 });
  // 2 de 5 los escribio el codigo (servidor + escalado). Esa es la tasa que hay que mirar al lado de las
  // lineas del prompt: el prompt bajando con este numero subiendo no es progreso.
  assert.equal(resumen.serverWroteRate, 0.4);
  assert.equal(resumen.modelSolvedRate, 0.4);
  assert.ok(resumen.promptLines && resumen.promptLines > 0, "la otra mitad de la medida viaja en la misma respuesta");
});

test("E76: sin ningun turno con efectos la tasa es null, que no es lo mismo que cero", async () => {
  await seedFor({ saleStateEnabled: false, requiredEffectsEnabled: true });

  const resumen = await getAgentAuthorshipSummary(businessId, 7);

  assert.equal(resumen.turnsWithRequiredEffects, 0);
  // Cero diria "el servidor nunca escribio", que es una afirmacion sobre datos que no existen.
  assert.equal(resumen.serverWroteRate, null);
  assert.equal(resumen.modelSolvedRate, null);
});
