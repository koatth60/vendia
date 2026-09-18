import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { sePuede, normalizarEstado, transicionarPedido, TransicionNoPermitida } from "./stateMachine";
import { markOrderShipped, markOrderCanceled } from "./service";

// E31 (2026-09-18). El estado del pedido deja de poder sobrescribirse desde cualquier lado.
//
// markOrderShipped y markOrderCanceled eran dos `update` sueltos que ni miraban el estado actual: el
// panel podia cancelar un pedido YA ENVIADO (el mensajero ya salio) y volver a enviar uno cancelado.
// Y no quedaba rastro de quien hizo ninguna de las dos cosas.

const negocios: string[] = [];

after(async () => {
  for (const id of negocios) {
    await prisma.orderEvent.deleteMany({ where: { businessId: id } });
    await prisma.order.deleteMany({ where: { businessId: id } });
    await prisma.conversation.deleteMany({ where: { customer: { businessId: id } } });
    await prisma.customer.deleteMany({ where: { businessId: id } });
    await prisma.business.deleteMany({ where: { id } });
  }
});

async function pedido() {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x", active: true },
  });
  negocios.push(business.id);
  const customer = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: `5731${Date.now()}${Math.floor(Math.random() * 100)}` },
  });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  const order = await prisma.order.create({
    data: {
      businessId: business.id,
      conversationId: conversation.id,
      customerId: customer.id,
      summary: "1x Reloj",
      totalAmount: 10000,
      currency: "COP",
    },
  });
  return { businessId: business.id, orderId: order.id };
}

test("E31: la tabla de transiciones, sin tener que tocar la base", () => {
  // PENDING es el valor historico; se normaliza al mismo estado que PENDING_PAYMENT.
  assert.equal(normalizarEstado("PENDING"), "PENDING_PAYMENT");
  assert.ok(sePuede("PENDING", "SHIPPED"), "un pedido nuevo se puede enviar");
  assert.ok(sePuede("PENDING", "CANCELED"), "y se puede cancelar");
  assert.ok(sePuede("SHIPPED", "DELIVERED"));
  assert.ok(sePuede("SHIPPED", "RETURNED"), "lo que pasa despues de enviar es una devolucion");
  assert.equal(sePuede("SHIPPED", "CANCELED"), false, "un pedido que ya salio NO se cancela");
  assert.equal(sePuede("CANCELED", "SHIPPED"), false, "un pedido cancelado no se re-envia");
  assert.equal(sePuede("CANCELED", "PENDING_PAYMENT"), false, "cancelado es definitivo");
  assert.equal(sePuede("REFUNDED", "SHIPPED"), false);
});

test("E31: cancelar un pedido ya enviado falla con un motivo que se le puede mostrar al dueño", async () => {
  const { businessId, orderId } = await pedido();
  await markOrderShipped(businessId, orderId, { note: "Salio por Servientrega" });

  await assert.rejects(
    () => markOrderCanceled(businessId, orderId),
    (error: unknown) => {
      assert.ok(error instanceof TransicionNoPermitida);
      assert.match(error.message, /ya fue enviado/i);
      assert.match(error.message, /devuelto/i, "y le dice que hacer en su lugar");
      return true;
    },
  );

  // Y el pedido NO se movio.
  const fresco = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(fresco.fulfillmentStatus, "SHIPPED");
  assert.equal(fresco.canceledAt, null, "ni se escribio la fecha de cancelacion");
});

test("E31: re-enviar un pedido cancelado falla", async () => {
  const { businessId, orderId } = await pedido();
  await markOrderCanceled(businessId, orderId);

  await assert.rejects(() => markOrderShipped(businessId, orderId, {}), TransicionNoPermitida);

  const fresco = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(fresco.fulfillmentStatus, "CANCELED");
  assert.equal(fresco.shippedAt, null);
});

test("E31: cada transicion aceptada deja quien, de donde y a donde", async () => {
  const { businessId, orderId } = await pedido();
  await markOrderShipped(businessId, orderId, { note: "x" }, { tipo: "EMPLOYEE", etiqueta: "empleado@negocio.com" });
  await transicionarPedido({
    businessId,
    orderId,
    hacia: "DELIVERED",
    actor: { tipo: "JOB", etiqueta: "conciliacion" },
  });

  const eventos = await prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  assert.equal(eventos.length, 2);
  assert.equal(eventos[0].from, "PENDING");
  assert.equal(eventos[0].to, "SHIPPED");
  assert.equal(eventos[0].actor, "EMPLOYEE");
  assert.equal(eventos[0].actorLabel, "empleado@negocio.com");
  assert.equal(eventos[1].from, "SHIPPED");
  assert.equal(eventos[1].to, "DELIVERED");
  assert.equal(eventos[1].actor, "JOB");
});

test("E31: una transicion rechazada no deja evento", async () => {
  const { businessId, orderId } = await pedido();
  await markOrderCanceled(businessId, orderId);
  const antes = await prisma.orderEvent.count({ where: { orderId } });

  await assert.rejects(() => markOrderShipped(businessId, orderId, {}), TransicionNoPermitida);

  const despues = await prisma.orderEvent.count({ where: { orderId } });
  assert.equal(despues, antes, "lo que no paso no se registra");
});

test("E31: un pedido de otro negocio no se puede mover", async () => {
  const a = await pedido();
  const b = await pedido();
  const resultado = await transicionarPedido({
    businessId: b.businessId,
    orderId: a.orderId,
    hacia: "CANCELED",
    actor: { tipo: "OWNER" },
  });
  assert.equal(resultado, null, "devuelve null, como el resto del codigo para 'no es tuyo'");
  const fresco = await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } });
  assert.equal(fresco.fulfillmentStatus, "PENDING");
});
