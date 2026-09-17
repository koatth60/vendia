import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runCatalogTool, type ToolContext } from "./tools";
import { resolveOrderItems, createOrder } from "../orders/service";

// Direct tool-function tests - no DeepSeek calls, so these stay fast and cheap even as the suite
// grows. Reserve real-model calls (see agent.escalationPaid.ts, `npm run test:paid`) for testing whether the model
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

  // Fase 6 del plan maestro (2026-09-15): getSaleGate.canSell tambien exige al menos una tarifa de envio
  // real - sin esto, cada show_order_summary/close_conversation SOLD de este archivo quedaria bloqueado
  // por la compuerta antes de llegar a lo que en realidad prueban. El metodo de pago llega mas abajo, del
  // test "get_payment_methods returns only active methods" (que corre antes de cualquier test bloqueado
  // por la compuerta) - se deja asi a proposito para no romper "get_payment_methods reports when none are
  // configured", que si necesita businessId sin ningun metodo de pago.
  await prisma.shippingRate.create({ data: { businessId, label: "Estandar", cost: 9000 } });

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
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

// Fase 6: cada test de close_conversation SOLD de mas abajo que arma su propio "business2" ad-hoc (para
// no compartir Order/stock con el resto del archivo) necesita tambien pasar la compuerta si lo que prueba
// no es la compuerta en si - la seccion "Fase 6 - compuerta de configuracion" mas abajo prueba la
// compuerta sola, sin esto.
async function seedSaleGateRequirements(targetBusinessId: string): Promise<void> {
  await prisma.paymentMethod.create({
    data: { businessId: targetBusinessId, type: "TRANSFERENCIA", label: "Nequi", details: "300", active: true },
  });
  await prisma.shippingRate.create({ data: { businessId: targetBusinessId, label: "Estandar", cost: 9000 } });
}

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
      // sendOwnerAlert tries the onix_owner_alert template first - the dynamic text lives in the
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
  // Fase 7: todo envio libre a un cliente pasa por la ventana de 24h de WhatsApp, que se mide contra su
  // ultimo mensaje. Una conversacion real siempre tiene uno; sin el, la capa de salida da la ventana
  // por cerrada y con razon.
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Hola" } });
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

// Fase 9 del plan maestro (2026-09-15): defecto real - "Cerrar conversation" se escalo como
// SOLICITA_AGENTE sin que el cliente hubiera pedido un humano. El dueno necesita ver, desde la propia
// alerta, si fue el modelo el que dedujo el intent o si el cliente lo pidio con sus palabras.
test("flag_conversation_intent marks the owner alert when the model inferred the intent instead of the customer stating it", async () => {
  stubWhatsappFetch();
  try {
    const context = await freshContext();
    await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE", explicit: false });

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    assert.equal(conversation.intentExplicit, false);
    assert.match(sentMessages[0].body, /dedujo del contexto/i);
  } finally {
    restoreFetch();
  }
});

test("flag_conversation_intent does not flag the owner alert when the customer explicitly asked for it", async () => {
  stubWhatsappFetch();
  try {
    const context = await freshContext();
    await runCatalogTool(context, "flag_conversation_intent", { intent: "SOLICITA_AGENTE", explicit: true });

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    assert.equal(conversation.intentExplicit, true);
    assert.doesNotMatch(sentMessages[0].body, /dedujo del contexto/i);
  } finally {
    restoreFetch();
  }
});

test("show_order_summary computes the real subtotal/total from the catalog, never from the caller's own math", async () => {
  const product = await prisma.product.create({
    data: { businessId, name: `Producto Resumen ${randomUUID()}`, description: "x", price: 45000, currency: "COP", stock: 10 },
  });
  const context = await freshContext();
  try {
    const result = (await runCatalogTool(context, "show_order_summary", {
      items: [{ productName: product.name, quantity: 2 }],
      shippingCost: 9000,
    })) as { ready: boolean; subtotal: number; shippingCost: number; total: number; items: { lineTotal: number }[] };

    assert.equal(result.ready, true);
    assert.equal(result.items[0].lineTotal, 90000, "2 units at 45000 must total 90000, not whatever the caller passed");
    assert.equal(result.subtotal, 90000);
    assert.equal(result.shippingCost, 9000);
    assert.equal(result.total, 99000);
  } finally {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

test("show_order_summary blocks (ready:false) instead of guessing when a variant color/talla is still needed", async () => {
  const product = await prisma.product.create({
    data: { businessId, name: `Producto Variante ${randomUUID()}`, description: "x", price: 20000, currency: "COP", stock: 5 },
  });
  await prisma.productVariant.create({ data: { productId: product.id, color: "Rojo", stock: 3 } });
  await prisma.productVariant.create({ data: { productId: product.id, color: "Azul", stock: 2 } });
  const context = await freshContext();
  try {
    const result = (await runCatalogTool(context, "show_order_summary", {
      items: [{ productName: product.name, quantity: 1 }],
    })) as { ready: boolean; note?: string };

    assert.equal(result.ready, false);
    assert.match(result.note ?? "", /color|talla/i);
  } finally {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

test("show_order_summary blocks (ready:false) instead of silently dropping an unresolved item", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "show_order_summary", {
    items: [{ productName: "Producto que no existe en el catalogo", quantity: 1 }],
  })) as { ready: boolean; note?: string };

  assert.equal(result.ready, false);
  assert.match(result.note ?? "", /no encontre/i);
});

test("close_conversation with outcome LOST updates status without creating an order", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "close_conversation", { outcome: "LOST" });
  assert.deepEqual(result, { closed: true, outcome: "LOST" });

  const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
  assert.equal(order, null);
});

// Fase 6 del plan maestro (2026-09-15): antes de la compuerta, un negocio sin contactPhone auto-cerraba
// la venta directo (nadie a quien pedirle confirmacion) - ver requestSaleConfirmation en tools.ts. Ahora
// falta el telefono de contacto BLOQUEA la venta antes de siquiera llegar ahi, asi que ese camino queda
// sin forma de alcanzarse via close_conversation. Este test reemplaza al que probaba ese comportamiento
// viejo.
test("close_conversation SOLD is blocked when the business has no payment methods, shipping rates or contact phone configured", async () => {
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

    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Compra sin productos del catalogo",
    })) as { closed: boolean; blocked?: boolean; missing?: string[] };
    assert.equal(result.closed, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.missing, ["métodos de pago", "tarifas de envío", "teléfono de contacto"]);

    const order = await prisma.order.findUnique({ where: { conversationId: conversation2.id } });
    assert.equal(order, null, "la compuerta debe bloquear la venta antes de crear ningun pedido");
  } finally {
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
    products: { name: string }[];
    note: string;
  };
  assert.ok(Array.isArray(result.products));
  assert.ok(result.products.length > 0);
  assert.match(result.note, /catalogo completo/i);
});

