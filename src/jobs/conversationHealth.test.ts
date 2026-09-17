import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { teardownReplayBusiness } from "../ai/replay/seed";
import { findHealthIssues, runConversationHealthJob } from "./conversationHealth";

// Fase 0 del plan: hasta ahora el unico detector de fallos era una persona leyendo conversaciones. Cada
// caso de abajo es uno REAL de la auditoria del 14-15 de septiembre, escrito tal como quedo en la base.

const since = new Date("2026-09-15T03:00:00Z");
const at = (hhmmss: string) => new Date(`2026-09-15T${hhmmss}Z`);

function msg(role: "CUSTOMER" | "ASSISTANT", content: string, time: string, mediaType: string | null = null) {
  return { role, content, mediaType, createdAt: at(time) };
}

const sinDatos = { idNumber: null, deliveryPhone: null };

test('detecta "ya tengo la cedula" con la ficha vacia', () => {
  const found = findHealthIssues({
    conversationId: "c1",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("CUSTOMER", "Sebastián montealegre sotelo        CC: 1004074880", "03:02:41"),
      msg("ASSISTANT", "¡Gracias, Diana! 😊 Ya tengo el nombre y la cédula.", "03:02:45"),
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "DATO_NO_GUARDADO");
  assert.match(found[0].detail, /cedula/);
});

test("no se queja cuando el dato si quedo guardado", () => {
  const found = findHealthIssues({
    conversationId: "c1",
    since,
    customer: { idNumber: "1004074880", deliveryPhone: null },
    hasOrder: true,
    messages: [msg("ASSISTANT", "¡Gracias! Ya tengo el nombre y la cédula.", "03:02:45")],
  });
  assert.equal(found.length, 0);
});

test("detecta fotos prometidas que nunca salieron", () => {
  const found = findHealthIssues({
    conversationId: "c2",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("CUSTOMER", "Si", "03:01:00"),
      msg("ASSISTANT", "¡Claro que sí! 📸 Aquí te van las fotos del reloj.", "03:01:05"),
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "FOTO_PROMETIDA_SIN_ENVIAR");
});

test("no se queja si las fotos si salieron", () => {
  const found = findHealthIssues({
    conversationId: "c2",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("ASSISTANT", "[Foto de Serie 11 Mini]", "03:01:03", "IMAGE"),
      msg("ASSISTANT", "¡Claro que sí! 📸 Aquí te van las fotos del reloj.", "03:01:05"),
    ],
  });
  assert.equal(found.length, 0);
});

test("no confunde la foto de la guia con fotos del catalogo", () => {
  // La regresion del 15 de septiembre: una respuesta de envio correcta tomada por promesa incumplida.
  const found = findHealthIssues({
    conversationId: "c3",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("ASSISTANT", "te paso la foto de la guía apenas se realice el envío 📦", "03:15:50"),
    ],
  });
  assert.equal(found.length, 0);
});

