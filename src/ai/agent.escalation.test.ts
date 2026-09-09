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
      // ask_owner now goes through sendOwnerAlert, which tries the vendia_owner_alert template first -
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
  await recordMessage(conversation.id, "CUSTOMER", customerText);

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

test("bot escalates via ask_owner when the FAQ doesn't confirm the specific question", async () => {
  stubWhatsappFetch();
  try {
    const conversation = await runTurn("De alguna manera puedo conseguir domicilio gratis?");
    assert.ok(
      conversation.pendingOwnerQuestionMessageId,
      "ask_owner should have fired and set pendingOwnerQuestionMessageId - a text reply alone (e.g. 'voy a preguntar') is not enough"
    );
    assert.equal(conversation.humanControl, true);
    assert.ok(sentToOwner, "expected a WhatsApp message to actually be sent to the owner");
    assert.match(sentToOwner!.body, /gratis/i);
  } finally {
    restoreFetch();
  }
});

test("bot answers directly from the catalog without escalating when a product just isn't sold", async () => {
  stubWhatsappFetch();
  try {
    const conversation = await runTurn("Venden celulares?");
    assert.equal(conversation.pendingOwnerQuestionMessageId, null);
    assert.equal(conversation.humanControl, false);
  } finally {
    restoreFetch();
  }
});
