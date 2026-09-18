import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { generateReply, PAYMENT_BLOCK_MARKER } from "./agent";
import type { ToolContext } from "./tools";

// EL BLOQUE DE PAGO NO DEPENDE DE QUE EL MODELO LLAME UNA HERRAMIENTA (2026-09-18).
//
// Caso real de produccion, conversacion cmu73u9u8002mx22kwxptqie8 (Dennis Vanegas). Pidio el numero de
// Nequi tres veces, a las 15:21, 15:23 y 15:27. El modelo puso la marca del bloque de pago las tres
// veces y NO llamo `get_payment_methods` en ninguna (`toolsCalled: []`). Como el bloque solo se llenaba
// con el resultado de esa herramienta, la marca se borraba y el mensaje salia mutilado:
//
//   "¡Con gusto, Dennis! Aqui te van los datos:"   <- y nada debajo
//   "Cuando hagas el pago, me compartes el comprobante por aqui 🙌"
//
// El negocio TENIA el numero configurado. A la duena le toco entrar al panel y escribirlo a mano.
//
// El modelo se mockea (sin red, sin costo): lo que se prueba no es que el modelo colabore, sino
// justamente que da igual si colabora.

let businessId: string;
let customerId: string;
let conversationId: string;
let context: ToolContext;
let originalCreate: typeof deepseek.chat.completions.create;

const NUMERO_REAL = "3022168936";

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  businessId = business.id;
  await prisma.paymentMethod.create({
    data: {
      businessId,
      type: "TRANSFERENCIA",
      label: "Nequi, Llave o Daviplata",
      details: `Número ${NUMERO_REAL} (Nequi, Daviplata o Llave).\nA nombre de: Liseth Herrera.`,
      active: true,
    },
  });
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573098${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(async () => {
  conversationId = (await prisma.conversation.create({ data: { customerId } })).id;
  context = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573001112244",
  };
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
});

afterEach(async () => {
  deepseek.chat.completions.create = originalCreate;
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.agentTurn.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

/** El modelo devuelve ESE texto y ninguna herramienta, que es el turno que reprodujo el defecto. */
function elModeloResponde(text: string): void {
  deepseek.chat.completions.create = (async () => ({
    choices: [{ message: { role: "assistant", content: text, tool_calls: [] } }],
    usage: undefined,
  })) as unknown as typeof deepseek.chat.completions.create;
}

test("el numero de pago sale aunque el modelo no llame ninguna herramienta", async () => {
  elModeloResponde(
    `¡Con gusto, Dennis! Aquí te van los datos:\n\n${PAYMENT_BLOCK_MARKER}\n\nCuando hagas el pago me compartes el comprobante 🙌`,
  );

  const { text } = await generateReply(conversationId, context, null, "Regálame el número del nequi por favor");

  assert.match(text, new RegExp(NUMERO_REAL), "el dato lo tiene el servidor: no puede depender de que el modelo pida permiso para usarlo");
  assert.match(text, /Liseth Herrera/);
  assert.doesNotMatch(text, /BLOQUE_PAGO/, "la marca nunca viaja literal al cliente");
});

test("el mensaje no sale mutilado: la frase que anuncia los datos no queda sola", async () => {
  // Esto es lo que vio Dennis tres veces. El texto salia, con la promesa intacta y el dato borrado.
  elModeloResponde(
    `Aquí están los datos completos:\n\n${PAYMENT_BLOCK_MARKER}\n\nCuando tengas el comprobante me lo compartes 🙌`,
  );

  const { text } = await generateReply(conversationId, context, null, "Regálame el número por favor");

  const despuesDeLaFrase = text.split("datos completos:")[1] ?? "";
  assert.ok(
    despuesDeLaFrase.replace(/[\s🙌]/gu, "").length > 20,
    `la frase anuncia datos que tienen que estar debajo, y salio: ${JSON.stringify(text)}`,
  );
});

test("un negocio SIN formas de pago configuradas sigue sin inventar ninguna", async () => {
  // El caso opuesto, que tambien importa: si el dato no existe, no se lo inventa nadie. La marca se
  // borra igual que antes, y el incidente queda registrado para que se note en el panel.
  const sinMetodos = await prisma.business.create({
    data: { name: `Sin pagos ${randomUUID()}`, email: `sin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const cliente = await prisma.customer.create({ data: { businessId: sinMetodos.id, phoneNumber: `573097${Date.now()}` } });
  const conversacion = await prisma.conversation.create({ data: { customerId: cliente.id } });
  try {
    elModeloResponde(`Te paso los datos:\n\n${PAYMENT_BLOCK_MARKER}`);

    const { text } = await generateReply(
      conversacion.id,
      { ...context, businessId: sinMetodos.id, customerId: cliente.id, conversationId: conversacion.id },
      null,
      "como te pago?",
    );

    assert.doesNotMatch(text, new RegExp(NUMERO_REAL), "los datos de OTRO negocio no pueden aparecer nunca");
    assert.doesNotMatch(text, /BLOQUE_PAGO/);
  } finally {
    await prisma.message.deleteMany({ where: { conversationId: conversacion.id } });
    await prisma.agentTurn.deleteMany({ where: { conversationId: conversacion.id } });
    await prisma.conversation.deleteMany({ where: { id: conversacion.id } });
    await prisma.customer.deleteMany({ where: { id: cliente.id } });
    await prisma.business.deleteMany({ where: { id: sinMetodos.id } });
  }
});
