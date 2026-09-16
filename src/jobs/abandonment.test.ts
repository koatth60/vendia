import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { createProduct } from "../catalog/products";
import { setOrderItem } from "../orders/saleState";
import { runAbandonmentJob } from "./abandonment";

// Fase 9 del plan maestro (2026-09-15), causa raiz C1+eje 18: el 61% de las conversaciones NEW no
// cerraba nunca y no contaba como perdida. Cobertura del job que las pasa a ABANDONED.

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Abandonment ${randomUUID()}`,
      email: `test-abandonment-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      abandonedAfterHours: 72,
      whatsappPhoneNumberId: "test-phone-id",
      whatsappAccessToken: "test-token",
      cartRecoveryTemplateName: "recuperar_carrito",
      // La recuperacion de carrito sigue detras de saleStateEnabled: desde 2026-09-15 SaleState.items se
      // escribe tambien sin la bandera (proyeccion del servidor, ver orders/saleState.ts), y sin este
      // filtro negocios que hoy nunca mandan la plantilla empezarian a mandarsela a sus clientes.
      saleStateEnabled: true,
      cartRecoveryTemplateLanguage: "es",
    },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  const originalFetch = globalThis.fetch;
  const sentMessages: { to: string; body: string; type: string }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "template") {
      const paramText = body.template?.components?.[0]?.parameters?.[0]?.text ?? "";
      sentMessages.push({ to, body: paramText, type: "template" });
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
  return { sentMessages, restore: () => { globalThis.fetch = originalFetch; } };
}

async function seedConversation(overrides: { status?: "NEW" | "SOLD" | "LOST" | "ABANDONED"; lastCustomerMessageHoursAgo: number | null; stage?: "NUEVO" | "ACTIVO" | "COMPRADOR" }) {
  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `57300${Date.now()}${Math.floor(Math.random() * 1000)}`, stage: overrides.stage ?? "NUEVO" },
  });
  const conversation = await prisma.conversation.create({
    data: { customerId: customer.id, status: overrides.status ?? "NEW" },
  });
  if (overrides.lastCustomerMessageHoursAgo !== null) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "CUSTOMER",
        content: "Hola, cuanto cuesta?",
        createdAt: new Date(Date.now() - overrides.lastCustomerMessageHoursAgo * 60 * 60 * 1000),
      },
    });
  }
  return { customer, conversation };
}

async function cleanup(conversationId: string, customerId: string) {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.saleState.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
}

test("runAbandonmentJob marks a conversation ABANDONED and the customer INACTIVO after abandonedAfterHours of customer silence", async () => {
  const { customer, conversation } = await seedConversation({ lastCustomerMessageHoursAgo: 80 });
  try {
    await runAbandonmentJob();

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.status, "ABANDONED");

    const updatedCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(updatedCustomer.stage, "INACTIVO");
  } finally {
    await cleanup(conversation.id, customer.id);
  }
});

test("runAbandonmentJob leaves a conversation alone while the customer is still recent", async () => {
  const { customer, conversation } = await seedConversation({ lastCustomerMessageHoursAgo: 2 });
  try {
    await runAbandonmentJob();

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.status, "NEW");
  } finally {
    await cleanup(conversation.id, customer.id);
  }
});

test("runAbandonmentJob never touches a SOLD conversation, however old", async () => {
  const { customer, conversation } = await seedConversation({ status: "SOLD", lastCustomerMessageHoursAgo: 500 });
  try {
    await runAbandonmentJob();

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.status, "SOLD");
  } finally {
    await cleanup(conversation.id, customer.id);
  }
});

test("runAbandonmentJob does not downgrade a customer who already bought before (COMPRADOR) just because one conversation went stale", async () => {
  const { customer, conversation } = await seedConversation({ lastCustomerMessageHoursAgo: 80, stage: "COMPRADOR" });
  try {
    await runAbandonmentJob();

    const updatedCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(updatedCustomer.stage, "COMPRADOR", "purchase history stage must not be silently overwritten");
  } finally {
    await cleanup(conversation.id, customer.id);
  }
});

test("runAbandonmentJob sends the cart-recovery template once for an abandoned conversation with real SaleState items, and never repeats it", async () => {
  const { restore, sentMessages } = stubWhatsappFetch();
  const product = await createProduct(businessId, { name: "Cargador USB-C", description: "d", price: 20000, stock: 5 });
  const { customer, conversation } = await seedConversation({ lastCustomerMessageHoursAgo: 80 });
  try {
    await setOrderItem(businessId, conversation.id, { productId: product.id, quantity: 1 });

    await runAbandonmentJob();

    assert.equal(sentMessages.length, 1, "the cart-recovery template must go out exactly once");
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.status, "ABANDONED");
    assert.ok(updated.cartRecoverySentAt);

    sentMessages.length = 0;
    await runAbandonmentJob();
    assert.equal(sentMessages.length, 0, "must not resend once cartRecoverySentAt is set");
  } finally {
    restore();
    await cleanup(conversation.id, customer.id);
  }
});

test("runAbandonmentJob does not send a cart-recovery template for an abandoned conversation with no items", async () => {
  const { restore, sentMessages } = stubWhatsappFetch();
  const { customer, conversation } = await seedConversation({ lastCustomerMessageHoursAgo: 80 });
  try {
    await runAbandonmentJob();

    assert.equal(sentMessages.length, 0, "nothing to recover, nothing to send");
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.status, "ABANDONED");
    assert.equal(updated.cartRecoverySentAt, null);
  } finally {
    restore();
    await cleanup(conversation.id, customer.id);
  }
});

test("runAbandonmentJob does not send a cart-recovery template for a business without saleStateEnabled", async () => {
  // Desde 2026-09-15 SaleState.items tambien se escribe para negocios con la bandera apagada (es una
  // proyeccion del servidor, ver orders/saleState.ts). Este test es el candado de que ese cambio interno
  // no le empieza a mandar plantillas a los clientes de negocios que hoy nunca las reciben.
  const { restore, sentMessages } = stubWhatsappFetch();
  const product = await createProduct(businessId, { name: "Cable HDMI", description: "d", price: 15000, stock: 5 });
  const { customer, conversation } = await seedConversation({ lastCustomerMessageHoursAgo: 80 });
  try {
    await prisma.business.update({ where: { id: businessId }, data: { saleStateEnabled: false } });
    await setOrderItem(businessId, conversation.id, { productId: product.id, quantity: 1 });

    await runAbandonmentJob();

    assert.equal(sentMessages.length, 0, "sin la bandera, el carrito registrado no dispara ninguna plantilla");
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).cartRecoverySentAt, null);
  } finally {
    await prisma.business.update({ where: { id: businessId }, data: { saleStateEnabled: true } });
    restore();
    await cleanup(conversation.id, customer.id);
  }
});
