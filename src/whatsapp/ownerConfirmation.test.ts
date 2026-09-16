import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  askOwnerToConfirmSale,
  drainOwnerConfirmationQueue,
  buildSaleConfirmationText,
  canSpendTemplate,
  describeCustomerForOwner,
  nextConfirmationDelayMinutes,
  CONFIRMATION_REMINDER_STEPS,
  CONFIRMATION_TEMPLATE_SPACING_MINUTES,
  MAX_CONFIRMATION_TEMPLATES,
} from "./ownerConfirmation";
import { findOpenPendingConfirmationsForBusiness, recordMessageDeliveryStatus } from "../conversation/service";
import { runSaleConfirmationChaserJob } from "../jobs/saleConfirmationChaser";
import { runStartupJobs } from "../jobs/startup";
import { runCatalogTool, type ToolContext } from "../ai/tools";
import { handleOwnerReply } from "../routes/whatsapp";

// La confirmacion de venta es el unico camino por el que entra plata: el pedido NO se crea hasta que el
// dueno conteste. Estas pruebas cubren que la pregunta LLEGUE (los tres escalones de la escalera), que se
// INSISTA (el perseguidor), que no se pierda si falla todo, y que insistir no pueda duplicar nada.
//
// Nunca con credenciales reales de WhatsApp: `fetch` se reemplaza entero y el negocio es de prueba. Una
// prueba con credenciales reales ya le escribio a una duena de verdad una vez (2026-09-13).

let businessId: string;
let customerId: string;
let conversationId: string;
let ownerPhone: string;
let customerPhone: string;
const credentials = { phoneNumberId: "test-id", accessToken: "test-token" };

type SentMessage = { to: string; type: string; body: string };
let sent: SentMessage[];
let originalFetch: typeof fetch;

// Que escalon acepta Meta en esta prueba. Es la unica palanca: el resto del comportamiento sale del
// codigo real.
type FetchMode = "all-ok" | "only-template" | "nothing";
let fetchMode: FetchMode;

// Error 131047 = ventana de servicio de 24h cerrada. No es reintentable, asi que la escalera baja al
// escalon siguiente sin esperas.
function windowClosed(): Response {
  return {
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { code: 131047, message: "Message failed to send: 24h window" } }),
  } as Response;
}

function stubWhatsappFetch(): void {
  originalFetch = globalThis.fetch;
  sent = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient ?? "";
    const text =
      body.type === "text"
        ? (body.text?.body ?? "")
        : body.type === "interactive"
          ? (body.interactive?.body?.text ?? "")
          : body.type === "template"
            ? (body.template?.components?.[0]?.parameters?.[0]?.text ?? "")
            : "";
    if (fetchMode === "nothing") return windowClosed();
    if (fetchMode === "only-template" && body.type !== "template") return windowClosed();
    sent.push({ to, type: body.type, body: text });
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.${body.type}-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** Lo que salio hacia el dueno de ESTE negocio. El job recorre todos los negocios de la base de pruebas. */
function toOwner(type?: string): SentMessage[] {
  return sent.filter((m) => m.to === ownerPhone && (!type || m.type === type));
}

before(async () => {
  ownerPhone = `5730055${String(Date.now()).slice(-6)}`;
  const business = await prisma.business.create({
    data: {
      name: `Confirmacion ${randomUUID()}`,
      email: `confirm-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      contactPhone: ownerPhone,
      contactName: "Liz",
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
      // El perseguidor insiste cada 5 minutos y vence a las 24h, igual que MAGByLizN en produccion.
      ownerReminderMinutes: 5,
      ownerQuestionTimeoutHours: 24,
    },
  });
  businessId = business.id;
  await prisma.paymentMethod.create({
    data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "300", active: true },
  });
  await prisma.shippingRate.create({ data: { businessId, label: "Estandar", cost: 9000 } });
  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573007${String(Date.now()).slice(-6)}`, name: "Milena" },
  });
  customerId = customer.id;
  customerPhone = customer.phoneNumber;
});

after(async () => {
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  // Una conversacion nueva por prueba: el estado de la confirmacion vive en la conversacion, y compartir
  // una haria que el orden de las pruebas cambiara el resultado.
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  // Las pruebas que llegan hasta el "si llego" del dueno dejan un Order, que referencia la conversacion.
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
  await prisma.agentIncident.deleteMany({ where: { businessId } });
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
  // La ventana de 24h del CLIENTE se mide contra su ultimo mensaje; sin uno, todo envio al cliente da
  // la ventana por cerrada (y con razon).
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: "Ya te hice la transferencia" } });
  fetchMode = "all-ok";
});

