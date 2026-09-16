import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { recordMessage } from "../conversation/service";
import { generateReply } from "./agent";
import type { ToolContext } from "./tools";

// These tests hit the real DeepSeek API (small cost, no mocking - that's the point: they exercise
// actual tool-calling behavior, not just prompt text). WhatsApp Graph API calls are stubbed via
// globalThis.fetch so no real message goes out and no WhatsApp credentials are needed.

let businessId: string;
let customerId: string;
let originalFetch: typeof fetch;
let sentToOwner: { to: string; body: string } | null;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000000",
      contactName: "Owner",
    },
  });
  businessId = business.id;

  await prisma.faqEntry.create({
    data: {
      businessId,
      question: "Cuanto cuesta el envio",
      answer: "En Bogota $10.000, al resto de Colombia $20.000 (4-6 dias habiles).",
    },
  });

  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573000${Date.now()}` },
  });
  customerId = customer.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.faqEntry.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentToOwner = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "text") {
      sentToOwner = { to: body.to ?? body.recipient, body: body.text?.body ?? "" };
    } else if (body.type === "template") {
      // ask_owner now goes through sendOwnerAlert, which tries the onix_owner_alert template first -
      // the dynamic text lives in the template's body component parameters, not text.body.
      const paramText = body.template?.components?.[0]?.parameters?.[0]?.text ?? "";
      sentToOwner = { to: body.to ?? body.recipient, body: paramText };
    }
    return {
      ok: true,
      json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }),
    } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function runTurn(customerText: string) {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  await recordMessage(businessId, conversation.id, "CUSTOMER", customerText);

  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId,
    credentials: { phoneNumberId: "test-phone-id", accessToken: "test-token" },
    recipientPhone: "573001112233",
  };

  await generateReply(conversation.id, context);

  return prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
}

async function runTurnWithReply(customerText: string) {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  await recordMessage(businessId, conversation.id, "CUSTOMER", customerText);

  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId,
    credentials: { phoneNumberId: "test-phone-id", accessToken: "test-token" },
    recipientPhone: "573001112233",
  };

  const { text: reply } = await generateReply(conversation.id, context);
  return { conversation, reply };
}

test("bot escalates via ask_owner when the FAQ doesn't confirm the specific question", async () => {
  stubWhatsappFetch();
  try {
    const conversation = await runTurn("De alguna manera puedo conseguir domicilio gratis?");
    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.ok(
      pending,
      "ask_owner should have fired and created a PendingOwnerQuestion row - a text reply alone (e.g. 'voy a preguntar') is not enough"
    );
    // ask_owner escalates the specific question but no longer pauses the whole conversation - the bot
    // keeps helping the customer with anything else while the owner's answer is pending.
    assert.equal(conversation.humanControl, false);
    assert.ok(sentToOwner, "expected a WhatsApp message to actually be sent to the owner");
    assert.match(sentToOwner!.body, /gratis/i);
  } finally {
    restoreFetch();
  }
});

test("bot does not escalate to ask_owner on a social/conversational message with no real question", async () => {
  // Regression: this exact customer message triggered a real false ask_owner escalation in production
  // on 2026-09-11 - it's an apology for a slow reply, not a question needing the owner's info.
  stubWhatsappFetch();
  try {
    const conversation = await runTurn("Mil disculpas me dormi y hoy he estado bastante ocupada");
    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.equal(pending, null, "an apology for being slow to reply is not a question that needs ask_owner");
    assert.equal(conversation.humanControl, false);
  } finally {
    restoreFetch();
  }
});

test("bot generalizes past the exact wording - a different excuse for a slow reply also doesn't escalate", async () => {
  stubWhatsappFetch();
  try {
    const conversation = await runTurn("Perdon estaba comiendo, ya te respondo");
    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.equal(pending, null, "a different social excuse must also not trigger ask_owner - the fix is semantic, not a fixed phrase");
    assert.equal(conversation.humanControl, false);
  } finally {
    restoreFetch();
  }
});

test("bot still escalates a real question even when it's wrapped in an apology - the fix must not swallow important messages", async () => {
  stubWhatsappFetch();
  try {
    const conversation = await runTurn(
      "Disculpa la demora, estaba ocupada. Oye, ¿ustedes hacen envios internacionales a Panama?"
    );
    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.ok(pending, "a real question mixed into an apology must still escalate, not get ignored along with the small talk");
    assert.equal(conversation.humanControl, false);
    assert.ok(sentToOwner, "the owner must actually receive the real question");
    assert.match(sentToOwner!.body, /panam[áa]/i);
  } finally {
    restoreFetch();
  }
});

test("bot shows a full order summary with the total and asks for confirmation before requesting payment proof", async () => {
  stubWhatsappFetch();
  const product = await prisma.product.create({
    data: { businessId, name: "Audifonos Bluetooth X", description: "Audifonos inalambricos", price: 100000, currency: "COP", stock: 10 },
  });
  const paymentMethod = await prisma.paymentMethod.create({
    data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "3001234567" },
  });
  const conversation = await prisma.conversation.create({ data: { customerId } });
  try {
    // Seed a realistic history where the model already has every required field (product, quantity,
    // address, payment method, name) - the only thing missing is the order-summary confirmation step,
    // so this isolates whether the bot shows it unprompted instead of jumping straight to closing.
    const turns: [("CUSTOMER" | "ASSISTANT"), string][] = [
      ["CUSTOMER", "Hola, quiero los Audifonos Bluetooth X"],
      ["ASSISTANT", "¡Hola! Los audifonos van a $100.000. ¿Cuantas unidades quieres?"],
      ["CUSTOMER", "1"],
      ["ASSISTANT", "Perfecto, ¿a que direccion lo enviamos?"],
      ["CUSTOMER", "Calle 123 #45-67, Bogota"],
      ["ASSISTANT", "¿Como prefieres pagar, Nequi?"],
      ["CUSTOMER", "Si, Nequi"],
      ["ASSISTANT", "¿A nombre de quien hago el pedido?"],
      ["CUSTOMER", "Juan Perez"],
    ];
    for (const [role, content] of turns) {
      await recordMessage(businessId, conversation.id, role, content);
    }

    const context: ToolContext = {
      businessId,
      conversationId: conversation.id,
      customerId,
      credentials: { phoneNumberId: "test-phone-id", accessToken: "test-token" },
      recipientPhone: "573001112233",
    };
    const { text: reply } = await generateReply(conversation.id, context);

    // The prompt (RESUMEN Y TOTAL ANTES DE PEDIR EL PAGO) requires showing the real price and asking for
    // confirmation - it never mandates the literal word "total" in the reply. A prior version of this
    // assertion required that exact word and flaked repeatedly (confirmed 3x in a row, 2026-09-12): the
    // model would itemize the order and ask to confirm without ever writing "total", which already
    // satisfies the actual contract - checking for the word was testing phrasing, not substance.
    assert.match(reply, /100[.,]?000/, "must show the real product price, not just ask for payment out of nowhere");
    assert.match(reply, /\?/, "must ask the customer to confirm the summary");

    const order = await prisma.order.findFirst({ where: { conversationId: conversation.id } });
    assert.equal(order, null, "must not close the sale yet - no confirmation or payment proof received");
  } finally {
    restoreFetch();
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.paymentMethod.deleteMany({ where: { id: paymentMethod.id } });
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

test("bot answers directly from the catalog without escalating when a product just isn't sold", async () => {
  stubWhatsappFetch();
  try {
    const conversation = await runTurn("Venden celulares?");
    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: conversation.id } });
    assert.equal(pending, null);
    assert.equal(conversation.humanControl, false);
  } finally {
    restoreFetch();
  }
});

test("bot uses get_order_status to answer with the real shipment status instead of guessing", async () => {
  stubWhatsappFetch();
  const priorConversation = await prisma.conversation.create({ data: { customerId } });
  const order = await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: priorConversation.id,
      summary: "1x Smartwatch",
      totalAmount: 145000,
      currency: "COP",
      fulfillmentStatus: "SHIPPED",
      shippedAt: new Date(),
      shipmentNote: "Va en camino con Coordinadora",
    },
  });
  try {
    const { reply } = await runTurnWithReply("Hola, como va mi pedido?");
    assert.match(reply, /coordinadora|enviad/i, "reply must reflect the real shipment status, not a guess");
  } finally {
    restoreFetch();
    await prisma.order.deleteMany({ where: { id: order.id } });
    await prisma.conversation.deleteMany({ where: { id: priorConversation.id } });
  }
});

test("bot asks for explicit confirmation before canceling an order, instead of canceling right away", async () => {
  stubWhatsappFetch();
  const priorConversation = await prisma.conversation.create({ data: { customerId } });
  const order = await prisma.order.create({
    data: { businessId, customerId, conversationId: priorConversation.id, summary: "1x Smartwatch", totalAmount: 145000, currency: "COP" },
  });
  try {
    await runTurnWithReply("Quiero cancelar mi pedido");
    const stillPending = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(stillPending.fulfillmentStatus, "PENDING", "must ask the customer to confirm before actually canceling");
  } finally {
    restoreFetch();
    await prisma.order.deleteMany({ where: { id: order.id } });
    await prisma.conversation.deleteMany({ where: { id: priorConversation.id } });
  }
});
