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
  sentMedia = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") {
      sentMessages.push({ to, body: body.text?.body ?? "" });
    } else if (body.type === "template") {
      // sendOwnerAlert tries the vendia_owner_alert template first - the dynamic text lives in the
      // template's body component parameters, not a plain text.body field.
      const paramText = body.template?.components?.[0]?.parameters?.[0]?.text ?? "";
      sentMessages.push({ to, body: paramText });
    } else if (body.type === "image" || body.type === "video") {
      sentMedia.push({ to, type: body.type, caption: body[body.type]?.caption ?? "" });
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

// Regression tests for the "bot sends the wrong product's photos" bug. Root cause: send_product_media
// re-searched by fuzzy text independently of whatever product the model had already resolved, with no
// minimum confidence - a single incidental shared word between two unrelated products (e.g. a color
// mentioned in both a headphones and a smartwatch description) was enough to pick the wrong one.

test("send_product_media sends the product pinned by productId, ignoring any fuzzy-match ambiguity", async () => {
  stubWhatsappFetch();
  try {
    const headphones = await prisma.product.create({
      data: {
        businessId,
        name: "Audifonos Over-Ear Pro Max",
        description: "Auriculares inalambricos color negro",
        price: 180000,
        currency: "COP",
        stock: 2,
        media: { create: [{ type: "IMAGE", url: "https://example.com/headphones.jpg", s3Key: "headphones.jpg" }] },
      },
    });
    const watch = await prisma.product.create({
      data: {
        businessId,
        name: "Smartwatch Confidence Test",
        description: "Reloj compacto color negro",
        price: 145000,
        currency: "COP",
        stock: 5,
        media: { create: [{ type: "IMAGE", url: "https://example.com/watch.jpg", s3Key: "watch.jpg" }] },
      },
    });

    const context = await freshContext();
    // Ambiguous/weak text on purpose (shares "negro" with both) - passing productId must bypass the
    // fuzzy matcher entirely and send exactly the pinned product.
    const result = (await runCatalogTool(context, "send_product_media", {
      productId: watch.id,
      productName: "algo negro",
    })) as { sent: boolean; product: string };

    assert.equal(result.sent, true);
    assert.equal(result.product, watch.name);
    assert.equal(sentMessages.length, 0); // image sends aren't captured as text/template in the stub
    void headphones;
  } finally {
    restoreFetch();
  }
});

test("send_product_media refuses to guess and sends nothing when the text match is too weak", async () => {
  stubWhatsappFetch();
  try {
    const watch = await prisma.product.create({
      data: {
        businessId,
        name: "Smartwatch Weak Match Test",
        description: "Reloj compacto, correa de silicona negra",
        price: 145000,
        currency: "COP",
        stock: 5,
        media: { create: [{ type: "IMAGE", url: "https://example.com/watch2.jpg", s3Key: "watch2.jpg" }] },
      },
    });

    const context = await freshContext();
    const result = (await runCatalogTool(context, "send_product_media", { productName: "gorra negra de algodon" })) as {
      error?: string;
    };

    assert.ok(result.error, "expected an error instead of a wrong-guess send");
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: watch.id } });
    assert.equal(fresh.inquiryCount, 0, "a weak/refused match must not touch the product it didn't confidently identify");
  } finally {
    restoreFetch();
  }
});

test("send_product_media returns an ambiguous error listing both candidates on a tie, sending nothing", async () => {
  stubWhatsappFetch();
  try {
    await prisma.product.create({
      data: {
        businessId,
        name: "Combo Ambiguo Negro",
        description: "Version negra",
        price: 100000,
        currency: "COP",
        stock: 1,
        media: { create: [{ type: "IMAGE", url: "https://example.com/a.jpg", s3Key: "a.jpg" }] },
      },
    });
    await prisma.product.create({
      data: {
        businessId,
        name: "Combo Ambiguo Azul",
        description: "Version azul",
        price: 100000,
        currency: "COP",
        stock: 1,
        media: { create: [{ type: "IMAGE", url: "https://example.com/b.jpg", s3Key: "b.jpg" }] },
      },
    });

    const context = await freshContext();
    const result = (await runCatalogTool(context, "send_product_media", { productName: "combo ambiguo" })) as {
      error?: string;
    };

    assert.ok(result.error);
    assert.match(result.error!, /Combo Ambiguo Negro/);
    assert.match(result.error!, /Combo Ambiguo Azul/);
  } finally {
    restoreFetch();
  }
});