const DRAFT = { items: [], shippingAddress: "Calle 1", paymentMethodLabel: "Nequi", shippingCost: 9000 };

async function ask(summary = "1x Reloj Serie 11 Mini - $154.000") {
  return askOwnerToConfirmSale({ businessId, conversationId, customerId, credentials, summary, draft: DRAFT });
}

/**
 * Adelanta el reloj de ESTA confirmacion corriendo sus fechas hacia atras. El job usa `Date.now()` real,
 * asi que mover las fechas es la unica forma de simular horas sin esperarlas - y es fiel: el vencimiento
 * mide contra `pendingConfirmationAskedAt`, que se corre igual que todo lo demas.
 */
async function shiftBack(minutes: number): Promise<void> {
  const ms = minutes * 60 * 1000;
  const c = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  const back = (date: Date | null) => (date ? new Date(date.getTime() - ms) : null);
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      pendingConfirmationAskedAt: back(c.pendingConfirmationAskedAt),
      pendingConfirmationRemindedAt: back(c.pendingConfirmationRemindedAt),
      pendingConfirmationNextAttemptAt: back(c.pendingConfirmationNextAttemptAt),
      pendingConfirmationLastTemplateAt: back(c.pendingConfirmationLastTemplateAt),
    },
  });
}

/** Corre el perseguidor hasta que la confirmacion vence, saltando de un intento al siguiente. */
async function simularHastaElVencimiento(): Promise<{ minutosSimulados: number; pasadas: number }> {
  let minutosSimulados = 0;
  let pasadas = 0;
  for (;;) {
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (!c.pendingConfirmationAskedAt) break; // vencida y limpiada
    const faltanMin = Math.max(Math.ceil((c.pendingConfirmationNextAttemptAt!.getTime() - Date.now()) / 60000), 0);
    await shiftBack(faltanMin);
    minutosSimulados += faltanMin;
    await runSaleConfirmationChaserJob();
    pasadas++;
    assert.ok(pasadas < 400, "el perseguidor tiene que terminar: o el dueno contesta o vence");
  }
  return { minutosSimulados, pasadas };
}

test("describeCustomerForOwner no muestra un numero que WhatsApp oculto", () => {
  assert.equal(describeCustomerForOwner({ name: "Milena", phoneNumber: "573001112233" }), "Milena (573001112233)");
  assert.equal(
    describeCustomerForOwner({ name: "Milena", phoneNumber: "BS.1234567890" }),
    "Milena (sin numero visible, privacidad de WhatsApp activada)"
  );
});

test("el texto de la confirmacion siempre termina en la pregunta que el dueno tiene que contestar", () => {
  const text = buildSaleConfirmationText({ contactName: "Liz", customerLabel: "Milena", summary: "1x Reloj" });
  assert.match(text, /^Hola Liz,/);
  assert.match(text, /1x Reloj/);
  assert.match(text, /¿Te llego el pago\?$/);
});

