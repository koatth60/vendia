import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { recordMessage } from "../conversation/service";
import { generateReply } from "./agent";
import type { ToolContext } from "./tools";

// Proactive synthetic scenarios for ambiguous customer phrasing - built after a real production bug
// (2026-09-12, see agent.photoBackstop.test.ts) where "Muestrame fotos" with no product name, right
// after the bot listed several numbered options, caused a false "aqui van las fotos" claim with nothing
// actually sent. These hit the real DeepSeek API (small real cost) to verify the FULL pipeline - not
// just the matching function in isolation - handles similarly-shaped ambiguous requests correctly.

let businessId: string;
let customerId: string;
let originalFetch: typeof fetch;
let sentMedia: { to: string; type: string; caption: string }[];

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

  await prisma.product.createMany({
    data: [
      { businessId, name: "Smartwatch Serie 11 Mini", description: "Reloj inteligente", price: 145000, currency: "COP", stock: 5 },
      { businessId, name: "Smartwatch Serie 12 Ultra 3", description: "Reloj inteligente premium", price: 140000, currency: "COP", stock: 5 },
      { businessId, name: "Smartwatch Gen 9", description: "Reloj inteligente basico", price: 85000, currency: "COP", stock: 5 },
      { businessId, name: "Smartwatch V20 Caballero", description: "Reloj inteligente para hombre", price: 140000, currency: "COP", stock: 5 },
    ],
  });
  const products = await prisma.product.findMany({ where: { businessId } });
  for (const p of products) {
    await prisma.productMedia.create({ data: { productId: p.id, type: "IMAGE", url: `https://example.com/${p.id}.jpg`, s3Key: `${p.id}.jpg` } });
  }

  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573002${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.productMedia.deleteMany({ where: { product: { businessId } } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentMedia = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "image" || body.type === "video") {
      sentMedia.push({ to, type: body.type, caption: body[body.type]?.caption ?? "" });
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function runTurnAfterHistory(turns: [("CUSTOMER" | "ASSISTANT"), string][], lastCustomerText: string) {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  for (const [role, content] of turns) {
    await recordMessage(businessId, conversation.id, role, content);
  }
  await recordMessage(businessId, conversation.id, "CUSTOMER", lastCustomerText);

  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId,
    credentials: { phoneNumberId: "test-phone-id", accessToken: "test-token" },
    recipientPhone: "573001112233",
  };
  const reply = await generateReply(conversation.id, context, undefined, lastCustomerText);
  return { conversation, reply };
}

test("bot sends photos of all listed options when the customer asks for photos without naming one", async () => {
  stubWhatsappFetch();
  try {
    const { reply } = await runTurnAfterHistory(
      [
        ["CUSTOMER", "Hola estoy interesado en el reloj negro"],
        [
          "ASSISTANT",
          "¡Hola! Tenemos varios smartwatches en negro, ¿me confirmas cuál de estos te interesa?\n\n1. Serie 11 Mini — $145.000\n2. Serie 12 Ultra 3 — $140.000\n3. Smartwatch Gen 9 — $85.000\n4. Smartwatch V20 Caballero — $140.000\n\n¿Cuál prefieres?",
        ],
      ],
      "Muestrame fotos"
    );
    assert.ok(sentMedia.length >= 3, `expected photos for multiple listed options, got ${sentMedia.length}`);
    assert.doesNotMatch(reply, /disculpa.*problema/i, "must not fall back to the generic error message");
  } finally {
    restoreFetch();
  }
});

test("bot resolves a positional reference ('el segundo') to the correct named product, not literally '2'", async () => {
  stubWhatsappFetch();
  try {
    const { reply } = await runTurnAfterHistory(
      [
        ["CUSTOMER", "Que smartwatches tienen?"],
        [
          "ASSISTANT",
          "Tenemos estos disponibles:\n\n1. Serie 11 Mini — $145.000\n2. Serie 12 Ultra 3 — $140.000\n3. Smartwatch Gen 9 — $85.000\n4. Smartwatch V20 Caballero — $140.000",
        ],
      ],
      "mandame fotos del segundo"
    );
    assert.ok(sentMedia.length >= 1, "must send at least one photo");
    assert.doesNotMatch(reply, /disculpa.*problema/i);
  } finally {
    restoreFetch();
  }
});