const MAX_LIST_ITEM_JSON_CHARS = 400;

test("catalog list views (search_products fallback, list_all_products) never leak an untruncated description", async () => {
  // Regression for ONIX-RELIABILITY-PLAN.md Fase 6.0b: an un-truncated description in a list-shaped
  // tool result silently ballooned one search_products call to ~18.8k chars in production, bigger than
  // BASE_SYSTEM_PROMPT itself, always at cache-miss price. This asserts the per-item cap holds regardless
  // of how long a real product description gets, so a future edit that bypasses forList/truncateForList
  // fails a fast test instead of only showing up in a production token bill.
  const longDescProduct = await prisma.product.create({
    data: {
      businessId,
      name: "Zzz Articulo De Prueba Descripcion Larga",
      description: "x".repeat(5000),
      price: 50000,
      currency: "COP",
      stock: 1,
    },
  });

  try {
    const context = await freshContext();

    const searchFallback = (await runCatalogTool(context, "search_products", { query: "consulta sin match" })) as {
      products: Record<string, unknown>[];
    };
    for (const item of searchFallback.products) {
      assert.ok(
        JSON.stringify(item).length <= MAX_LIST_ITEM_JSON_CHARS,
        `search_products fallback item exceeds ${MAX_LIST_ITEM_JSON_CHARS} chars: ${JSON.stringify(item).slice(0, 120)}...`
      );
    }

    const listAll = (await runCatalogTool(context, "list_all_products", {})) as { products: Record<string, unknown>[] };
    for (const item of listAll.products) {
      assert.ok(
        JSON.stringify(item).length <= MAX_LIST_ITEM_JSON_CHARS,
        `list_all_products item exceeds ${MAX_LIST_ITEM_JSON_CHARS} chars: ${JSON.stringify(item).slice(0, 120)}...`
      );
    }
  } finally {
    await prisma.product.deleteMany({ where: { id: longDescProduct.id } });
  }
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

// 2026-09-13 production incident: the media backstop in agent.ts resent the SAME photo set 3 times in one
// real conversation because this case never read/wrote Conversation.mediaSentProductIds at all. Fix:
// skipIfAlreadySent (internal-only, never in the JSON schema the model sees) lets the backstop's own
// re-checks skip a duplicate while the model's own explicit calls (e.g. "mándamela otra vez") still work.
test("send_product_media with skipIfAlreadySent skips a duplicate resend of the same product", async () => {
  stubWhatsappFetch();
  try {
    const watch = await prisma.product.create({
      data: {
        businessId,
        name: "Smartwatch Dedup Test",
        description: "Reloj deportivo",
        price: 140000,
        currency: "COP",
        stock: 5,
        media: { create: [{ type: "IMAGE", url: "https://example.com/dedup.jpg", s3Key: "dedup.jpg" }] },
      },
    });
    const context = await freshContext();

    const first = (await runCatalogTool(context, "send_product_media", { productId: watch.id, skipIfAlreadySent: true })) as { sent: boolean };
    assert.equal(first.sent, true, "first send must go through");

    const second = (await runCatalogTool(context, "send_product_media", { productId: watch.id, skipIfAlreadySent: true })) as {
      sent: boolean;
      skipped?: boolean;
    };
    assert.equal(second.sent, false, "backstop re-check must skip the duplicate");
    assert.equal(second.skipped, true);

    const incident = await prisma.agentIncident.findFirst({ where: { businessId, kind: "BACKSTOP_INTERVENTION" } });
    assert.ok(incident, "the skipped duplicate must be recorded as an AgentIncident");
  } finally {
    restoreFetch();
    await prisma.agentIncident.deleteMany({ where: { businessId } });
  }
});

test("send_product_media WITHOUT skipIfAlreadySent (the model's own explicit call) always resends", async () => {
  stubWhatsappFetch();
  try {
    const watch = await prisma.product.create({
      data: {
        businessId,
        name: "Smartwatch Explicit Resend Test",
        description: "Reloj deportivo",
        price: 140000,
        currency: "COP",
        stock: 5,
        media: { create: [{ type: "IMAGE", url: "https://example.com/explicit.jpg", s3Key: "explicit.jpg" }] },
      },
    });
    const context = await freshContext();

    await runCatalogTool(context, "send_product_media", { productId: watch.id, skipIfAlreadySent: true });
    const second = (await runCatalogTool(context, "send_product_media", { productId: watch.id })) as { sent: boolean };
    assert.equal(second.sent, true, "the model's own explicit request (no skipIfAlreadySent) must still send");
  } finally {
    restoreFetch();
  }
});

test("send_product_media dedup does not suppress a DIFFERENT variant/color of the same product", async () => {
  stubWhatsappFetch();
  try {
    const product = await prisma.product.create({
      data: {
        businessId,
        name: "Smartwatch Variant Dedup Test",
        description: "Reloj con colores",
        price: 140000,
        currency: "COP",
        stock: 5,
        variants: {
          create: [
            { color: "Negro", stock: 3 },
            { color: "Rojo", stock: 2 },
          ],
        },
      },
      include: { variants: true },
    });
    const [black, red] = product.variants;
    // ProductMedia.product is a required relation separate from variant - nesting media under
    // variants.create only sets variantId, not productId, so it must be created explicitly like this.
    await prisma.productMedia.create({ data: { productId: product.id, variantId: black.id, type: "IMAGE", url: "https://example.com/black.jpg", s3Key: "black.jpg" } });
    await prisma.productMedia.create({ data: { productId: product.id, variantId: red.id, type: "IMAGE", url: "https://example.com/red.jpg", s3Key: "red.jpg" } });
    const context = await freshContext();

    const firstBlack = (await runCatalogTool(context, "send_product_media", { productId: product.id, variantId: black.id, skipIfAlreadySent: true })) as { sent: boolean };
    assert.equal(firstBlack.sent, true);

    const secondBlack = (await runCatalogTool(context, "send_product_media", { productId: product.id, variantId: black.id, skipIfAlreadySent: true })) as { sent: boolean };
    assert.equal(secondBlack.sent, false, "the same color must be deduped");

    const firstRed = (await runCatalogTool(context, "send_product_media", { productId: product.id, variantId: red.id, skipIfAlreadySent: true })) as { sent: boolean };
    assert.equal(firstRed.sent, true, "a DIFFERENT color must not be suppressed by the first one's dedup entry");
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

// Fase 6 del plan maestro (2026-09-15): estos tres pruebas ya no pueden pasar por
// runCatalogTool(..., "close_conversation", ...) - con un contactPhone real (obligatorio para pasar
// getSaleGate), requestSaleConfirmation SIEMPRE exige confirmacion del dueno antes de crear el pedido, asi
// que close_conversation nunca llega a createOrder de forma sincronica. Lo que estos tres en realidad
// prueban (decremento de stock, fusion de lineas duplicadas, un item no resuelto no tumba el pedido
// entero) vive en resolveOrderItems/createOrder (src/orders/service.ts) - se prueba ahi directo, sin pasar
// por la compuerta ni por la confirmacion del dueno.
test("close_conversation SOLD decrements stock by the quantity sold", async () => {
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573003${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  const product = await prisma.product.create({
    data: { businessId: business2.id, name: "Stock Test Product", description: "x", price: 10000, currency: "COP", stock: 5 },
  });

  try {
    const { items } = await resolveOrderItems(business2.id, [{ productName: "Stock Test Product", quantity: 2 }]);
    await createOrder({
      businessId: business2.id,
      customerId: customer2.id,
      conversationId: conversation2.id,
      summary: "2x Stock Test Product",
      items,
    });

    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(fresh.stock, 3);
  } finally {
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

test("close_conversation SOLD with one unresolvable item still creates the order with only the resolved items", async () => {
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573006${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.product.create({
    data: { businessId: business2.id, name: "Producto Real", description: "x", price: 10000, currency: "COP", stock: 10 },
  });

  try {
    // "Producto Inventado" doesn't exist in this business's catalog at all - resolveOrderItems must not
    // crash or silently drop the whole order, just the one line it genuinely can't resolve.
    const { items } = await resolveOrderItems(business2.id, [
      { productName: "Producto Real", quantity: 1 },
      { productName: "Producto Inventado", quantity: 1 },
    ]);
    await createOrder({
      businessId: business2.id,
      customerId: customer2.id,
      conversationId: conversation2.id,
      summary: "1x Producto Real + 1x Producto Inventado",
      items,
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: conversation2.id }, include: { items: true } });
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].productName, "Producto Real");
  } finally {
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

test("close_conversation SOLD merges two item lines for the same product into one line with summed quantity", async () => {
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573004${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.product.create({
    data: { businessId: business2.id, name: "Dedupe Test Product", description: "x", price: 10000, currency: "COP", stock: 10 },
  });

  try {
    const { items } = await resolveOrderItems(business2.id, [
      { productName: "Dedupe Test Product", quantity: 1 },
      { productName: "Dedupe Test Product", quantity: 2 },
    ]);
    await createOrder({
      businessId: business2.id,
      customerId: customer2.id,
      conversationId: conversation2.id,
      summary: "3x Dedupe Test Product",
      items,
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: conversation2.id }, include: { items: true } });
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].quantity, 3);
  } finally {
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.paymentMethod.deleteMany({ where: { businessId: business2.id } });
    await prisma.shippingRate.deleteMany({ where: { businessId: business2.id } });
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
  await seedSaleGateRequirements(business2.id);
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573005${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  // Un pedido sin lineas ya no llega a la escalera de confirmacion (se bloquea antes), asi que esta
  // prueba - que es sobre la ESCALERA, no sobre el pedido - necesita un item real del catalogo.
  await prisma.product.create({
    data: { businessId: business2.id, name: "Producto Escalera", description: "x", price: 25000, currency: "COP", stock: 10 },
  });

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
      items: [{ productName: "Producto Escalera", quantity: 1 }],
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
    await prisma.paymentMethod.deleteMany({ where: { businessId: business2.id } });
    await prisma.shippingRate.deleteMany({ where: { businessId: business2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
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

test("get_order_status reports found:false when the customer has no order yet", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "get_order_status", {});
  assert.deepEqual(result, { found: false, note: "Este cliente no tiene ningun pedido registrado todavia." });
});

test("get_order_status returns the most recent order's real fulfillment status", async () => {
  const context = await freshContext();
  await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: context.conversationId,
      summary: "1x Smartwatch",
      totalAmount: 145000,
      currency: "COP",
      fulfillmentStatus: "SHIPPED",
      shippedAt: new Date(),
      shipmentNote: "Enviado por Interrapidisimo",
    },
  });

  const result = (await runCatalogTool(context, "get_order_status", {})) as { found: boolean; fulfillmentStatus: string; shipmentNote: string };
  assert.equal(result.found, true);
  assert.equal(result.fulfillmentStatus, "SHIPPED");
  assert.equal(result.shipmentNote, "Enviado por Interrapidisimo");

  await prisma.order.deleteMany({ where: { conversationId: context.conversationId } });
});

test("cancel_order reports reason:no_order when the customer has no order", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "cancel_order", {});
  assert.deepEqual(result, { canceled: false, reason: "no_order", note: "Este cliente no tiene ningun pedido registrado." });
});

test("cancel_order cancels a pending order and notifies the owner", async () => {
  stubWhatsappFetch();
  try {
    const context = await freshContext();
    await prisma.order.create({
      data: { businessId, customerId, conversationId: context.conversationId, summary: "1x Smartwatch", totalAmount: 145000, currency: "COP" },
    });

    const result = await runCatalogTool(context, "cancel_order", {});
    assert.deepEqual(result, { canceled: true });

    const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: context.conversationId } });
    assert.equal(order.fulfillmentStatus, "CANCELED");
    assert.ok(order.canceledAt);
    assert.equal(sentMessages.length, 1, "owner must be notified about the cancellation");
    assert.match(sentMessages[0].body, /cancelad/i);

    await prisma.order.deleteMany({ where: { conversationId: context.conversationId } });
  } finally {
    restoreFetch();
  }
});

test("cancel_order refuses an already-shipped order instead of canceling it", async () => {
  const context = await freshContext();
  await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: context.conversationId,
      summary: "1x Smartwatch",
      totalAmount: 145000,
      currency: "COP",
      fulfillmentStatus: "SHIPPED",
      shippedAt: new Date(),
    },
  });

  const result = await runCatalogTool(context, "cancel_order", {});
  assert.equal((result as { canceled: boolean; reason: string }).canceled, false);
  assert.equal((result as { canceled: boolean; reason: string }).reason, "already_shipped");

  const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: context.conversationId } });
  assert.equal(order.fulfillmentStatus, "SHIPPED", "must not touch a shipped order's status");

  await prisma.order.deleteMany({ where: { conversationId: context.conversationId } });
});