test("camino normal: sale por botones y la confirmacion queda viva con su wamid", async () => {
  stubWhatsappFetch();
  try {
    const result = await ask();
    assert.equal(result.pending, true);
    assert.equal(result.outcome?.channel, "BUTTONS");
    assert.equal(toOwner("interactive").length, 1);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.ok(conversation.pendingConfirmationAskedAt);
    assert.ok(conversation.pendingConfirmationMessageId);
    assert.equal(conversation.pendingConfirmationChannel, "BUTTONS");
    assert.equal(conversation.pendingConfirmationButtonsQueued, false);
    assert.equal(conversation.pendingConfirmationAttempts, 1);

    // El pedido NO se crea: eso solo pasa cuando el dueno contesta que el pago llego.
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  } finally {
    restoreFetch();
  }
});

test("el wamid del aviso al dueno queda guardado, asi el acuse de entrega de Meta tiene donde aterrizar", async () => {
  stubWhatsappFetch();
  try {
    const result = await ask();
    const wamid = result.outcome!.wamid!;
    const log = await prisma.ownerMessageLog.findUniqueOrThrow({ where: { wamid } });
    assert.equal(log.conversationId, conversationId);
    assert.equal(log.deliveryStatus, null, "recien enviado: todavia no hay acuse");

    // Mismo camino que usa el webhook de estados de Meta para los mensajes al cliente.
    await recordMessageDeliveryStatus(wamid, "delivered");
    const delivered = await prisma.ownerMessageLog.findUniqueOrThrow({ where: { wamid } });
    assert.equal(delivered.deliveryStatus, "DELIVERED");
    assert.ok(delivered.deliveryStatusAt);

    // Un acuse peor que el que ya esta escrito no lo pisa (Meta los manda fuera de orden).
    await recordMessageDeliveryStatus(wamid, "sent");
    const stillDelivered = await prisma.ownerMessageLog.findUniqueOrThrow({ where: { wamid } });
    assert.equal(stillDelivered.deliveryStatus, "DELIVERED");
  } finally {
    restoreFetch();
  }
});

test("ventana cerrada: la pregunta sale por plantilla y el mensaje con botones queda encolado", async () => {
  stubWhatsappFetch();
  fetchMode = "only-template";
  try {
    const result = await ask();
    assert.equal(result.outcome?.channel, "TEMPLATE");
    assert.equal(result.outcome?.buttonsQueued, true);
    assert.equal(toOwner("template").length, 1, "la plantilla es lo unico que cruza la ventana cerrada");
    assert.equal(toOwner("interactive").length, 0);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.pendingConfirmationChannel, "TEMPLATE");
    assert.equal(conversation.pendingConfirmationButtonsQueued, true);
    assert.ok(conversation.pendingConfirmationMessageId, "el wamid de la plantilla sirve para matchear su respuesta citada");
  } finally {
    restoreFetch();
  }
});

test("el dueno escribe cualquier cosa: sale el mensaje con botones que habia quedado encolado", async () => {
  stubWhatsappFetch();
  try {
    fetchMode = "only-template";
    await ask();
    const templateWamid = (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } }))
      .pendingConfirmationMessageId;

    // Su respuesta reabre la ventana de 24h.
    fetchMode = "all-ok";
    const drained = await drainOwnerConfirmationQueue(businessId, credentials, ownerPhone);
    assert.equal(drained, 1);
    assert.equal(toOwner("interactive").length, 1);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.pendingConfirmationButtonsQueued, false);
    assert.equal(conversation.pendingConfirmationChannel, "BUTTONS");
    assert.notEqual(
      conversation.pendingConfirmationMessageId,
      templateWamid,
      "al apretar un boton WhatsApp cita el mensaje de los BOTONES, asi que ese es el wamid que tiene que matchear"
    );

    // Y no se manda dos veces: ya no queda nada encolado.
    assert.equal(await drainOwnerConfirmationQueue(businessId, credentials, ownerPhone), 0);
  } finally {
    restoreFetch();
  }
});

