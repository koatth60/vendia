import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getOrCreateOpenConversation } from "../conversation/service";
import { getOrRefreshContextSummary } from "./agent";

// EL RESUMEN SEMBRADO LLEGA AL MODELO (2026-09-17, etapa E03 de ONIX-PLAN.md).
//
// Gratis y determinista: una conversacion con pocos mensajes NO llama a DeepSeek por este camino, asi
// que este archivo es `*.test.ts` y no `*Paid.ts`. El camino que sí llama al modelo (una conversacion
// larga que envejece mensajes) se sigue probando en contextSummaryPaid.ts.
//
// El defecto: cuando un cliente que ya compro vuelve a escribir y su conversacion anterior quedo en
// SOLD, getOrCreateOpenConversation abre una nueva y le SIEMBRA en `contextSummary` que compro, cuando
// y si ya se despacho. getOrRefreshContextSummary devolvia null antes de leer esa fila cuando la
// conversacion tenia 20 mensajes o menos - o sea, justo en el unico caso para el que el resumen fue
// escrito. La conversacion de Andres tenia 14 mensajes el 2026-09-17.

let businessId: string;
let customerId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Resumen ${randomUUID()}`, email: `rs-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573008${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.orderItem.deleteMany({ where: { order: { businessId } } });
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("el cliente que ya compro y vuelve arranca con el resumen de su compra, no de cero", async () => {
  const vieja = await prisma.conversation.create({ data: { customerId, status: "SOLD" } });
  await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: vieja.id,
      summary: "1x Reloj Serie 12 Ultra 3, negro. Contraentrega.",
      totalAmount: 149000,
      currency: "COP",
      items: { create: [{ productName: "Reloj Serie 12 Ultra 3", variantLabel: "negro", quantity: 1, unitPrice: 140000, currency: "COP" }] },
    },
  });

  // La conversacion vieja esta en SOLD, asi que esto abre una NUEVA - el caso de Andres.
  const nueva = await getOrCreateOpenConversation(businessId, customerId);
  assert.notEqual(nueva.id, vieja.id);

  const sembrado = (await prisma.conversation.findUniqueOrThrow({ where: { id: nueva.id } })).contextSummary;
  assert.ok(sembrado, "getOrCreateOpenConversation tiene que sembrar el resumen de la compra anterior");

  // Cuatro mensajes: muy por debajo de la ventana de 20 que antes hacia devolver null.
  for (const [role, content] of [
    ["CUSTOMER", "Oye confirmado lo del reloj"],
    ["ASSISTANT", "Con gusto"],
    ["CUSTOMER", "mañana a que horas llegaria"],
    ["ASSISTANT", "Te confirmo"],
  ] as const) {
    await prisma.message.create({ data: { conversationId: nueva.id, role, content } });
  }

  const resumen = await getOrRefreshContextSummary(nueva.id, businessId);
  assert.equal(resumen, sembrado, "el resumen sembrado tiene que llegar al turno, no quedarse en la base");
  assert.match(resumen!, /Reloj Serie 12 Ultra 3/);
});

test("una conversacion corta sin resumen sembrado sigue devolviendo null, sin llamar al modelo", async () => {
  const sinCompra = await prisma.customer.create({ data: { businessId, phoneNumber: `573007${Date.now()}` } });
  const conversation = await getOrCreateOpenConversation(businessId, sinCompra.id);
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Hola" } });

  assert.equal(await getOrRefreshContextSummary(conversation.id, businessId), null);

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.conversation.deleteMany({ where: { customerId: sinCompra.id } });
  await prisma.customer.deleteMany({ where: { id: sinCompra.id } });
});