test("cancel_order refuses an already-canceled order", async () => {
  const context = await freshContext();
  await prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: context.conversationId,
      summary: "1x Smartwatch",
      totalAmount: 145000,
      currency: "COP",
      fulfillmentStatus: "CANCELED",
      canceledAt: new Date(),
    },
  });

  const result = await runCatalogTool(context, "cancel_order", {});
  assert.deepEqual(result, { canceled: false, reason: "already_canceled", note: "Este pedido ya estaba cancelado." });

  await prisma.order.deleteMany({ where: { conversationId: context.conversationId } });
});

test("close_conversation SOLD with unresolvable items notifies the owner about them", async () => {
  stubWhatsappFetch();
  // El nombre real no puede compartir palabras con el inventado: resolveOrderItems busca por relevancia,
  // y con "Producto ..." de los dos lados el item inventado cae en la MISMA linea del real y nunca llega a
  // `unresolved`, que es justo lo que este test mide.
  const realProductName = `Reloj Aviso ${randomUUID()}`;
  await prisma.product.create({
    data: { businessId, name: realProductName, description: "x", price: 30000, currency: "COP", stock: 10 },
  });
  try {
    const context = await freshContext();
    // context.businessId (the shared fixture) has a contactPhone configured, so this sale also requires
    // owner confirmation (pending:true, not closed:true) - the unresolved-items alert fires regardless.
    //
    // El pedido es PARCIAL a proposito: una linea que resuelve y otra que no. Ese es el caso que este
    // aviso existe para cubrir - el pedido se guarda igual y la duena tiene que saber que le falta algo.
    // Un cierre donde NO resuelve NINGUNA linea ya no llega hasta aca: se bloquea antes, sin pedido y sin
    // aviso, porque no hay ningun pedido parcial del que avisar (ver el test del guard mas abajo).
    await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Pedido con un item que no existe en el catalogo",
      items: [
        { productName: realProductName, quantity: 1 },
        { productName: "Zapatilla inexistente absoluta", quantity: 1 },
      ],
    });

    assert.equal(sentMessages.length, 1, "owner must be alerted about the unresolved item");
    assert.match(sentMessages[0].body, /Zapatilla inexistente absoluta/);

    await prisma.order.deleteMany({ where: { conversationId: context.conversationId } });
  } finally {
    restoreFetch();
    await prisma.product.deleteMany({ where: { businessId, name: realProductName } });
  }
});