test("si no entrega ninguna de las tres vias, la confirmacion NO se pierde: queda pendiente de reintento", async () => {
  stubWhatsappFetch();
  fetchMode = "nothing";
  try {
    const result = await ask();
    assert.equal(result.pending, true, "no poder avisarle al dueno nunca puede autoconfirmar la venta");
    assert.equal(result.outcome?.channel, "NONE");

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.ok(conversation.pendingConfirmationAskedAt, "sigue viva aunque no haya wamid");
    assert.equal(conversation.pendingConfirmationMessageId, null);
    assert.equal(conversation.pendingConfirmationChannel, "NONE");
    assert.ok(conversation.pendingOrderItems, "el borrador del pedido se guarda igual, para poder reintentar");
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0);

    // Y el perseguidor la ve: antes esta consulta pedia wamid y estas desaparecian para siempre.
    const open = await findOpenPendingConfirmationsForBusiness(businessId);
    assert.ok(open.some((c) => c.id === conversationId));
  } finally {
    restoreFetch();
  }
});

test("el perseguidor vuelve a preguntar pasados ownerReminderMinutes, y no antes", async () => {
  stubWhatsappFetch();
  try {
    await ask();

    // El primer aviso sale exactamente a los ownerReminderMinutes configurados por el dueno: la escalera
    // de espaciado arranca en 1x y crece recien despues.
    const recien = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const primerIntervaloMin = Math.round(
      (recien.pendingConfirmationNextAttemptAt!.getTime() - recien.pendingConfirmationAskedAt!.getTime()) / 60000
    );
    assert.equal(primerIntervaloMin, 5, "el primer intervalo es Business.ownerReminderMinutes, tal cual");

    // Recien preguntado: todavia no toca insistir.
    sent = [];
    await runSaleConfirmationChaserJob();
    assert.equal(toOwner().length, 0, "insistir de inmediato seria spam, no persistencia");

    // Pasados los 5 minutos.
    await shiftBack(10);
    sent = [];
    await runSaleConfirmationChaserJob();
    const reminders = toOwner();
    assert.equal(reminders.length, 1);
    assert.match(reminders[0].body, /Recordatorio \(intento 2\)/);
    assert.match(reminders[0].body, /¿Te llego el pago\?/);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.pendingConfirmationAttempts, 2);
    assert.ok(conversation.pendingConfirmationRemindedAt);
    assert.ok(conversation.pendingConfirmationAskedAt, "la confirmacion sigue viva hasta que el dueno conteste");

    // Y el siguiente intervalo ya es mayor: 2x la base, no 1x.
    const segundoIntervaloMin = Math.round(
      (conversation.pendingConfirmationNextAttemptAt!.getTime() - conversation.pendingConfirmationRemindedAt!.getTime()) / 60000
    );
    assert.equal(segundoIntervaloMin, 10);

    // Y no insiste dos veces dentro del mismo intervalo.
    sent = [];
    await runSaleConfirmationChaserJob();
    assert.equal(toOwner().length, 0);
  } finally {
    restoreFetch();
  }
});

test("vencido ownerQuestionTimeoutHours: la conversacion pasa a manos de una persona y queda registrada", async () => {
  stubWhatsappFetch();
  try {
    await ask();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        pendingConfirmationAskedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        pendingConfirmationRemindedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        pendingConfirmationNextAttemptAt: new Date(Date.now() - 60 * 1000),
      },
    });

    sent = [];
    await runSaleConfirmationChaserJob();

    const avisos = toOwner();
    assert.equal(avisos.length, 1, "un solo aviso de vencimiento, no un vencimiento MAS un recordatorio");
    assert.match(avisos[0].body, /Se vencio el tiempo de espera/);
    assert.match(avisos[0].body, /NO se creo ningun pedido/);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.humanControl, true);
    assert.equal(conversation.pendingConfirmationAskedAt, null, "vencida: el perseguidor deja de insistir");
    assert.equal(conversation.pendingConfirmationMessageId, null);
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0, "vencer nunca puede crear el pedido");

    const incidents = await prisma.agentIncident.findMany({
      where: { businessId, conversationId, kind: "SALE_CONFIRMATION_TIMEOUT" },
    });
    assert.equal(incidents.length, 1);

    // El cliente pago y no puede quedar mudo justo cuando la conversacion pasa a una persona.
    const customerMessages = await prisma.message.findMany({ where: { conversationId, role: "ASSISTANT" } });
    assert.equal(customerMessages.length, 1);
    assert.match(customerMessages[0].content, /Seguimos revisando/i);
  } finally {
    restoreFetch();
  }
});

