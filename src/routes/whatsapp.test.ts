import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { handleOwnerReply } from "./whatsapp";
import type { WhatsappCredentials } from "../whatsapp/client";

// Regression tests for the owner-reply-without-quoting fix: previously ANY owner reply that didn't
// long-press "Responder" on a specific message was rejected outright ("No identifique a que mensaje te
// refieres"), even when there was exactly one thing open and no ambiguity to resolve. Owners on mobile
// frequently just reply inline without quoting.

let businessId: string;
let credentials: WhatsappCredentials;
let originalFetch: typeof fetch;
let sentMessages: { to: string; body: string }[];
let sentMedia: { to: string; type: string }[];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000001",
      contactName: "Owner",
    },
  });
  businessId = business.id;
  credentials = { phoneNumberId: "test-id", accessToken: "test-token" };
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  sentMedia = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") sentMessages.push({ to, body: body.text?.body ?? "" });
    if (body.type === "image" || body.type === "video") sentMedia.push({ to, type: body.type });
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function makeCustomerAndConversation() {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `57300${Date.now()}${Math.floor(Math.random() * 1000)}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true } });
  return { customer, conversation };
}

test("handleOwnerReply auto-resolves an unquoted reply when exactly one owner question is open", async () => {
  const { customer, conversation } = await makeCustomerAndConversation();
  const pending = await prisma.pendingOwnerQuestion.create({
    data: { conversationId: conversation.id, wamid: `wamid.q-${randomUUID()}`, question: "Cuanto cuesta el envio a Cali?" },
  });

  try {
    await handleOwnerReply(businessId, credentials, "573000000001", {
      type: "text",
      text: { body: "20 mil pesos" },
    });

    const sentToCustomer = sentMessages.find((m) => m.to === customer.phoneNumber);
    assert.ok(sentToCustomer, "expected the answer to be forwarded to the customer without a quote");
    assert.match(sentToCustomer!.body, /20 mil/);

    const stillPending = await prisma.pendingOwnerQuestion.findUnique({ where: { id: pending.id } });
    assert.equal(stillPending, null, "the question should be cleared once auto-resolved");

    const freshConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(freshConversation.humanControl, false);
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("handleOwnerReply asks to clarify (does not guess) when two things are open and no quote is given", async () => {
  const first = await makeCustomerAndConversation();
  const second = await makeCustomerAndConversation();
  const q1 = await prisma.pendingOwnerQuestion.create({
    data: { conversationId: first.conversation.id, wamid: `wamid.q1-${randomUUID()}`, question: "Pregunta A" },
  });
  const q2 = await prisma.pendingOwnerQuestion.create({
    data: { conversationId: second.conversation.id, wamid: `wamid.q2-${randomUUID()}`, question: "Pregunta B" },
  });

  try {
    await handleOwnerReply(businessId, credentials, "573000000001", {
      type: "text",
      text: { body: "la respuesta" },
    });

    const sentToOwner = sentMessages.find((m) => m.to === "573000000001");
    assert.ok(sentToOwner);
    assert.match(sentToOwner!.body, /citando/i);
    assert.match(sentToOwner!.body, /2/); // mentions there are 2 things open

    const stillQ1 = await prisma.pendingOwnerQuestion.findUnique({ where: { id: q1.id } });
    const stillQ2 = await prisma.pendingOwnerQuestion.findUnique({ where: { id: q2.id } });
    assert.ok(stillQ1, "must not guess and resolve either question when there's more than one open");
    assert.ok(stillQ2);
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: { in: [first.conversation.id, second.conversation.id] } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: [first.conversation.id, second.conversation.id] } } });
    await prisma.conversation.deleteMany({ where: { id: { in: [first.conversation.id, second.conversation.id] } } });
    await prisma.customer.deleteMany({ where: { id: { in: [first.customer.id, second.customer.id] } } });
  }
});

test("handleOwnerReply still resolves correctly via an explicit quoted message id (regression)", async () => {
  const { customer, conversation } = await makeCustomerAndConversation();
  const wamid = `wamid.q-${randomUUID()}`;
  await prisma.pendingOwnerQuestion.create({
    data: { conversationId: conversation.id, wamid, question: "Tienen envio a Medellin?" },
  });

  try {
    await handleOwnerReply(businessId, credentials, "573000000001", {
      type: "text",
      context: { id: wamid },
      text: { body: "Si, claro" },
    });

    const sentToCustomer = sentMessages.find((m) => m.to === customer.phoneNumber);
    assert.ok(sentToCustomer);
    assert.match(sentToCustomer!.body, /Si, claro/);
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("handleOwnerReply queues the resolved ask_owner exchange as a learned FAQ candidate", async () => {
  const { customer, conversation } = await makeCustomerAndConversation();
  const wamid = `wamid.q-${randomUUID()}`;
  await prisma.pendingOwnerQuestion.create({
    data: { conversationId: conversation.id, wamid, question: "Tienen envio a Barranquilla?" },
  });

  try {
    await handleOwnerReply(businessId, credentials, "573000000001", {
      type: "text",
      context: { id: wamid },
      text: { body: "Si, llega en 4 dias" },
    });

    const candidate = await prisma.learnedFaqCandidate.findFirst({ where: { businessId, question: "Tienen envio a Barranquilla?" } });
    assert.ok(candidate, "resolving an ask_owner question should queue it as a suggested FAQ entry");
    assert.equal(candidate!.answer, "Si, llega en 4 dias");
    assert.equal(candidate!.status, "PENDING");
  } finally {
    await prisma.learnedFaqCandidate.deleteMany({ where: { businessId } });
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// PHOTO_PRODUCT: owner is naming a product from a photo/video we couldn't identify (ask_owner_about_photo,
// src/ai/tools.ts), not answering a free-text question - handleOwnerReply must resolve their answer
// against the real catalog instead of just forwarding it raw, and must never queue it as a learned FAQ
// candidate (it's not a reusable text Q&A pair).

test("handleOwnerReply (PHOTO_PRODUCT) resolves the owner's answer to a real catalog product and sends its name, price and photo", async () => {
  const { customer, conversation } = await makeCustomerAndConversation();
  const product = await prisma.product.create({
    data: {
      businessId,
      name: `Audifono Bluetooth Negro ${randomUUID()}`,
      description: "Audifono inalambrico intraauricular",
      price: 89000,
      currency: "COP",
      stock: 4,
      media: { create: [{ type: "IMAGE", url: "https://example.com/audifono.jpg", s3Key: "audifono.jpg" }] },
    },
  });
  const wamid = `wamid.photo-${randomUUID()}`;
  await prisma.pendingOwnerQuestion.create({
    data: {
      conversationId: conversation.id,
      wamid,
      question: "Identificar el producto de la foto/video que mando el cliente",
      kind: "PHOTO_PRODUCT",
    },
  });

  try {
    await handleOwnerReply(businessId, credentials, "573000000001", {
      type: "text",
      context: { id: wamid },
      text: { body: product.name },
    });

    const sentToCustomer = sentMessages.find((m) => m.to === customer.phoneNumber);
    assert.ok(sentToCustomer, "expected the customer to get a confirmation message");
    assert.match(sentToCustomer!.body, /Según nuestro equipo/);
    assert.match(sentToCustomer!.body, new RegExp(product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const photoSent = sentMedia.find((m) => m.to === customer.phoneNumber && m.type === "image");
    assert.ok(photoSent, "expected the real catalog photo to be sent, not just text");

    const stillPending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.equal(stillPending, null);

    const freshConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(freshConversation.humanControl, false);

    const faqCandidate = await prisma.learnedFaqCandidate.findFirst({ where: { businessId, question: { contains: "foto" } } });
    assert.equal(faqCandidate, null, "a photo identification must never be queued as a reusable FAQ suggestion");
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.product.delete({ where: { id: product.id } });
  }
});

test("handleOwnerReply (PHOTO_PRODUCT) falls back to the owner's raw (prefixed) text when it doesn't match any catalog product", async () => {
  const { customer, conversation } = await makeCustomerAndConversation();
  const wamid = `wamid.photo-${randomUUID()}`;
  await prisma.pendingOwnerQuestion.create({
    data: {
      conversationId: conversation.id,
      wamid,
      question: "Identificar el producto de la foto/video que mando el cliente",
      kind: "PHOTO_PRODUCT",
    },
  });

  try {
    await handleOwnerReply(businessId, credentials, "573000000001", {
      type: "text",
      context: { id: wamid },
      text: { body: "no se ve claro, no tenemos nada asi" },
    });

    const sentToCustomer = sentMessages.find((m) => m.to === customer.phoneNumber);
    assert.ok(sentToCustomer);
    assert.match(sentToCustomer!.body, /Según nuestro equipo: no se ve claro/);

    const photoSent = sentMedia.find((m) => m.to === customer.phoneNumber);
    assert.equal(photoSent, undefined, "must not send any photo when the owner's answer didn't resolve to a real product");
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("handleOwnerReply tells the owner nothing is pending when there's zero open items and no quote", async () => {
  await handleOwnerReply(businessId, credentials, "573000000001", {
    type: "text",
    text: { body: "hola" },
  });

  const sentToOwner = sentMessages.find((m) => m.to === "573000000001");
  assert.ok(sentToOwner);
  assert.match(sentToOwner!.body, /No identifique/i);
});

// Real DeepSeek call (no mocking) - covers the fix where the deterministic owner-confirms-payment path
// used to always send one hardcoded generic closing string, ignoring a business's own closing script
// defined in customInstructions (e.g. MAG.IMP's "Etapa 4: Cierre Oficial" template with placeholders).
test("handleOwnerReply confirms payment and follows the business's own closing script from customInstructions, filling in real order data", async () => {
  const business2 = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000002",
      contactName: "Owner2",
      customInstructions: `Etapa de cierre (REGLA MANDATORIA): una vez el pago este confirmado, cierra la
conversacion enviando UNICAMENTE este mensaje exacto, reemplazando los placeholders con los datos reales
del pedido, sin agregar ni modificar nada mas:
"Listo [Nombre del cliente], tu pedido por un total de [Total] quedo cerrado. Gracias por tu compra."`,
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business2.id, phoneNumber: `57300${Date.now()}9`, name: "Camila" },
  });
  const wamid = `wamid.confirm-${randomUUID()}`;
  const conversation = await prisma.conversation.create({
    data: {
      customerId: customer.id,
      pendingConfirmationMessageId: wamid,
      pendingOrderSummary: "1x Producto Test",
      pendingOrderItems: {
        items: [{ productId: "test-product-id", productName: "Producto Test", quantity: 1, unitPrice: 50000, currency: "COP" }],
        shippingAddress: "Calle 1, Bogota",
        paymentMethodLabel: "Nequi",
        shippingCost: 0,
      },
    },
  });

  try {
    await handleOwnerReply(business2.id, credentials, "573000000002", {
      type: "text",
      text: { body: "si" },
      context: { id: wamid },
    });

    const sentToCustomer = sentMessages.find((m) => m.to === customer.phoneNumber);
    assert.ok(sentToCustomer, "expected a closing message sent to the customer");
    assert.match(sentToCustomer!.body, /Camila/, "must use the business's own template, filled with the real customer name");
    assert.match(sentToCustomer!.body, /50\s?\.?000/, "must fill in the real order total, not a placeholder");

    const order = await prisma.order.findUnique({ where: { conversationId: conversation.id } });
    assert.ok(order, "expected an order to actually be created");
  } finally {
    await prisma.order.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});