// Fase 6: antes de la compuerta, "sin contactPhone" auto-confirmaba la venta igual (requestSaleConfirmation
// no tenia a quien pedirle confirmacion) y solo quedaba un OwnerMessageLog fallido como rastro. Ahora falta
// SOLO el telefono de contacto (con metodo de pago y tarifa de envio reales) ya alcanza para bloquear -
// requestSaleConfirmation ni se llega a invocar, asi que no queda ningun OwnerMessageLog.
test("close_conversation SOLD is blocked when only the contact phone is missing, even with payment methods and shipping configured", async () => {
  const businessNoContact = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  await seedSaleGateRequirements(businessNoContact.id);
  const customer2 = await prisma.customer.create({ data: { businessId: businessNoContact.id, phoneNumber: `573003${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });

  try {
    const context: ToolContext = {
      businessId: businessNoContact.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Compra sin telefono de contacto configurado",
    })) as { closed: boolean; blocked?: boolean; missing?: string[] };
    assert.equal(result.closed, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.missing, ["teléfono de contacto"]);

    const logs = await prisma.ownerMessageLog.findMany({ where: { businessId: businessNoContact.id } });
    assert.equal(logs.length, 0, "la compuerta bloquea antes de que requestSaleConfirmation llegue a registrar nada");
  } finally {
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.ownerMessageLog.deleteMany({ where: { businessId: businessNoContact.id } });
    await prisma.paymentMethod.deleteMany({ where: { businessId: businessNoContact.id } });
    await prisma.shippingRate.deleteMany({ where: { businessId: businessNoContact.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: businessNoContact.id } });
  }
});

test("get_shipping_rate_for_city reports matched:false when no city rules are configured", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "get_shipping_rate_for_city", { city: "Bogota" });
  assert.equal((result as { matched: boolean }).matched, false);
});

test("get_shipping_rate_for_city matches exactly, case/accent-insensitively, against a configured rule", async () => {
  await prisma.shippingRate.create({ data: { businessId, label: "Bogotá", cost: 9000, sortOrder: 1 } });
  await prisma.shippingCityRule.create({ data: { businessId, city: "Bogotá", normalizedCity: "bogota", label: "Bogotá" } });
  try {
    const context = await freshContext();
    const result = (await runCatalogTool(context, "get_shipping_rate_for_city", { city: "bogota" })) as {
      matched: boolean;
      label: string;
      cost: string;
    };
    assert.equal(result.matched, true);
    assert.equal(result.label, "Bogotá");
    assert.equal(Number(result.cost), 9000);
  } finally {
    await prisma.shippingCityRule.deleteMany({ where: { businessId } });
    await prisma.shippingRate.deleteMany({ where: { businessId } });
  }
});

test("get_shipping_rate_for_city degrades to matched:false when the rule's label points at no real ShippingRate", async () => {
  await prisma.shippingCityRule.create({ data: { businessId, city: "Soacha", normalizedCity: "soacha", label: "Soacha (ya no existe)" } });
  try {
    const context = await freshContext();
    const result = await runCatalogTool(context, "get_shipping_rate_for_city", { city: "Soacha" });
    assert.equal((result as { matched: boolean }).matched, false);
  } finally {
    await prisma.shippingCityRule.deleteMany({ where: { businessId } });
  }
});

test("get_previous_conversation reports found:false when the customer has no closed conversation", async () => {
  // Dedicated customer, not the shared module-level one - many earlier tests in this file close
  // conversations (SOLD/LOST) for the shared customer via close_conversation, so it can't be assumed
  // clean here.
  const freshCustomer = await prisma.customer.create({ data: { businessId, phoneNumber: `573002${Date.now()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: freshCustomer.id } });
  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId: freshCustomer.id,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573009998877",
  };
  try {
    const result = await runCatalogTool(context, "get_previous_conversation", {});
    assert.equal((result as { found: boolean }).found, false);
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: freshCustomer.id } });
    await prisma.customer.deleteMany({ where: { id: freshCustomer.id } });
  }
});