// Regression tests for stock never decrementing on a sale, and duplicate order-item lines never being
// merged (both found in the same review as the photo-mismatch bug).

test("close_conversation SOLD decrements stock by the quantity sold", async () => {
  stubWhatsappFetch();
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573003${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  const product = await prisma.product.create({
    data: { businessId: business2.id, name: "Stock Test Product", description: "x", price: 10000, currency: "COP", stock: 5 },
  });

  try {
    const context: ToolContext = {
      businessId: business2.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };

    await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "2x Stock Test Product",
      items: [{ productName: "Stock Test Product", quantity: 2 }],
    });

    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(fresh.stock, 3);
  } finally {
    restoreFetch();
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

test("close_conversation SOLD with one unresolvable item still creates the order with only the resolved items", async () => {
  stubWhatsappFetch();
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573006${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.product.create({
    data: { businessId: business2.id, name: "Producto Real", description: "x", price: 10000, currency: "COP", stock: 10 },
  });

  try {
    const context: ToolContext = {
      businessId: business2.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };

    // "Producto Inventado" doesn't exist in this business's catalog at all - resolveOrderItems must not
    // crash or silently drop the whole order, just the one line it genuinely can't resolve.
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "1x Producto Real + 1x Producto Inventado",
      items: [
        { productName: "Producto Real", quantity: 1 },
        { productName: "Producto Inventado", quantity: 1 },
      ],
    })) as { closed: boolean };
    assert.equal(result.closed, true);

    const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: conversation2.id }, include: { items: true } });
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].productName, "Producto Real");
  } finally {
    restoreFetch();
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

test("close_conversation SOLD merges two item lines for the same product into one line with summed quantity", async () => {
  stubWhatsappFetch();
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573004${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.product.create({
    data: { businessId: business2.id, name: "Dedupe Test Product", description: "x", price: 10000, currency: "COP", stock: 10 },
  });

  try {
    const context: ToolContext = {
      businessId: business2.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };

    await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "3x Dedupe Test Product",
      items: [
        { productName: "Dedupe Test Product", quantity: 1 },
        { productName: "Dedupe Test Product", quantity: 2 },
      ],
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: conversation2.id }, include: { items: true } });
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].quantity, 3);
  } finally {
    restoreFetch();
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

test("close_conversation SOLD with a payment-confirmation gate: falls back to plain text when the buttons send fails, and still blocks auto-closing", async () => {
  const business2 = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573005550000",
      contactName: "Owner2",
    },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573005${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });

  const originalFetch2 = globalThis.fetch;
  let textSent = false;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "interactive") {
      // Simulate the buttons send failing outright (e.g. unsupported message type for this WABA).
      return { ok: false, text: async () => "simulated interactive send failure" } as Response;
    }
    if (body.type === "text") {
      textSent = true;
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.fallback-${randomUUID()}` }] }) } as Response;
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.other-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;

  try {
    const context: ToolContext = {
      businessId: business2.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };

    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Compra con fallback de confirmacion",
    })) as { closed: boolean; pending: boolean };

    assert.equal(result.closed, false);
    assert.equal(result.pending, true);
    assert.equal(textSent, true, "expected the plain-text fallback to have been attempted after buttons failed");

    const order = await prisma.order.findUnique({ where: { conversationId: conversation2.id } });
    assert.equal(order, null, "must not auto-close an unconfirmed sale just because the buttons send failed");

    const freshConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation2.id } });
    assert.ok(freshConversation.pendingConfirmationMessageId, "the text-fallback wamid should still be tracked for later owner confirmation");
  } finally {
    globalThis.fetch = originalFetch2;
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

// ask_owner_about_photo: last-resort escalation when the image analysis pipeline (DeepSeek + Claude
// escalation) genuinely couldn't identify a product photo/video. These test the tool implementation
// directly (does it find the right media, does it reach the owner, does it degrade gracefully when
// delivery fails) - not whether the model chooses to call it, which is a prompt-behavior concern.

test("ask_owner_about_photo forwards the customer's most recent photo to the owner and creates a PHOTO_PRODUCT pending question", async () => {
  stubWhatsappFetch();
  const context = await freshContext();
  await prisma.message.create({
    data: {
      conversationId: context.conversationId,
      role: "CUSTOMER",
      content: "",
      mediaS3Key: "receipts/some-photo.jpg",
      mediaType: "IMAGE",
    },
  });

  try {
    const result = (await runCatalogTool(context, "ask_owner_about_photo", {})) as { asked: boolean };
    assert.equal(result.asked, true);

    const mediaSent = sentMedia.find((m) => m.to === "573000000000" && m.type === "image");
    assert.ok(mediaSent, "expected the owner to receive the customer's actual photo as a real image message");

    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: context.conversationId } });
    assert.ok(pending);
    assert.equal(pending!.kind, "PHOTO_PRODUCT");

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    assert.equal(conversation.humanControl, true, "the bot must stop auto-replying while this is pending");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: context.conversationId } });
  }
});

test("ask_owner_about_photo sends the video (not as an image) when the customer's last media is a video", async () => {
  stubWhatsappFetch();
  const context = await freshContext();
  await prisma.message.create({
    data: {
      conversationId: context.conversationId,
      role: "CUSTOMER",
      content: "",
      mediaS3Key: "videos/some-clip.mp4",
      mediaType: "VIDEO",
    },
  });

  try {
    const result = (await runCatalogTool(context, "ask_owner_about_photo", {})) as { asked: boolean };
    assert.equal(result.asked, true);
    assert.equal(sentMedia.length, 1);
    assert.equal(sentMedia[0].type, "video");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: context.conversationId } });
  }
});

test("ask_owner_about_photo refuses (does not send anything) when there's no recent customer photo/video", async () => {
  stubWhatsappFetch();
  const context = await freshContext();

  try {
    const result = (await runCatalogTool(context, "ask_owner_about_photo", {})) as { asked: boolean; note: string };
    assert.equal(result.asked, false);
    assert.match(result.note, /foto|video/i);
    assert.equal(sentMedia.length, 0);
    assert.equal(sentMessages.length, 0);
  } finally {
    restoreFetch();
  }
});

test("ask_owner_about_photo refuses when the business has no contact phone configured", async () => {
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573002${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.message.create({
    data: { conversationId: conversation2.id, role: "CUSTOMER", content: "", mediaS3Key: "receipts/x.jpg", mediaType: "IMAGE" },
  });

  stubWhatsappFetch();
  try {
    const context: ToolContext = {
      businessId: business2.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };
    const result = (await runCatalogTool(context, "ask_owner_about_photo", {})) as { asked: boolean };
    assert.equal(result.asked, false);
    assert.equal(sentMedia.length, 0);
  } finally {
    restoreFetch();
    await prisma.message.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

// Directly addresses the "the owner sometimes doesn't get the bot's messages" reliability concern:
// this proves there's a real second attempt (plain text with the photo's link) when the native
// image/video send fails, instead of the owner getting nothing at all.
test("ask_owner_about_photo falls back to a text message with a link when the native media send fails", async () => {
  const context = await freshContext();
  await prisma.message.create({
    data: { conversationId: context.conversationId, role: "CUSTOMER", content: "", mediaS3Key: "receipts/y.jpg", mediaType: "IMAGE" },
  });

  const original = globalThis.fetch;
  const textAttempts: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "image") {
      return { ok: false, status: 500, text: async () => "simulated media rejection" } as Response;
    }
    if (body.type === "text") {
      textAttempts.push(body.text?.body ?? "");
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;

  try {
    const result = (await runCatalogTool(context, "ask_owner_about_photo", {})) as { asked: boolean };
    assert.equal(result.asked, true, "must still succeed via the text fallback, not silently give up");
    assert.equal(textAttempts.length, 1);
    assert.match(textAttempts[0], /https?:\/\//, "the fallback text must include a link so the owner can still see the photo");

    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: context.conversationId } });
    assert.ok(pending, "the fallback wamid must still be tracked so the owner's reply can resolve it");
  } finally {
    globalThis.fetch = original;
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: context.conversationId } });
  }
});

test("ask_owner_about_photo reports failure (and creates no pending question) when neither media nor text delivery work", async () => {
  const context = await freshContext();
  await prisma.message.create({
    data: { conversationId: context.conversationId, role: "CUSTOMER", content: "", mediaS3Key: "receipts/z.jpg", mediaType: "IMAGE" },
  });

  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "simulated total outage" }) as Response) as typeof fetch;

  try {
    const result = (await runCatalogTool(context, "ask_owner_about_photo", {})) as { asked: boolean };
    assert.equal(result.asked, false);

    const pending = await prisma.pendingOwnerQuestion.findFirst({ where: { conversationId: context.conversationId } });
    assert.equal(pending, null, "must not leave a dangling pending question if the owner was never actually reached");

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    assert.equal(conversation.humanControl, false, "must not silently stop the bot from replying if the owner was never reached");
  } finally {
    globalThis.fetch = original;
  }
});
