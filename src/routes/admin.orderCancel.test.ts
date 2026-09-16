import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { adminRouter } from "./admin";

// Covers PUT /api/orders/:id/cancel - before this fix it only updated fulfillmentStatus, the customer
// never found out their order was canceled. Real HTTP through the router, fake session injected
// directly (no cookie jar needed), only the outbound WhatsApp Graph API call is stubbed.

let server: Server;
let baseUrl: string;
let businessId: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId?: string; role?: string } }).session = { businessId, role: "OWNER" };
    next();
  });
  app.use(adminRouter);
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

let originalFetch: typeof fetch;
let sentTexts: { to: string; body: string }[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sentTexts = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedOrder() {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
    },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, phoneNumber: `573004${Date.now()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  // Fase 7: todo envio libre a un cliente pasa por la ventana de 24h de WhatsApp, que se mide contra su
  // ultimo mensaje. Una conversacion real siempre tiene uno; sin el, la capa de salida da la ventana
  // por cerrada y con razon.
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Hola" } });
  const order = await prisma.order.create({
    data: { businessId: business.id, customerId: customer.id, conversationId: conversation.id, summary: "1x Smartwatch", totalAmount: 145000, currency: "COP" },
  });
  return { business, customer, conversation, order };
}

async function cleanup(businessIdToClean: string, conversationId: string) {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.order.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { businessId: businessIdToClean } });
  await prisma.business.deleteMany({ where: { id: businessIdToClean } });
}

test("PUT /api/orders/:id/cancel notifies the customer by WhatsApp before canceling", async () => {
  const { business, customer, conversation, order } = await seedOrder();
  businessId = business.id;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("graph.facebook.com")) return originalFetch(url as string, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "text") sentTexts.push({ to: body.to, body: body.text?.body ?? "" });
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;

  try {
    const res = await fetch(`${baseUrl}/api/orders/${order.id}/cancel`, { method: "PUT" });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, true);

    assert.equal(sentTexts.length, 1, "customer must be notified");
    assert.equal(sentTexts[0].to, customer.phoneNumber);
    assert.match(sentTexts[0].body, /cancelad/i);

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(updated.fulfillmentStatus, "CANCELED");
    assert.ok(updated.canceledAt);

    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    assert.equal(messages.length, 1, "the cancellation notice must be recorded in the conversation history");
  } finally {
    await cleanup(business.id, conversation.id);
  }
});

test("PUT /api/orders/:id/cancel returns 404 for a nonexistent order", async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  try {
    const res = await fetch(`${baseUrl}/api/orders/does-not-exist/cancel`, { method: "PUT" });
    assert.equal(res.status, 404);
  } finally {
    await prisma.business.deleteMany({ where: { id: business.id } });
  }
});