test("get_previous_conversation returns the most recent closed conversation, excluding the current open one", async () => {
  const freshCustomer = await prisma.customer.create({ data: { businessId, phoneNumber: `573003${Date.now()}` } });
  const closed = await prisma.conversation.create({
    data: { customerId: freshCustomer.id, status: "SOLD", contextSummary: "Compró un smartwatch, envío a Bogotá" },
  });
  const conversation = await prisma.conversation.create({ data: { customerId: freshCustomer.id } });
  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId: freshCustomer.id,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573009998877",
  };
  try {
    const result = (await runCatalogTool(context, "get_previous_conversation", {})) as {
      found: boolean;
      outcome: string;
      summary: string;
    };
    assert.equal(result.found, true);
    assert.equal(result.outcome, "SOLD");
    assert.match(result.summary, /smartwatch/i);
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: freshCustomer.id } });
    await prisma.customer.deleteMany({ where: { id: freshCustomer.id } });
  }
});

test("get_previous_conversation falls back to pendingOrderSummary when contextSummary is missing", async () => {
  const freshCustomer = await prisma.customer.create({ data: { businessId, phoneNumber: `573004${Date.now()}` } });
  const closed = await prisma.conversation.create({
    data: { customerId: freshCustomer.id, status: "LOST", pendingOrderSummary: "Cotizó pero no confirmó" },
  });
  const conversation = await prisma.conversation.create({ data: { customerId: freshCustomer.id } });
  const context: ToolContext = {
    businessId,
    conversationId: conversation.id,
    customerId: freshCustomer.id,
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573009998877",
  };
  try {
    const result = (await runCatalogTool(context, "get_previous_conversation", {})) as { summary: string };
    assert.match(result.summary, /cotiz/i);
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: freshCustomer.id } });
    await prisma.customer.deleteMany({ where: { id: freshCustomer.id } });
  }
});

test("get_shipping_rate_for_city resolves a Cundinamarca municipio to the Regional tier", async () => {
  await prisma.shippingRate.create({ data: { businessId, label: "Regional (otros municipios de Cundinamarca)", cost: 12500, sortOrder: 3 } });
  await prisma.shippingCityRule.create({
    data: { businessId, city: "Zipaquirá", normalizedCity: "zipaquira", label: "Regional (otros municipios de Cundinamarca)" },
  });
  try {
    const context = await freshContext();
    const result = (await runCatalogTool(context, "get_shipping_rate_for_city", { city: "zipaquira" })) as {
      matched: boolean;
      label: string;
      cost: string;
    };
    assert.equal(result.matched, true);
    assert.equal(result.label, "Regional (otros municipios de Cundinamarca)");
    assert.equal(Number(result.cost), 12500);
  } finally {
    await prisma.shippingCityRule.deleteMany({ where: { businessId } });
    await prisma.shippingRate.deleteMany({ where: { businessId } });
  }
});

test("get_shipping_rate_for_city resolves a department capital to the Nacional tier", async () => {
  await prisma.shippingRate.create({ data: { businessId, label: "Nacional (principales ciudades de Colombia)", cost: 18500, sortOrder: 4 } });
  await prisma.shippingCityRule.create({
    data: { businessId, city: "Medellín", normalizedCity: "medellin", label: "Nacional (principales ciudades de Colombia)" },
  });
  try {
    const context = await freshContext();
    const result = (await runCatalogTool(context, "get_shipping_rate_for_city", { city: "Medellin" })) as {
      matched: boolean;
      label: string;
      cost: string;
    };
    assert.equal(result.matched, true);
    assert.equal(result.label, "Nacional (principales ciudades de Colombia)");
    assert.equal(Number(result.cost), 18500);
  } finally {
    await prisma.shippingCityRule.deleteMany({ where: { businessId } });
    await prisma.shippingRate.deleteMany({ where: { businessId } });
  }
});

// Track C item 3 (ONIX-RELIABILITY-PLAN.md): the input-validation gate in runCatalogTool. Regression for
// a malformed call being silently coerced (an array/object stringified to "[object Object]", a bad
// `items` entry treated as if it just wasn't there) instead of rejected with a clear, actionable error.