test("diez intentos seguidos de cerrar la misma venta: una sola pregunta al dueno y ningun pedido", async () => {
  stubWhatsappFetch();
  try {
    const context: ToolContext = {
      businessId,
      conversationId,
      customerId,
      credentials,
      recipientPhone: "573009998877",
    };

    for (let i = 0; i < 10; i++) {
      const result = (await runCatalogTool(context, "close_conversation", {
        outcome: "SOLD",
        summary: "1x Reloj Serie 11 Mini - $154.000",
      })) as { closed: boolean; pending?: boolean };
      assert.equal(result.closed, false, `intento ${i + 1}: la venta no se cierra sin la confirmacion del dueno`);
      assert.equal(result.pending, true);
    }

    assert.equal(toOwner("interactive").length, 1, "diez intentos, una sola pregunta al dueno");
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0, "ningun pedido sin confirmacion");
    assert.equal(
      await prisma.conversation.count({ where: { customerId, pendingConfirmationAskedAt: { not: null } } }),
      1,
      "una sola confirmacion viva"
    );
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.pendingConfirmationAttempts, 1);
  } finally {
    restoreFetch();
  }
});

test("el dueno aprieta '✅ Si llego': el flujo existente crea el pedido y la confirmacion deja de estar viva", async () => {
  stubWhatsappFetch();
  try {
    const result = await ask();
    const wamid = result.outcome!.wamid!;

    // Exactamente lo que manda WhatsApp cuando el dueno aprieta el boton: cita el mensaje de los botones.
    await handleOwnerReply(businessId, credentials, ownerPhone, {
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "confirm_yes", title: "✅ Si llego" } },
      context: { id: wamid },
    });

    assert.equal(await prisma.order.count({ where: { conversationId } }), 1, "recien ahora se crea el pedido");

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.status, "SOLD");
    assert.equal(conversation.pendingConfirmationAskedAt, null, "contestada: el perseguidor tiene que dejar de insistir");
    assert.equal(conversation.pendingConfirmationMessageId, null);
    assert.equal(conversation.pendingConfirmationAttempts, 0);

    // Y el perseguidor, efectivamente, ya no la ve.
    const open = await findOpenPendingConfirmationsForBusiness(businessId);
    assert.equal(open.some((c) => c.id === conversationId), false);

    sent = [];
    await runSaleConfirmationChaserJob();
    assert.equal(toOwner().length, 0);
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// Politica de insistencia: espaciado creciente y tope de plantillas
// ---------------------------------------------------------------------------

test("el espaciado crece: el primer intervalo es el configurado y el ultimo paso se repite", () => {
  // Base 5 minutos, o sea la config real de MAGByLizN.
  assert.equal(nextConfirmationDelayMinutes(5, 1), 5, "el primer aviso respeta ownerReminderMinutes");
  assert.equal(nextConfirmationDelayMinutes(5, 2), 10);
  assert.equal(nextConfirmationDelayMinutes(5, 3), 15);
  const ultimo = CONFIRMATION_REMINDER_STEPS[CONFIRMATION_REMINDER_STEPS.length - 1] * 5;
  assert.equal(nextConfirmationDelayMinutes(5, CONFIRMATION_REMINDER_STEPS.length), ultimo);
  assert.equal(nextConfirmationDelayMinutes(5, 200), ultimo, "el ultimo paso se repite, no crece para siempre");
});

