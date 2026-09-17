import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getOrCreateOpenConversation } from "../conversation/service";
import { getOrRefreshContextSummary } from "./agent";
import { getPostSaleContext, postSaleFactsForModel } from "../orders/postSale";

// EL CLIENTE QUE VUELVE, Y DE DONDE SALE LO QUE EL MODELO SABE DE SU COMPRA (2026-09-17, etapa E03).
//
// Gratis y determinista: ninguno de estos caminos llama a DeepSeek, por eso es `*.test.ts` y no
// `*Paid.ts`. El camino que sí llama al modelo (una conversacion larga que envejece mensajes) se
// prueba en contextSummaryPaid.ts.
//
// Dos garantias, y la segunda nacio de un defecto que la primera dejo a la vista el mismo dia:
//
// 1. Un resumen ya guardado llega al modelo aunque la conversacion sea corta. Antes, la funcion
//    devolvia null ANTES de leer la fila cuando habia 20 mensajes o menos.
//
// 2. Al abrir una conversacion nueva NO se siembra un resumen del pedido anterior. Eso existia y se
//    borro: era un snapshot congelado al crear la conversacion, y de las siete conversaciones que lo
//    tenian en produccion, CUATRO decian "todavia no ha sido despachado" sobre pedidos ya despachados.
//    Lo que el modelo sabe de esa compra sale de postSale, que lee la base en cada turno.

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

test("un resumen ya guardado llega al modelo aunque la conversacion tenga pocos mensajes", async () => {
  const conversation = await getOrCreateOpenConversation(businessId, customerId);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { contextSummary: "El cliente comparo dos relojes y quedo en pensarlo." },
  });
  for (const [role, content] of [
    ["CUSTOMER", "Hola"],
    ["ASSISTANT", "Con gusto"],
  ] as const) {
    await prisma.message.create({ data: { conversationId: conversation.id, role, content } });
  }

  assert.equal(
    await getOrRefreshContextSummary(conversation.id, businessId),
    "El cliente comparo dos relojes y quedo en pensarlo."
  );

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

test("la conversacion nueva de un cliente que ya compro NO nace con un resumen congelado del pedido", async () => {
  const vieja = await prisma.conversation.create({ data: { customerId, status: "SOLD" } });
  const order = await prisma.order.create({
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
  assert.equal(
    (await prisma.conversation.findUniqueOrThrow({ where: { id: nueva.id } })).contextSummary,
    null,
    "un snapshot del pedido escrito una sola vez solo puede envejecer mal"
  );
  assert.equal(await getOrRefreshContextSummary(nueva.id, businessId), null);

  // Y lo que el modelo sabe de esa compra sale de la base EN ESTE MOMENTO, con el estado de ahora.
  const antes = await getPostSaleContext(businessId, customerId, nueva.id);
  assert.equal(postSaleFactsForModel(antes!).estado, "PENDING");

  await prisma.order.update({ where: { id: order.id }, data: { fulfillmentStatus: "SHIPPED", shippedAt: new Date() } });
  const despues = await getPostSaleContext(businessId, customerId, nueva.id);
  assert.equal(
    postSaleFactsForModel(despues!).estado,
    "SHIPPED",
    "despachar el pedido tiene que cambiar lo que el turno siguiente le dice al modelo"
  );
});