test("find_products_by_attributes rejects an object passed where category should be a string", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "find_products_by_attributes", { category: { foo: "bar" } })) as {
    error: string;
  };
  assert.match(result.error, /Input invalido para find_products_by_attributes/);
  assert.match(result.error, /category/);
});

test("close_conversation rejects an items entry missing productName instead of silently dropping it", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "close_conversation", {
    outcome: "SOLD",
    summary: "Pedido de prueba",
    items: [{ quantity: 1 }],
  })) as { error: string };
  assert.match(result.error, /Input invalido para close_conversation/);
  assert.match(result.error, /productName/);
});

test("close_conversation still accepts a well-formed call with no items field at all", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "close_conversation", { outcome: "LOST" })) as {
    closed: boolean;
    outcome: string;
  };
  assert.equal(result.closed, true);
  assert.equal(result.outcome, "LOST");
});

test("show_order_summary rejects items given as a non-array instead of silently treating it as empty", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "show_order_summary", { items: "1x Smartwatch" })) as { error: string };
  assert.match(result.error, /Input invalido para show_order_summary/);
});

test("a tool with no declared schema is unaffected by the validation gate", async () => {
  const context = await freshContext();
  const result = await runCatalogTool(context, "get_faq", {});
  assert.ok(result && typeof result === "object" && "results" in result);
});

// ==============================================================================================
// Fase 6 del plan maestro (2026-09-15) - compuerta de configuracion (getSaleGate.canSell)
// ==============================================================================================

test("show_order_summary is blocked (never resolves items) when the business cannot sell yet", async () => {
  const businessUnconfigured = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: businessUnconfigured.id, phoneNumber: `573007${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });

  try {
    const context: ToolContext = {
      businessId: businessUnconfigured.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };
    const result = (await runCatalogTool(context, "show_order_summary", { items: [] })) as {
      ready?: boolean;
      blocked?: boolean;
      missing?: string[];
      note?: string;
    };
    assert.equal(result.ready, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.missing, ["métodos de pago", "tarifas de envío", "teléfono de contacto"]);
    assert.match(result.note ?? "", /BLOQUE_VENTA_BLOQUEADA/);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: businessUnconfigured.id } });
  }
});

test("set_payment_method is blocked when the business cannot sell yet, even naming a real active payment method", async () => {
  const businessUnconfigured = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x", contactPhone: "573005550009" },
  });
  const method = await prisma.paymentMethod.create({
    data: { businessId: businessUnconfigured.id, type: "TRANSFERENCIA", label: "Nequi", details: "300", active: true },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: businessUnconfigured.id, phoneNumber: `573008${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });

  try {
    const context: ToolContext = {
      businessId: businessUnconfigured.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };
    // Falta tarifa de envio - un metodo de pago real por si solo no alcanza para vender.
    const result = (await runCatalogTool(context, "set_payment_method", { paymentMethodId: method.id })) as {
      ok?: boolean;
      blocked?: boolean;
      missing?: string[];
    };
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.missing, ["tarifas de envío"]);
  } finally {
    await prisma.paymentMethod.deleteMany({ where: { businessId: businessUnconfigured.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: businessUnconfigured.id } });
  }
});

test("close_conversation with outcome LOST is never gated by the sale-capability check", async () => {
  const businessUnconfigured = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: businessUnconfigured.id, phoneNumber: `573009${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });

  try {
    const context: ToolContext = {
      businessId: businessUnconfigured.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    };
    const result = (await runCatalogTool(context, "close_conversation", { outcome: "LOST" })) as { closed: boolean; blocked?: boolean };
    assert.equal(result.closed, true);
    assert.equal(result.blocked, undefined);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: businessUnconfigured.id } });
  }
});

// Defecto real de produccion (2026-09-15): send_product_media no distinguia foto de video, asi que un
// cliente que pedia el video de un producto que solo tiene fotos recibia las fotos y el modelo las
// anunciaba como el video. En la base de MAGByLizN son 5 productos con video contra 15 con solo fotos:
// el 75% del catalogo podia producirlo. Un caso por rama, todos contra la base real y con el fetch de
// WhatsApp mockeado (stubWhatsappFetch) - ningun servicio externo.
async function productWithMedia(name: string, media: { type: "IMAGE" | "VIDEO"; file: string }[]) {
  return prisma.product.create({
    data: {
      businessId,
      name,
      description: "Producto de prueba para el filtro de tipo de medio",
      price: 100000,
      currency: "COP",
      stock: 3,
      media: { create: media.map((m) => ({ type: m.type, url: `https://example.com/${m.file}`, s3Key: m.file })) },
    },
  });
}

test("send_product_media con mediaType video manda SOLO el video cuando el producto tiene los dos", async () => {
  stubWhatsappFetch();
  try {
    const product = await productWithMedia(`Video y foto ${randomUUID()}`, [
      { type: "IMAGE", file: "mixto.jpg" },
      { type: "VIDEO", file: "mixto.mp4" },
    ]);
    const context = await freshContext();
    const result = (await runCatalogTool(context, "send_product_media", {
      productId: product.id,
      mediaType: "video",
    })) as { sent: boolean; count: number };

    assert.equal(result.sent, true);
    assert.equal(result.count, 1, "solo el video, no la foto");
    assert.equal(sentMedia.length, 1);
    assert.equal(sentMedia[0].type, "video");
  } finally {
    restoreFetch();
  }
});

test("send_product_media con mediaType video NO manda nada si el producto solo tiene fotos", async () => {
  stubWhatsappFetch();
  try {
    const product = await productWithMedia(`Solo fotos ${randomUUID()}`, [{ type: "IMAGE", file: "solofoto.jpg" }]);
    const context = await freshContext();
    const result = (await runCatalogTool(context, "send_product_media", {
      productId: product.id,
      mediaType: "video",
    })) as { sent: boolean; reason: string };

    assert.equal(result.sent, false);
    // El motivo tiene que ser distinto del "no tiene fotos ni videos": el modelo necesita poder decirle
    // al cliente que fotos SI hay.
    assert.equal(result.reason, "Este producto tiene fotos pero no video");
    assert.equal(sentMedia.length, 0, "no se mando ni una foto en lugar del video");
  } finally {
    restoreFetch();
  }
});

