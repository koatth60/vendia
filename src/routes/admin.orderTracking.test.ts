import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../db/client";
import { ordersRouter } from "./admin/orders";
import { buildCustomerCommerceState } from "../orders/customerCommerceState";

// E35 (2026-09-18). El pedido sabe dónde está.
//
// Medido en producción el mismo día: 55 mensajes de esa base mencionan guía, rastreo o una
// transportadora, y 6 clientas preguntan "cuándo llega". Nada de eso era un dato: la dueña lo escribía
// a mano en el chat, uno por uno, y el bot no tenía de dónde leerlo.

let server: import("node:http").Server;
let baseUrl: string;
let businessId: string;
let otroBusinessId: string;
let customerId: string;
let conversationId: string;
let orderId: string;
let ajenoOrderId: string;
let sessionBusinessId: string;
let sessionRole: string;

async function crearPedido(deBusinessId: string) {
  const customer = await prisma.customer.create({ data: { businessId: deBusinessId, phoneNumber: `5730071${Date.now()}${Math.floor(Math.random() * 90 + 10)}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  const order = await prisma.order.create({
    data: {
      businessId: deBusinessId,
      customerId: customer.id,
      conversationId: conversation.id,
      summary: "1x RELOJ GEN 9",
      totalAmount: 59900,
      currency: "COP",
    },
  });
  return { customerId: customer.id, conversationId: conversation.id, orderId: order.id };
}

before(async () => {
  businessId = (
    await prisma.business.create({ data: { name: `B ${randomUUID()}`, email: `b-${randomUUID()}@example.com`, passwordHash: "x" } })
  ).id;
  otroBusinessId = (
    await prisma.business.create({ data: { name: `O ${randomUUID()}`, email: `o-${randomUUID()}@example.com`, passwordHash: "x" } })
  ).id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId: string; role: string; email: string } }).session = {
      businessId: sessionBusinessId,
      role: sessionRole,
      email: "duena@example.com",
    };
    next();
  });
  app.use(ordersRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.order.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId: { in: [businessId, otroBusinessId] } } } });
  await prisma.customer.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otroBusinessId] } } });
});

beforeEach(async () => {
  sessionBusinessId = businessId;
  sessionRole = "OWNER";
  await prisma.order.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId: { in: [businessId, otroBusinessId] } } } });
  await prisma.customer.deleteMany({ where: { businessId: { in: [businessId, otroBusinessId] } } });

  const mio = await crearPedido(businessId);
  customerId = mio.customerId;
  conversationId = mio.conversationId;
  orderId = mio.orderId;
  ajenoOrderId = (await crearPedido(otroBusinessId)).orderId;
});

function guardar(id: string, cuerpo: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/orders/${id}/tracking`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
}

test("la dueña carga la guía y queda en el pedido", async () => {
  const res = await guardar(orderId, {
    carrier: "Interrapidisimo",
    trackingNumber: "240011223344",
    estimatedDelivery: "2026-09-22",
    paymentStatus: "PAID",
    paymentReference: "Nequi 5512",
  });
  assert.equal(res.status, 200);

  const guardado = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(guardado.carrier, "Interrapidisimo");
  assert.equal(guardado.trackingNumber, "240011223344");
  assert.equal(guardado.estimatedDelivery?.toISOString().slice(0, 10), "2026-09-22");
  assert.equal(guardado.paymentStatus, "PAID");
  assert.equal(guardado.paymentReference, "Nequi 5512");
});

// Es el mismo criterio de E46 y de las tarifas de envío: un formulario que manda medio payload no
// puede borrar lo que ya estaba.
test("lo que no viene en el payload no se borra", async () => {
  await guardar(orderId, { carrier: "Servientrega", trackingNumber: "999" });
  await guardar(orderId, { paymentStatus: "PARTIAL" });

  const guardado = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(guardado.carrier, "Servientrega", "mandar solo el pago no puede borrar la transportadora");
  assert.equal(guardado.trackingNumber, "999");
  assert.equal(guardado.paymentStatus, "PARTIAL");
});

test("un campo vacío sí borra el dato, que no es lo mismo que no mandarlo", async () => {
  await guardar(orderId, { carrier: "Servientrega" });
  await guardar(orderId, { carrier: "" });
  const guardado = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(guardado.carrier, null);
});

test("un dato con mala forma no se guarda", async () => {
  assert.equal((await guardar(orderId, { estimatedDelivery: "la semana que viene" })).status, 400);
  assert.equal((await guardar(orderId, { paymentStatus: "CASI" })).status, 400);
  assert.equal((await guardar(orderId, {})).status, 400);

  const guardado = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(guardado.estimatedDelivery, null);
  assert.equal(guardado.paymentStatus, "UNPAID");
});

test("el pedido de otro negocio no se toca desde esta sesión", async () => {
  const res = await guardar(ajenoOrderId, { carrier: "Interrapidisimo" });
  assert.equal(res.status, 404);
  const ajeno = await prisma.order.findUniqueOrThrow({ where: { id: ajenoOrderId } });
  assert.equal(ajeno.carrier, null);
});

// Cargar la guía es trabajo de quien despacha, igual que marcar enviado (decisión D5). Cancelar sigue
// siendo del dueño.
test("un empleado puede cargar la guía", async () => {
  sessionRole = "EMPLOYEE";
  assert.equal((await guardar(orderId, { trackingNumber: "777" })).status, 200);
});

// LO QUE HACE QUE LA ETAPA SIRVA: que el bot lo lea.
test("el bot ve la guía como dato del pedido, y sólo lo que existe", async () => {
  const conGuia = buildCustomerCommerceState(
    {
      orders: [
        {
          conversationId,
          summary: "1x RELOJ GEN 9",
          totalAmount: 59900,
          currency: "COP",
          fulfillmentStatus: "SHIPPED",
          createdAt: new Date("2026-09-18"),
          carrier: "Interrapidisimo",
          trackingNumber: "240011223344",
          estimatedDelivery: new Date("2026-09-22"),
          paymentStatus: "PAID",
        },
      ],
      conversations: [],
    },
    conversationId,
    { currency: "COP", locale: "es-CO" },
  );
  assert.equal(conGuia.pedidos[0].transportadora, "Interrapidisimo");
  assert.equal(conGuia.pedidos[0].guia, "240011223344");
  assert.equal(conGuia.pedidos[0].entregaEstimada, "2026-09-22");
  assert.equal(conGuia.pedidos[0].pago, "pagado");

  const sinGuia = buildCustomerCommerceState(
    {
      orders: [
        {
          conversationId,
          summary: "1x RELOJ GEN 9",
          totalAmount: 59900,
          currency: "COP",
          fulfillmentStatus: "PENDING",
          createdAt: new Date("2026-09-18"),
        },
      ],
      conversations: [],
    },
    conversationId,
    { currency: "COP", locale: "es-CO" },
  );
  // Un pedido sin guía no manda `guia: null`: no manda nada. Lo que no se sabe no ocupa tokens y no le
  // deja al modelo un hueco que rellenar.
  assert.equal("guia" in sinGuia.pedidos[0], false);
  assert.equal("transportadora" in sinGuia.pedidos[0], false);
  assert.equal("pago" in sinGuia.pedidos[0], false);
});
