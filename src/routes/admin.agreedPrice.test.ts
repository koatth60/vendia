import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../db/client";
import { conversationsRouter } from "./admin/conversations";
import { runCatalogTool, type ToolContext } from "../ai/tools";

// EL PRECIO ACORDADO (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, seccion 12) - EL CAMINO SIN MODELO.
//
// La regla de admision de efectos requeridos exige un fallback que el servidor pueda hacer solo, con
// datos de la base. Este es: la duena fija el precio desde el panel, sobre la venta abierta, sin pasar
// por el chat y sin que intervenga el agente ni la interpretacion de ninguna respuesta.
//
// Se levanta el router real sobre un servidor real; lo unico simulado es el login.

let server: import("node:http").Server;
let baseUrl: string;
let businessId: string;
let otroBusinessId: string;
let customerId: string;
let conversationId: string;
let airpodsId: string;
let ajenoId: string;
let sessionBusinessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `P ${randomUUID()}`, email: `p-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const otro = await prisma.business.create({
    data: { name: `O ${randomUUID()}`, email: `o-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  otroBusinessId = otro.id;
  airpodsId = (
    await prisma.product.create({
      data: { businessId, name: "AIRPODS PRO 3", description: "Audifonos", price: 75000, currency: "COP", stock: 5 },
    })
  ).id;
  ajenoId = (
    await prisma.product.create({
      data: { businessId, name: "PARLANTE TIPO ALEXA", description: "Parlante", price: 70000, currency: "COP", stock: 5 },
    })
  ).id;
  customerId = (await prisma.customer.create({ data: { businessId, phoneNumber: `573006${Date.now()}` } })).id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId: string } }).session = { businessId: sessionBusinessId };
    next();
  });
  app.use(conversationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otroBusinessId] } } });
});

beforeEach(async () => {
  sessionBusinessId = businessId;
  await prisma.agreedPrice.deleteMany({ where: { conversation: { customerId } } });
  await prisma.saleState.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  conversationId = (await prisma.conversation.create({ data: { customerId } })).id;
  // La venta abierta la escribe el SERVIDOR (SaleState.items), no el panel: set_order_item la llena
  // contra el catalogo real. El panel solo pone el numero.
  const context: ToolContext = {
    businessId,
    conversationId,
    customerId,
    credentials: { phoneNumberId: "x", accessToken: "y" },
    recipientPhone: "573001112266",
  };
  await runCatalogTool(context, "set_order_item", { productId: airpodsId, quantity: 1 });
});

test("el panel lista la venta abierta con el precio de catalogo y sin precio acordado todavia", async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { items: { productId: string; listPrice: number; agreedPrice: number | null }[] };
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].productId, airpodsId);
  assert.equal(data.items[0].listPrice, 75000);
  assert.equal(data.items[0].agreedPrice, null);
});

test("la duena fija el precio desde el panel y queda escrito como ADMIN_PANEL", async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: airpodsId, variantKey: "", unitPrice: 70000 }] }),
  });
  assert.equal(res.status, 200);
  const fila = await prisma.agreedPrice.findFirstOrThrow({ where: { conversationId, productId: airpodsId } });
  assert.equal(Number(fila.unitPrice), 70000);
  assert.equal(fila.source, "ADMIN_PANEL");
});

test("el panel usa las MISMAS validaciones que el camino de WhatsApp: por encima del catalogo, 400", async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: airpodsId, variantKey: "", unitPrice: 90000 }] }),
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 0);

  const cero = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: airpodsId, variantKey: "", unitPrice: 0 }] }),
  });
  assert.equal(cero.status, 400);
  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 0);
});

test("el panel no puede fijarle precio a un producto que no esta en la venta abierta", async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: ajenoId, variantKey: "", unitPrice: 60000 }] }),
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 0);
});

test("dejar el precio vacio devuelve el item al precio de catalogo", async () => {
  await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: airpodsId, variantKey: "", unitPrice: 70000 }] }),
  });
  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 1);

  await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: airpodsId, variantKey: "", unitPrice: null }] }),
  });
  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 0);
});

test("otro negocio no puede leer ni escribir el precio acordado de esta conversacion", async () => {
  sessionBusinessId = otroBusinessId;
  const leer = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`);
  assert.equal(leer.status, 404);
  const escribir = await fetch(`${baseUrl}/api/conversations/${conversationId}/agreed-prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices: [{ productId: airpodsId, variantKey: "", unitPrice: 1000 }] }),
  });
  assert.equal(escribir.status, 404);
  assert.equal(await prisma.agreedPrice.count({ where: { conversationId } }), 0);
});