test("el presupuesto de plantillas tiene tope y separacion minima", () => {
  const ahora = new Date("2026-09-16T12:00:00Z");
  assert.equal(canSpendTemplate({ templatesSent: 0, lastTemplateAt: null }, ahora), true);
  assert.equal(
    canSpendTemplate({ templatesSent: 1, lastTemplateAt: new Date(ahora.getTime() - 60 * 60 * 1000) }, ahora),
    false,
    "una hora despues de la anterior todavia no: la segunda no despierta a nadie y se factura igual"
  );
  assert.equal(
    canSpendTemplate(
      { templatesSent: 1, lastTemplateAt: new Date(ahora.getTime() - CONFIRMATION_TEMPLATE_SPACING_MINUTES * 60 * 1000) },
      ahora
    ),
    true
  );
  assert.equal(
    canSpendTemplate({ templatesSent: MAX_CONFIRMATION_TEMPLATES, lastTemplateAt: new Date(0) }, ahora),
    false,
    "gastado el presupuesto no se manda ninguna mas, por vieja que sea la ultima"
  );
});

test("24 horas sin respuesta con la ventana abierta: 27 mensajes al dueno, no 288", async () => {
  stubWhatsappFetch();
  try {
    await ask();
    const { minutosSimulados } = await simularHastaElVencimiento();

    const recordatorios = toOwner("interactive").length - 1; // el primero es el pedido inicial
    assert.equal(toOwner("interactive").length, 27, "1 pedido inicial + 26 recordatorios en 24 horas");
    assert.equal(recordatorios, 26);
    assert.ok(minutosSimulados >= 24 * 60, `la simulacion tiene que cubrir las 24 horas (cubrio ${minutosSimulados} min)`);

    // Con cadencia fija de 5 minutos hasta el vencimiento habrian sido 288.
    assert.ok(toOwner("interactive").length < 40, "decenas, no cientos");

    // Y vencio igual que antes: sin pedido, a control manual.
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.humanControl, true);
    assert.equal(conversation.pendingConfirmationAskedAt, null);
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  } finally {
    restoreFetch();
  }
});

test("24 horas con la ventana cerrada: nunca mas de tres plantillas onix_owner_alert", async () => {
  stubWhatsappFetch();
  fetchMode = "only-template";
  try {
    await ask();
    await simularHastaElVencimiento();

    // El aviso de vencimiento tambien sale por plantilla, pero es otro mecanismo (uno por conversacion,
    // no por reintento): se cuenta aparte para que el tope se mida sobre lo que el tope gobierna.
    const plantillasDeLaConfirmacion = toOwner("template").filter((m) => !m.body.includes("Se vencio el tiempo de espera"));
    assert.equal(plantillasDeLaConfirmacion.length, MAX_CONFIRMATION_TEMPLATES);

    // Los reintentos siguieron igual (fallan gratis por botones/texto) y el vencimiento funciono.
    const intentos = await prisma.ownerMessageLog.count({ where: { conversationId, direction: "OUT" } });
    assert.equal(intentos, 28, "27 intentos de confirmacion + el aviso de vencimiento");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.humanControl, true);
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  } finally {
    restoreFetch();
  }
});

test("el dueno contesta al tercer intento: se corta la insistencia y queda un solo pedido", async () => {
  stubWhatsappFetch();
  try {
    await ask();

    // Dos recordatorios (intentos 2 y 3).
    await shiftBack(nextConfirmationDelayMinutes(5, 1));
    await runSaleConfirmationChaserJob();
    await shiftBack(nextConfirmationDelayMinutes(5, 2));
    await runSaleConfirmationChaserJob();

    const antes = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(antes.pendingConfirmationAttempts, 3);

    await handleOwnerReply(businessId, credentials, ownerPhone, {
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "confirm_yes", title: "✅ Si llego" } },
      context: { id: antes.pendingConfirmationMessageId! },
    });

    assert.equal(await prisma.order.count({ where: { conversationId } }), 1);

    // Y a partir de ahi el perseguidor no manda nada mas, por mucho que pase el tiempo.
    sent = [];
    for (let i = 0; i < 5; i++) await runSaleConfirmationChaserJob();
    assert.equal(toOwner().length, 0);
    assert.equal(await prisma.order.count({ where: { conversationId } }), 1, "un solo pedido");
  } finally {
    restoreFetch();
  }
});

