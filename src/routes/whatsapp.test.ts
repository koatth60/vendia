import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { handleOwnerReply } from "./whatsapp";
import type { WhatsappCredentials } from "../whatsapp/outbound";

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

// Fase 7: todo envio libre a un cliente pasa por la ventana de 24h de WhatsApp, que se mide contra su
// ultimo mensaje. Una conversacion real siempre tiene uno; sin el, la capa de salida da la ventana por
// cerrada, y con razon. `lastCustomerMessage` es ese mensaje: los casos que escalan una pregunta le
// pasan la pregunta real del cliente, que es lo que el dueno esta contestando.
async function makeCustomerAndConversation(lastCustomerMessage = "Hola") {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `57300${Date.now()}${Math.floor(Math.random() * 1000)}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true } });
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: lastCustomerMessage } });
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

    // E56 (2026-09-17): resolver es MARCAR, no borrar. La fila se queda con resolvedAt puesto - es la
    // prueba de que al dueño se le aviso (ownerWasNotifiedSince) y el par pregunta/respuesta del que
    // aprende la FAQ. Lo que tiene que dejar de ser cierto es que siga ABIERTA.
    const stillPending = await prisma.pendingOwnerQuestion.findUnique({ where: { id: pending.id } });
    assert.ok(stillPending, "the question row must survive, only marked resolved");
    assert.ok(stillPending!.resolvedAt, "the question should be marked resolved once auto-resolved");

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
  const { customer, conversation } = await makeCustomerAndConversation("Tienen envio a Barranquilla?");
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

    // E56: marcada resuelta, no borrada (ver la nota mas arriba). Para ask_owner_about_photo esto
    // ademas es lo que impide que el turno siguiente vuelva a exigir el aviso y a reenviar la misma
    // identificacion de producto al cliente.
    const stillPending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.ok(stillPending?.resolvedAt, "the photo question should be marked resolved, and its row kept");

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

// La prueba que estaba aca (el dueño confirma el pago y el cierre sigue el guion de
// customInstructions) llamaba a DeepSeek DE VERDAD desde un archivo .test.ts, asi que `npm test` la
// pagaba en cada push. Se movio a src/routes/whatsapp.ownerClosingPaid.ts el 2026-09-18 y corre con
// `npm run test:paid`. Las 8 que quedan no llaman al modelo: medido con una key invalida, pasan las 8.

// Fase B of the 2026-09-13 audit (F3): the customer-facing send at the old ":125" call site had no
// try/catch, so a delivery failure (typically the customer's 24h service window closed while the owner
// took a while to reply) threw mid-function - clearPendingOwnerQuestion/setHumanControl never ran (the
// conversation got stuck forever) and the owner still got the false "Listo, le reenvie tu respuesta ✅".
test("handleOwnerReply tells the owner the truth and nudges via template when the customer can't be reached directly", async () => {
  const business3 = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000003",
      contactName: "Owner3",
      followUpTemplateName: "reenganche_generico",
      followUpTemplateLanguage: "es",
    },
  });
  const customer = await prisma.customer.create({ data: { businessId: business3.id, phoneNumber: `57300${Date.now()}1` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true } });
  const pending = await prisma.pendingOwnerQuestion.create({
    data: { conversationId: conversation.id, wamid: `wamid.q-${randomUUID()}`, question: "Tienen talla M?" },
  });

  const sentTemplates: { to: string; name: string }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text" && to === customer.phoneNumber) {
      return { ok: false, status: 470, text: async () => JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }) } as Response;
    }
    if (body.type === "text") sentMessages.push({ to, body: body.text?.body ?? "" });
    if (body.type === "template") {
      sentTemplates.push({ to, name: body.template?.name ?? "" });
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.tpl-${randomUUID()}` }] }) } as Response;
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;

  try {
    await handleOwnerReply(business3.id, credentials, "573000000003", {
      type: "text",
      context: { id: pending.wamid },
      text: { body: "si, tenemos talla M" },
    });

    assert.equal(sentTemplates.length, 1, "must nudge the customer via the business's follow-up template");
    assert.equal(sentTemplates[0].to, customer.phoneNumber);
    assert.equal(sentTemplates[0].name, "reenganche_generico");

    const sentToOwner = sentMessages.find((m) => m.to === "573000000003");
    assert.ok(sentToOwner, "owner must still get a confirmation message");
    assert.doesNotMatch(sentToOwner!.body, /Listo, le reenvie tu respuesta/, "must not lie about delivery when it failed");
    assert.match(sentToOwner!.body, /24h|aviso/i);

    // Despite the delivery failure, the owner's side of the job is done - the question must not stay
    // stuck open forever (that would just create ANOTHER permanently-muted conversation). E56: cerrada
    // quiere decir resolvedAt puesto; la fila se conserva.
    const stillPending = await prisma.pendingOwnerQuestion.findUnique({ where: { id: pending.id } });
    assert.ok(stillPending?.resolvedAt, "the question must be marked resolved even when delivery failed");
    const freshConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(freshConversation.humanControl, false);

    const failure = await prisma.deliveryFailure.findFirst({ where: { businessId: business3.id, recipientPhone: customer.phoneNumber } });
    assert.ok(failure, "the failed delivery must be visible in the delivery-failures log");
  } finally {
    await prisma.deliveryFailure.deleteMany({ where: { businessId: business3.id } });
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.business.deleteMany({ where: { id: business3.id } });
  }
});