test("send_product_media con mediaType imagen NO manda nada si el producto solo tiene video", async () => {
  stubWhatsappFetch();
  try {
    const product = await productWithMedia(`Solo video ${randomUUID()}`, [{ type: "VIDEO", file: "solovideo.mp4" }]);
    const context = await freshContext();
    const result = (await runCatalogTool(context, "send_product_media", {
      productId: product.id,
      mediaType: "imagen",
    })) as { sent: boolean; reason: string };

    assert.equal(result.sent, false);
    assert.equal(result.reason, "Este producto tiene video pero no fotos");
    assert.equal(sentMedia.length, 0);
  } finally {
    restoreFetch();
  }
});

test("send_product_media sin mediaType manda todo, como siempre", async () => {
  stubWhatsappFetch();
  try {
    const product = await productWithMedia(`Sin tipo pedido ${randomUUID()}`, [
      { type: "IMAGE", file: "sintipo.jpg" },
      { type: "VIDEO", file: "sintipo.mp4" },
    ]);
    const context = await freshContext();
    const result = (await runCatalogTool(context, "send_product_media", { productId: product.id })) as {
      sent: boolean;
      count: number;
    };

    assert.equal(result.sent, true);
    assert.equal(result.count, 2);
    assert.equal(sentMedia.length, 2);
  } finally {
    restoreFetch();
  }
});

// Incidente real 2026-09-16 (conversacion cmu4gniqe000se82kdrhvrw6d): 4 fotos y 2 videos del mismo
// producto. Una parte salia dentro del MISMO turno: el presentador del servidor ya tenia los medios
// armados para salir, pero el registro de la base se escribe recien cuando esos bloques se envian
// (despues del turno), asi que una llamada del modelo en ese mismo turno no veia nada y mandaba de nuevo.
test("send_product_media no reenvia lo que el presentador ya tiene armado para este turno", async () => {
  stubWhatsappFetch();
  try {
    const watch = await prisma.product.create({
      data: {
        businessId,
        name: "Smartwatch Queued Test",
        description: "Reloj deportivo",
        price: 140000,
        currency: "COP",
        stock: 5,
        media: { create: [{ type: "IMAGE", url: "https://example.com/queued.jpg", s3Key: "queued.jpg" }] },
      },
    });
    const base = await freshContext();
    const context: ToolContext = { ...base, mediaQueuedProductIds: [watch.id] };

    const result = (await runCatalogTool(context, "send_product_media", { productId: watch.id })) as {
      sent: boolean;
      alreadyGoingOutThisTurn?: boolean;
    };
    assert.equal(result.sent, true, "el cliente igual recibe las fotos: salen en los bloques de este turno");
    assert.equal(result.alreadyGoingOutThisTurn, true);
    assert.equal(sentMedia.length, 0, "pero no se manda una segunda copia por esta via");

    // Turno posterior: el presentador ya no las adjunta (dedup por conversacion), asi que un reenvio
    // explicito del cliente tiene que llegar.
    const despues = (await runCatalogTool({ ...base, mediaQueuedProductIds: [] }, "send_product_media", {
      productId: watch.id,
    })) as { sent: boolean };
    assert.equal(despues.sent, true);
    assert.equal(sentMedia.length, 1, "el reenvio explicito de un turno posterior si sale");
  } finally {
    restoreFetch();
  }
});

// ==============================================================================================
// Un pedido sin lineas no es un pedido (2026-09-17)
// ==============================================================================================
//
// Defecto real de produccion, pedido cmu4suduh001sq92ka4r3j35y: el guard de "no hay items" vivia dentro
// de `if (saleStateOn && ...)`, el negocio tiene saleStateEnabled en false, y quedo guardada una venta
// con cero lineas, totalAmount 0 y sin forma de saber que se vendio. Con SaleState apagado el modelo
// sigue dictando los items, asi que el guard tiene que valer en los dos modos.

// El negocio va aparte del compartido a proposito: con la compuerta de venta satisfecha (metodo de pago,
// tarifa de envio y telefono de contacto reales) lo unico que puede bloquear el cierre es el guard de
// items, que es lo que se esta probando. Si la compuerta bloqueara antes, la prueba pasaria por el motivo
// equivocado.
async function vendibleContext(): Promise<{ context: ToolContext; cleanup: () => Promise<void> }> {
  const business2 = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573005551111",
      contactName: "Owner",
    },
  });
  await seedSaleGateRequirements(business2.id);
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573008${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.message.create({ data: { conversationId: conversation2.id, role: "CUSTOMER", content: "Hola" } });
  return {
    context: {
      businessId: business2.id,
      conversationId: conversation2.id,
      customerId: customer2.id,
      credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
      recipientPhone: "573009998877",
    },
    cleanup: async () => {
      await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
      await prisma.message.deleteMany({ where: { conversationId: conversation2.id } });
      await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
      await prisma.paymentMethod.deleteMany({ where: { businessId: business2.id } });
      await prisma.shippingRate.deleteMany({ where: { businessId: business2.id } });
      await prisma.product.deleteMany({ where: { businessId: business2.id } });
      await prisma.customer.deleteMany({ where: { id: customer2.id } });
      await prisma.business.deleteMany({ where: { id: business2.id } });
    },
  };
}

test("close_conversation SOLD sin ningun item no cierra nada ni crea un pedido vacio", async () => {
  const { context, cleanup } = await vendibleContext();
  try {
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Venta de 1x Smartwatch, pago contra entrega.",
      shippingAddress: "Calle 22 #108-62",
      items: [],
    })) as { closed: boolean; note: string };

    assert.equal(result.closed, false);
    assert.match(result.note, /no se creo ningun pedido/i);
    assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
    const conversation = await prisma.conversation.findUnique({ where: { id: context.conversationId } });
    assert.notEqual(conversation?.status, "SOLD", "no se puede marcar vendida una conversacion sin pedido");
  } finally {
    await cleanup();
  }
});