// ---------------------------------------------------------------------------
// El reloj: que ownerReminderMinutes signifique lo que dice, y que reiniciar no atrase ni dispare nada
// ---------------------------------------------------------------------------

/**
 * Simula el reloj real del perseguidor: despierta cada minuto y deja que
 * `pendingConfirmationNextAttemptAt` decida si toca. Devuelve el minuto simulado en que salio el primer
 * mensaje al dueno, o null si no salio ninguno.
 */
async function minutoDelPrimerRecordatorio(maxMinutos: number): Promise<number | null> {
  for (let minuto = 1; minuto <= maxMinutos; minuto++) {
    await shiftBack(1);
    sent = [];
    await runSaleConfirmationChaserJob();
    if (toOwner().length > 0) return minuto;
  }
  return null;
}

test("con ownerReminderMinutes en 5 el primer recordatorio sale al minuto 5, no a los 30", async () => {
  stubWhatsappFetch();
  try {
    await ask();
    const minuto = await minutoDelPrimerRecordatorio(12);
    assert.ok(minuto !== null, "el recordatorio tiene que salir dentro de los primeros 12 minutos");
    assert.ok(
      minuto >= 5 && minuto <= 7,
      `el primer recordatorio tiene que salir entre el minuto 5 y el 7 (salio en el ${minuto}). Con el reloj de 30 minutos del job de escalaciones, ownerReminderMinutes = 5 era inalcanzable.`
    );
  } finally {
    restoreFetch();
  }
});

test("arrancar el proceso con una confirmacion ya vencida: se atiende en el arranque, no un intervalo despues", async () => {
  stubWhatsappFetch();
  try {
    await ask();
    // Ya le tocaba el recordatorio cuando el proceso arranco.
    await shiftBack(30);

    sent = [];
    await runStartupJobs();

    assert.equal(toOwner().length, 1, "la pasada de arranque tiene que atenderla ya");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.pendingConfirmationAttempts, 2);
  } finally {
    restoreFetch();
  }
});

test("arrancar el proceso con TODO al dia: cero mensajes", async () => {
  stubWhatsappFetch();
  try {
    // Nada pendiente en esta conversacion, y ningun otro estado vencido que este negocio pueda tener.
    sent = [];
    await runStartupJobs();
    // Acotado a este negocio: `npm test` corre los archivos en paralelo sobre la misma base, y los jobs
    // recorren TODOS los negocios. Lo que se prueba es que arrancar no genera trafico por si solo.
    const mios = sent.filter((m) => m.to === ownerPhone || m.to === customerPhone);
    assert.deepEqual(mios, [], "correr los jobs al arrancar no puede mandar un solo mensaje por si solo");
  } finally {
    restoreFetch();
  }
});

test("diez reinicios seguidos con una confirmacion viva y no vencida: cero mensajes", async () => {
  stubWhatsappFetch();
  try {
    await ask();
    const primerPedido = toOwner().length;
    assert.equal(primerPedido, 1);

    sent = [];
    for (let reinicio = 0; reinicio < 10; reinicio++) await runStartupJobs();

    assert.equal(toOwner().length, 0, "la confirmacion todavia no vencia: reiniciar no adelanta su reloj");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    assert.equal(conversation.pendingConfirmationAttempts, 1, "sigue en el intento inicial");
    assert.equal(await prisma.order.count({ where: { conversationId } }), 0);
  } finally {
    restoreFetch();
  }
});
