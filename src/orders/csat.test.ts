import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { askForCsat, recordCsatReply } from "./service";

let businessId: string;
let customerId: string;
let customerPhone: string;
let orderId: string;
let originalFetch: typeof fetch;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;

  customerPhone = `573000${Date.now()}`;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: customerPhone } });
  customerId = customer.id;

  const conversation = await prisma.conversation.create({ data: { customerId } });
  // Fase 7: todo envio libre a un cliente pasa por la ventana de 24h de WhatsApp, que se mide contra su
  // ultimo mensaje. Una conversacion real siempre tiene uno; sin el, la capa de salida da la ventana
  // por cerrada y con razon.
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Hola" } });

  const order = await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: conversation.id,
      summary: "1x producto de prueba",
      totalAmount: 50000,
      currency: "COP",
    },
  });
  orderId = order.id;
});

after(async () => {
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }),
  })) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("recordCsatReply is a no-op before askForCsat was ever sent", async () => {
  const result = await recordCsatReply(businessId, customerPhone, "csat_3");
  assert.equal(result.recorded, false);
});

test("askForCsat then recordCsatReply records the rating exactly once", async () => {
  stubWhatsappFetch();
  try {
    await askForCsat({ phoneNumberId: "test-id", accessToken: "test-token" }, orderId, customerPhone);
  } finally {
    restoreFetch();
  }

  const first = await recordCsatReply(businessId, customerPhone, "csat_2");
  assert.equal(first.recorded, true);

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.csatRating, 2);

  // A second reply shouldn't overwrite it - the order no longer matches the
  // "csatAskedAt set, csatRating null" query.
  const second = await recordCsatReply(businessId, customerPhone, "csat_1");
  assert.equal(second.recorded, false);
  const unchanged = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(unchanged.csatRating, 2);
});

test("recordCsatReply ignores an unknown button id", async () => {
  const result = await recordCsatReply(businessId, customerPhone, "confirm_yes");
  assert.equal(result.recorded, false);
});
