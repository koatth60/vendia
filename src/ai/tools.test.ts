import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runCatalogTool, type ToolContext } from "./tools";

// Direct tool-function tests - no DeepSeek calls, so these stay fast and cheap even as the suite
// grows. Reserve real-model calls (see agent.escalation.test.ts) for testing whether the model
// actually chooses to call a tool, not for exercising the tool implementations themselves.

let businessId: string;
let customerId: string;
let originalFetch: typeof fetch;
let sentMessages: { to: string; body: string }[];

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

  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573001${Date.now()}` },
  });
  customerId = customer.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") sentMessages.push({ to, body: body.text?.body ?? "" });
    return {
      ok: true,
      json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }),
    } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function freshContext(): Promise<ToolContext> {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  return {
    businessId,
    conversationId: conversation.id,
    customerId,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573009998877",
  };
}

test("save_customer_name saves a valid name", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "save_customer_name", { name: "Deinerin" });
  assert.deepEqual(result, { saved: true, name: "Deinerin" });
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(customer.name, "Deinerin");
});

test("save_customer_name rejects an empty name", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "save_customer_name", { name: "   " });
  assert.deepEqual(result, { error: "Falta el nombre" });
});

test("update_conversation_status accepts a valid status", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "update_conversation_status", { status: "QUOTED" });
  assert.deepEqual(result, { updated: true, status: "QUOTED" });
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
  assert.equal(conversation.status, "QUOTED");
});

test("update_conversation_status rejects a status outside the allowed set", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "update_conversation_status", { status: "SOLD" });
  assert.deepEqual(result, { error: "Estado invalido" });
});

test("get_payment_methods reports when none are configured", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "get_payment_methods", {});
  assert.deepEqual(result, {
    methods: [],
    note: "Este negocio todavia no configuro formas de pago. Decile al cliente que un asesor le va a confirmar como pagar.",
  });
});

test("get_payment_methods returns only active methods", async () => {
  await prisma.paymentMethod.create({
    data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "300 000 0000", active: true },
  });
  await prisma.paymentMethod.create({
    data: { businessId, type: "EFECTIVO", label: "Vieja", details: "ya no", active: false },
  });

  const context = await freshContext();
  const result = (await runCatalogTool(context, "get_payment_methods", {})) as { methods: { label: string }[] };
  assert.equal(result.methods.length, 1);
  assert.equal(result.methods[0].label, "Nequi");
});

test("flag_conversation_intent escalates to a human and notifies the owner", async () => {
  stubWhatsappFetch();
  try {
    const context = await freshContext();
    const result = await runCatalogTool(context, "flag_conversation_intent", { intent: "DEVOLUCION" });
    assert.equal((result as { flagged: boolean }).flagged, true);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    assert.equal(conversation.humanControl, true);
    assert.equal(conversation.intent, "DEVOLUCION");
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].body, /devolucion/i);
  } finally {
    restoreFetch();
  }
});

test("flag_conversation_intent escalates when the customer asks for a human agent", async () => {
  stubWhatsappFetch();
  try {
    const context = await freshContext();
    const result = await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE" });
    assert.equal((result as { flagged: boolean }).flagged, true);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    assert.equal(conversation.humanControl, true);
    assert.equal(conversation.intent, "SOLICITA_AGENTE");
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].body, /asesor/i);
  } finally {
    restoreFetch();
  }
});

test("close_conversation with outcome LOST updates status without creating an order", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "close_conversation", { outcome: "LOST" });
  assert.deepEqual(result, { closed: true, outcome: "LOST" });

  const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
  assert.equal(order, null);
});

test("close_conversation with outcome SOLD creates a real order when no owner confirmation is needed", async () => {
  stubWhatsappFetch();
  const businessNoContact = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({
    data: { businessId: businessNoContact.id, phoneNumber: `573002${Date.now()}` },
  });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });

  try {
    const context: ToolContext = {
      businessId: businessNoContact.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };

    const result = await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Compra sin productos del catalogo",
    });
    assert.deepEqual(result, { closed: true, outcome: "SOLD" });

    const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: conversation2.id } });
    assert.equal(order.summary, "Compra sin productos del catalogo");
  } finally {
    restoreFetch();
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: businessNoContact.id } });
  }
});

test("search_products and get_product_details find a seeded product", async () => {
  const product = await prisma.product.create({
    data: {
      businessId,
      name: "Smartwatch Serie 11 Mini",
      description: "Reloj inteligente compacto",
      price: 145000,
      currency: "COP",
      stock: 5,
    },
  });

  const context = await freshContext();
  const searchResult = (await runCatalogTool(context, "search_products", { query: "smartwatch" })) as { id: string }[];
  assert.equal(searchResult.length, 1);
  assert.equal(searchResult[0].id, product.id);

  const detail = (await runCatalogTool(context, "get_product_details", { productId: product.id })) as { name: string };
  assert.equal(detail.name, "Smartwatch Serie 11 Mini");
});

test("search_products falls back to the full catalog (with a note) when no keyword matches", async () => {
  // Regression for the same class of bug fixed in get_faq: a query worded differently from the
  // catalog text shouldn't produce a false "no lo tenemos" - the model should get the full list to
  // judge by meaning instead.
  await prisma.product.create({
    data: {
      businessId,
      name: "Hello Plum",
      description: "Smartwatch de diseño minimalista",
      price: 125000,
      currency: "COP",
      stock: 2,
    },
  });

  const context = await freshContext();
  const result = (await runCatalogTool(context, "search_products", { query: "algo para hacer ejercicio" })) as {
    results: { name: string }[];
    note: string;
  };
  assert.ok(Array.isArray(result.results));
  assert.ok(result.results.length > 0);
  assert.match(result.note, /catalogo completo/i);
});
