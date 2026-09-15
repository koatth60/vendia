import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { prisma } from "../db/client";
import { conversationsRouter } from "./admin/conversations";

// Fase 8, punto 3 del plan maestro (2026-09-15). Criterio de aceptacion textual: "una prueba que
// intente leer desde el negocio A una conversacion del negocio B y reciba 404".
//
// Se levanta el router real sobre un servidor real y se le inyecta la sesion del negocio A. Lo unico
// simulado es el login: el resto (rutas, consultas, respuestas) es el codigo de produccion.

let server: import("node:http").Server;
let baseUrl: string;
let businessA: string;
let businessB: string;
let conversationOfB: string;
let queuedOfB: string;
let customerB: string;
let customerA: string;
let conversationOfA: string;
let queuedOfA: string;
let sessionBusinessId: string;

before(async () => {
  const a = await prisma.business.create({
    data: { name: `A ${randomUUID()}`, email: `a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const b = await prisma.business.create({
    data: { name: `B ${randomUUID()}`, email: `b-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessA = a.id;
  businessB = b.id;

  const customer = await prisma.customer.create({ data: { businessId: businessB, phoneNumber: `573007${Date.now()}` } });
  customerB = customer.id;
  const conversation = await prisma.conversation.create({ data: { customerId: customerB } });
  conversationOfB = conversation.id;
  const queued = await prisma.queuedOutboundMessage.create({
    data: { businessId: businessB, conversationId: conversationOfB, body: "texto privado del negocio B", origin: "PANEL" },
  });
  queuedOfB = queued.id;

  // El negocio A tambien tiene lo suyo: sin esto no se puede reproducir la fuga real, que necesita un
  // queuedId propio (para que la cancelacion pase el filtro por negocio) y un conversationId ajeno.
  const ownCustomer = await prisma.customer.create({
    data: { businessId: businessA, phoneNumber: `573008${Date.now()}` },
  });
  customerA = ownCustomer.id;
  conversationOfA = (await prisma.conversation.create({ data: { customerId: customerA } })).id;
  queuedOfA = (
    await prisma.queuedOutboundMessage.create({
      data: { businessId: businessA, conversationId: conversationOfA, body: "texto del negocio A", origin: "PANEL" },
    })
  ).id;

  const app = express();
  app.use(express.json());
  // Sesion inyectada: cada prueba decide como que negocio entra.
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
  await prisma.queuedOutboundMessage.deleteMany({ where: { businessId: { in: [businessA, businessB] } } });
  await prisma.message.deleteMany({ where: { conversation: { customerId: { in: [customerA, customerB] } } } });
  await prisma.conversation.deleteMany({ where: { customerId: { in: [customerA, customerB] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [customerA, customerB] } } });
  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
});

test("el negocio A no puede leer una conversacion del negocio B: recibe 404", async () => {
  sessionBusinessId = businessA;
  const response = await fetch(`${baseUrl}/api/conversations/${conversationOfB}`);
  assert.equal(response.status, 404);

  // Y el negocio dueno si la ve - si no, el 404 de arriba no probaria nada.
  sessionBusinessId = businessB;
  const owner = await fetch(`${baseUrl}/api/conversations/${conversationOfB}`);
  assert.equal(owner.status, 200);
});

test("el negocio A no puede leer la cola de salida de una conversacion del negocio B", async () => {
  sessionBusinessId = businessA;
  // La fuga real: el queuedId es PROPIO de A (asi la cancelacion pasa el filtro por negocio y la ruta
  // llega a responder), pero el conversationId es de B. Antes de la Fase 8 la respuesta incluia
  // listQueuedOutbound(req.params.id) con ese id crudo, o sea la cola de salida del negocio B.
  const response = await fetch(`${baseUrl}/api/conversations/${conversationOfB}/queued/${queuedOfA}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 404, "esta era la ruta del IDOR: usaba req.params.id sin validarlo");

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(
    JSON.stringify(body).includes("texto privado del negocio B"),
    false,
    "la respuesta no puede contener nada de la cola del otro negocio"
  );

  // Y la validacion corre ANTES de cancelar: el mensaje propio de A sigue vivo, no se consumio en el
  // intento.
  const ownStillQueued = await prisma.queuedOutboundMessage.findUniqueOrThrow({ where: { id: queuedOfA } });
  assert.equal(ownStillQueued.cancelledAt, null);
  const stillQueuedB = await prisma.queuedOutboundMessage.findUniqueOrThrow({ where: { id: queuedOfB } });
  assert.equal(stillQueuedB.cancelledAt, null);
});

test("el negocio dueno si puede cancelar lo suyo por esa misma ruta", async () => {
  sessionBusinessId = businessB;
  const response = await fetch(`${baseUrl}/api/conversations/${conversationOfB}/queued/${queuedOfB}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; queuedOutbound: unknown[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.queuedOutbound, [], "ya no queda nada en cola");
});