test("detecta dos respuestas del bot en paralelo", () => {
  const found = findHealthIssues({
    conversationId: "c4",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("CUSTOMER", "Negro", "03:05:00"),
      msg("ASSISTANT", "¡Perfecto! Tenemos el Serie 11 Mini...", "03:05:05"),
      msg("ASSISTANT", "Ese modelo viene en una sola presentación...", "03:05:09"),
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "RESPUESTA_DUPLICADA");
});

test("detecta una venta cerrada que no quedo registrada", () => {
  const found = findHealthIssues({
    conversationId: "c5",
    since,
    customer: sinDatos,
    hasOrder: false,
    messages: [msg("ASSISTANT", "¡Listo! Te dejo el resumen: Producto... Total a pagar: $154.000", "03:33:44")],
  });
  assert.ok(found.some((f) => f.kind === "VENTA_SIN_PEDIDO"));
});

test("detecta fugas de estado interno y nombres de herramienta", () => {
  const conFuga = findHealthIssues({
    conversationId: "c6",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [
      msg("ASSISTANT", "tu pedido aún no aparece registrado en el sistema", "03:27:11"),
      msg("ASSISTANT", "Aquí van las fotos 📸 [send_product_media: Combo Pareja]", "03:28:00", null),
    ],
  });
  const tipos = conFuga.map((f) => f.kind);
  assert.equal(tipos.filter((t) => t === "FUGA_INTERNA").length, 2);
});

test("ignora lo que pasó antes de la ventana de revision", () => {
  const found = findHealthIssues({
    conversationId: "c7",
    since,
    customer: sinDatos,
    hasOrder: true,
    messages: [msg("ASSISTANT", "Aquí te van las fotos del reloj 📸", "02:00:00")],
  });
  assert.equal(found.length, 0);
});

// ---------------------------------------------------------------------------------------------------
// A QUIEN SE LE AVISA. La noche del incidente de Milena (2026-09-16) este job le mando a la duena
// "RESPUESTA_DUPLICADA x3" - un falso positivo que causa nuestro propio corte de mensajes de la Fase 10 -
// y NO le mando VENTA_SIN_PEDIDO, que habia saltado a las 03:01:30 en la conversacion de Milena y era la
// mitad de las ventas reales de esa noche. El unico aviso que recibio fue el que no significaba nada.
// Estas dos pruebas corren el job entero contra la base, con el fetch a la Graph API mockeado (ningun
// mensaje real sale de aca).

async function seedHealthBusiness(): Promise<{ businessId: string; conversationId: string }> {
  const business = await prisma.business.create({
    data: {
      name: `[HEALTH] ${randomUUID()}`,
      email: `health+${randomUUID()}@onix.internal`,
      passwordHash: "x",
      active: true,
      contactPhone: "573000000000",
      whatsappPhoneNumberId: `fake-${randomUUID()}`,
      whatsappAccessToken: "fake-token-no-es-real",
    },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, phoneNumber: `h-${randomUUID()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  return { businessId: business.id, conversationId: conversation.id };
}

async function runJobCapturingOwnerAlerts(): Promise<string[]> {
  const original = globalThis.fetch;
  const alerts: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    alerts.push(String(init?.body ?? ""));
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }), text: async () => "{}" } as Response;
  }) as typeof fetch;
  try {
    await runConversationHealthJob();
  } finally {
    globalThis.fetch = original;
  }
  return alerts;
}

test("RESPUESTA_DUPLICADA queda registrada pero ya no le avisa al dueno", async () => {
  const { businessId, conversationId } = await seedHealthBusiness();
  try {
    // Dos respuestas del bot con segundos de diferencia: exactamente lo que produce splitLongMessage.
    await prisma.message.create({ data: { conversationId, role: "ASSISTANT", content: "Primera parte del mensaje largo." } });
    await prisma.message.create({ data: { conversationId, role: "ASSISTANT", content: "Segunda parte del mensaje largo." } });

    const alerts = await runJobCapturingOwnerAlerts();

    const registrado = await prisma.agentIncident.findFirst({
      where: { businessId, detail: { contains: "RESPUESTA_DUPLICADA" } },
    });
    assert.ok(registrado, "el hallazgo se sigue registrando y sigue visible en Bot > Salud");
    assert.equal(alerts.length, 0, "pero no interrumpe a nadie");
  } finally {
    await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
    await teardownReplayBusiness(businessId);
  }
});

test("VENTA_SIN_PEDIDO queda registrada y tampoco le avisa al dueno", async () => {
  // 2026-09-17: este chequeo dejo de escribirle al dueno. El aviso decia "VENTA_SIN_PEDIDO" - el nombre
  // interno del detector, sin el cliente, sin el producto y sin nada que el dueno pudiera hacer al
  // leerlo. Ademas, que una venta quede sin pedido lo verifica ahora el turno mismo contra la base y lo
  // reintenta antes de responder (requiredEffects, obligatorio desde esta misma fecha): avisar media hora
  // despues es la version vieja y peor del mismo trabajo.
  const { businessId, conversationId } = await seedHealthBusiness();
  try {
    await prisma.message.create({
      data: { conversationId, role: "ASSISTANT", content: "Te dejo el resumen de tu pedido: 1x producto. Total a pagar $154.000" },
    });

    const alerts = await runJobCapturingOwnerAlerts();

    const registrado = await prisma.agentIncident.findFirst({
      where: { businessId, detail: { contains: "VENTA_SIN_PEDIDO" } },
    });
    assert.ok(registrado, "el hallazgo se sigue registrando y sigue visible en Bot > Salud");
    assert.equal(alerts.length, 0, "pero no interrumpe a nadie");
  } finally {
    await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
    await teardownReplayBusiness(businessId);
  }
});

test("una escalacion prometida sin herramienta queda registrada y tampoco avisa", async () => {
  // Al cliente que quedo esperando lo rescata el recordatorio de conversacion sin responder, que dice su
  // nombre y se puede accionar. Esa era la unica consecuencia real que este aviso cubria.
  const { businessId, conversationId } = await seedHealthBusiness();
  try {
    await prisma.message.create({ data: { conversationId, role: "ASSISTANT", content: "Dejame consultarlo con el equipo." } });
    await prisma.agentIncident.create({
      data: {
        businessId,
        conversationId,
        kind: "BACKSTOP_INTERVENTION",
        guard: "escalacion_prometida_sin_herramienta",
        detail: "El bot prometio consultar al dueno sin ninguna PendingOwnerQuestion real.",
      },
    });

    const alerts = await runJobCapturingOwnerAlerts();

    const registrado = await prisma.agentIncident.findFirst({
      where: { businessId, detail: { contains: "ESCALACION_PROMETIDA_SIN_HERRAMIENTA" } },
    });
    assert.ok(registrado, "el detector F1 sigue dejando su fila");
    assert.equal(alerts.length, 0, "pero no le llega un WhatsApp al dueno");
  } finally {
    await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
    await teardownReplayBusiness(businessId);
  }
});