test("close_conversation SOLD cuando NINGUN item resuelve contra el catalogo tampoco crea el pedido", async () => {
  const { context, cleanup } = await vendibleContext();
  try {
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Venta de 1x producto que no existe",
      items: [{ productName: "Producto que no existe en ningun catalogo", quantity: 1 }],
    })) as { closed: boolean; note: string };

    assert.equal(result.closed, false);
    assert.match(result.note, /no se creo ningun pedido/i);
    assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
  } finally {
    await cleanup();
  }
});

// ==============================================================================================
// No se le pide al dueno que confirme plata que todavia no existe (2026-09-17)
// ==============================================================================================

test("close_conversation SOLD con contraentrega crea el pedido sin pedirle confirmacion al dueno", async () => {
  const business2 = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573005552222",
      contactName: "Owner",
    },
  });
  await prisma.paymentMethod.create({
    data: { businessId: business2.id, type: "EFECTIVO", label: "Contraentrega", details: "Paga al recibir", settlement: "ON_DELIVERY" },
  });
  await prisma.shippingRate.create({ data: { businessId: business2.id, label: "Estandar", cost: 9000 } });
  await prisma.product.create({
    data: { businessId: business2.id, name: "Reloj Contraentrega", description: "x", price: 140000, currency: "COP", stock: 5 },
  });
  const customer2 = await prisma.customer.create({ data: { businessId: business2.id, phoneNumber: `573010${Date.now()}` } });
  const conversation2 = await prisma.conversation.create({ data: { customerId: customer2.id } });
  await prisma.message.create({ data: { conversationId: conversation2.id, role: "CUSTOMER", content: "Hola" } });

  stubWhatsappFetch();
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
      summary: "1x Reloj Contraentrega",
      paymentMethodLabel: "Contraentrega",
      shippingAddress: "Calle 22 #108-62",
      items: [{ productName: "Reloj Contraentrega", quantity: 1 }],
    })) as { closed: boolean; pending?: boolean };

    assert.equal(result.closed, true, "contraentrega no tiene pago que verificar: el pedido se crea de una");
    assert.equal(result.pending, undefined);
    assert.equal(await prisma.order.count({ where: { conversationId: conversation2.id } }), 1);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation2.id } });
    assert.equal(conversation.pendingConfirmationAskedAt, null, "no puede quedar ninguna confirmacion viva");
  } finally {
    restoreFetch();
    await prisma.orderItem.deleteMany({ where: { order: { conversationId: conversation2.id } } });
    await prisma.order.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation2.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation2.id } });
    await prisma.paymentMethod.deleteMany({ where: { businessId: business2.id } });
    await prisma.shippingRate.deleteMany({ where: { businessId: business2.id } });
    await prisma.product.deleteMany({ where: { businessId: business2.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});

test("close_conversation SOLD con transferencia sigue esperando la confirmacion del dueno", async () => {
  const { context, cleanup } = await vendibleContext();
  stubWhatsappFetch();
  try {
    await prisma.product.create({
      data: { businessId: context.businessId, name: "Reloj Anticipado", description: "x", price: 140000, currency: "COP", stock: 5 },
    });
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "1x Reloj Anticipado",
      paymentMethodLabel: "Nequi",
      items: [{ productName: "Reloj Anticipado", quantity: 1 }],
    })) as { closed: boolean; pending?: boolean };

    assert.equal(result.closed, false);
    assert.equal(result.pending, true);
    assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
  } finally {
    restoreFetch();
    await cleanup();
  }
});

// ==============================================================================================
// Un pedido nuevo no hereda nada del anterior (2026-09-17)
// ==============================================================================================
//
// La garantia NO vive en el texto que el servidor le inyecta al modelo - ahi solo van los datos del
// pedido cerrado. Vive aca: un cliente que ya compro no puede terminar con un segundo pedido armado por
// suposicion, porque cerrar sigue exigiendo lineas reales del catalogo y la variante elegida.

test("un cliente con un pedido anterior no puede cerrar otro sin productos propios", async () => {
  const { context, cleanup } = await vendibleContext();
  try {
    // Pedido anterior, cerrado, con su direccion y su forma de pago.
    const anterior = await prisma.conversation.create({ data: { customerId: context.customerId, status: "SOLD" } });
    await prisma.order.create({
      data: {
        businessId: context.businessId,
        customerId: context.customerId,
        conversationId: anterior.id,
        summary: "1x Reloj anterior",
        shippingAddress: "Calle 22 #108-62",
        paymentMethodLabel: "Contraentrega",
        totalAmount: 149000,
        currency: "COP",
      },
    });

    // El turno nuevo intenta cerrar sin decir que producto: heredarlo del anterior no es una opcion.
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Otro igual al anterior",
      shippingAddress: "Calle 22 #108-62",
      items: [],
    })) as { closed: boolean; note: string };

    assert.equal(result.closed, false);
    assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
  } finally {
    await prisma.order.deleteMany({ where: { customerId: context.customerId } });
    await prisma.conversation.deleteMany({ where: { customerId: context.customerId, id: { not: context.conversationId } } });
    await cleanup();
  }
});

test("un pedido nuevo de un producto con variantes no se cierra sin la variante elegida", async () => {
  const { context, cleanup } = await vendibleContext();
  try {
    const producto = await prisma.product.create({
      data: { businessId: context.businessId, name: "Reloj Con Colores", description: "x", price: 140000, currency: "COP", stock: 5 },
    });
    await prisma.productVariant.createMany({
      data: [
        { productId: producto.id, color: "negro", stock: 3, active: true },
        { productId: producto.id, color: "gris", stock: 2, active: true },
      ],
    });

    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "1x Reloj Con Colores",
      items: [{ productName: "Reloj Con Colores", quantity: 1 }],
    })) as { closed: boolean; note: string };

    assert.equal(result.closed, false, "sin color elegido no se cierra: no se asume el del pedido anterior");
    assert.match(result.note, /color/i);
    assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
  } finally {
    await cleanup();
  }
});
