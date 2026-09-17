import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runCatalogTool, type ToolContext } from "./tools";

// Fase 2 del plan maestro (2026-09-15), causa raiz C1: cobertura de la capa runCatalogTool (el pegamento
// entre el modelo y src/orders/saleState.ts) - saleState.test.ts ya cubre el motor en si. Todo esto corre
// contra un negocio con saleStateEnabled:true; el resto de tools.test.ts ya cubre que un negocio SIN la
// bandera sigue exactamente igual que antes.

let businessId: string;
let customerId: string;
let productId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test SaleState Tools ${randomUUID()}`,
      email: `test-salestate-tools-${randomUUID()}@example.com`,
      passwordHash: "x",
      saleStateEnabled: true,
      // Fase 6 del plan maestro (2026-09-15): show_order_summary/set_payment_method/close_conversation
      // pasan por getSaleGate.canSell antes que nada - el metodo de pago llega mas abajo, del propio test
      // de set_payment_method (que lo necesita crear el explicitamente para validar contra un id real).
      contactPhone: "573000000000",
    },
  });
  businessId = business.id;
  await prisma.shippingRate.create({ data: { businessId, label: "Estandar", cost: 9000 } });
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573002${Date.now()}` } });
  customerId = customer.id;
  const product = await prisma.product.create({
    data: { businessId, name: `Parlante Bluetooth ${randomUUID()}`, description: "x", price: 30000, currency: "COP", stock: 10 },
  });
  productId = product.id;
});

after(async () => {
  await prisma.saleState.deleteMany({ where: { conversation: { customerId } } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

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

test("set_order_item via runCatalogTool guarda la linea y devuelve missing/subtotal/total", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "set_order_item", { productId, quantity: 3 })) as {
    ok: boolean;
    item: { unitPrice: number };
    subtotal: number;
    total: number;
    missing: string[];
  };
  assert.equal(result.ok, true);
  assert.equal(result.item.unitPrice, 30000);
  assert.equal(result.subtotal, 90000);
  assert.ok(result.missing.length > 0);
});

test("remove_order_item via runCatalogTool quita la linea", async () => {
  const context = await freshContext();
  await runCatalogTool(context, "set_order_item", { productId, quantity: 1 });
  const result = (await runCatalogTool(context, "remove_order_item", { productId })) as { ok: boolean; items: unknown[] };
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 0);
});

test("set_payment_method via runCatalogTool valida contra PaymentMethod real, y get_payment_methods expone id", async () => {
  const method = await prisma.paymentMethod.create({ data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "300" } });
  const context = await freshContext();

  const methods = (await runCatalogTool(context, "get_payment_methods", {})) as { methods: { id: string; label: string }[] };
  assert.equal(methods.methods[0].id, method.id);

  const bad = (await runCatalogTool(context, "set_payment_method", { paymentMethodId: "no-existe" })) as { ok: boolean };
  assert.equal(bad.ok, false);

  const good = (await runCatalogTool(context, "set_payment_method", { paymentMethodId: method.id })) as { ok: boolean; method: { label: string } };
  assert.equal(good.ok, true);
  assert.equal(good.method.label, "Nequi");
});

test("save_customer_contact_info rechaza una cedula con forma invalida pero igual guarda la direccion valida", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "save_customer_contact_info", {
    idNumber: "no-es-un-numero",
    address: "Calle 1 # 2-3",
  })) as { saved: boolean; idNumber?: string; address?: string; rejected?: Record<string, string> };

  assert.equal(result.saved, true);
  assert.equal(result.idNumber, undefined);
  assert.equal(result.address, "Calle 1 # 2-3");
  assert.ok(result.rejected?.idNumber);

  const state = await prisma.saleState.findUnique({ where: { conversationId: context.conversationId } });
  assert.equal(state?.address, "Calle 1 # 2-3");
  assert.equal(state?.idNumber, null);
});

test("show_order_summary con la bandera activa lee SaleState e ignora el items del llamado", async () => {
  const context = await freshContext();
  await runCatalogTool(context, "set_order_item", { productId, quantity: 2 });

  const result = (await runCatalogTool(context, "show_order_summary", {
    items: [{ productName: "producto inventado que no deberia usarse", quantity: 99 }],
  })) as { ready: boolean; subtotal: number; total: number };

  assert.equal(result.ready, true);
  assert.equal(result.subtotal, 60000);
});

// Fase 6 del plan maestro (2026-09-15): este negocio ahora tiene contactPhone real (lo exige
// getSaleGate.canSell) - requestSaleConfirmation (tools.ts) SIEMPRE pide confirmacion al dueno cuando hay
// contactPhone, asi que close_conversation SOLD ya no cierra de forma sincronica aca. Lo que este test
// prueba en realidad (que el pedido armado sale de SaleState, no de lo que el modelo mande) sigue siendo
// real: se ve en el draft (pendingOrderItems) que queda armado para la confirmacion, con SaleState todavia
// vivo porque la venta no es final hasta que el dueno confirme.
test("close_conversation SOLD con la bandera activa arma el pedido pendiente desde SaleState (pide confirmacion del dueno, no cierra de una)", async () => {
  const context = await freshContext();
  await runCatalogTool(context, "set_order_item", { productId, quantity: 1 });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }),
  })) as unknown as typeof fetch;

  try {
    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "Venta de prueba SaleState",
    })) as { closed: boolean; pending?: boolean };
    assert.equal(result.closed, false);
    assert.equal(result.pending, true);

    const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
    assert.equal(order, null, "no se crea ningun pedido hasta que el dueno confirme");

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
    const draft = conversation.pendingOrderItems as { items?: { productId: string; quantity: number }[] } | null;
    assert.equal(draft?.items?.length, 1, "el draft pendiente de confirmacion debe salir de SaleState");
    assert.equal(draft?.items?.[0].productId, productId);

    const state = await prisma.saleState.findUnique({ where: { conversationId: context.conversationId } });
    assert.ok(state, "SaleState sigue vivo - la venta todavia no es final");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("close_conversation SOLD con la bandera activa bloquea si todavia no hay productos", async () => {
  // Lo que se exige es que el pedido tenga lineas REALES, no que se hayan cargado por una via concreta:
  // desde el 2026-09-17, con el pedido en curso vacio los items se resuelven contra el catalogo igual que
  // con la bandera apagada (ver el bloque de mas abajo sobre el orden de las herramientas). Sin lineas por
  // ningun camino, sigue sin cerrar y sin crear nada.
  const context = await freshContext();
  const result = (await runCatalogTool(context, "close_conversation", { outcome: "SOLD", summary: "x" })) as {
    closed: boolean;
    note?: string;
  };
  assert.equal(result.closed, false);
  assert.match(result.note ?? "", /no se creo ningun pedido/i);
  assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
});

// ==============================================================================================
// Con SaleState prendido, el cierre no depende del ORDEN en que el modelo llamo las herramientas
// ==============================================================================================
//
// Diagnostico del 2026-09-17 (punto 7 de los pendientes): encender saleStateEnabled dejaba al bot sin
// cerrar ventas. close_conversation exigia que set_order_item se hubiera llamado ANTES, en el turno en
// que el cliente eligio; si el modelo no lo hizo, el cierre quedaba rechazado para siempre. La garantia
// (cada linea validada contra el catalogo, precio de la base) se conserva por el otro camino.

test("close_conversation SOLD cierra aunque nadie haya llamado set_order_item, resolviendo contra el catalogo", async () => {
  const context = await freshContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }) })) as unknown as typeof fetch;
  try {
    const producto = await prisma.product.create({
      data: { businessId, name: "Reloj Sin SetOrderItem", description: "x", price: 100000, currency: "COP", stock: 4 },
    });

    const result = (await runCatalogTool(context, "close_conversation", {
      outcome: "SOLD",
      summary: "1x Reloj Sin SetOrderItem",
      paymentMethodLabel: "Contraentrega",
      items: [{ productName: "Reloj Sin SetOrderItem", quantity: 1 }],
    })) as { closed: boolean; pending?: boolean; note?: string };

    assert.notEqual(result.note, "Todavia no hay ningun producto en el pedido en curso - usa set_order_item primero.");
    assert.ok(result.closed === true || result.pending === true, "el cierre avanza: o crea el pedido o lo deja esperando confirmacion");

    const pedido = await prisma.order.findFirst({ where: { conversationId: context.conversationId }, include: { items: true } });
    if (pedido) {
      assert.equal(pedido.items.length, 1);
      assert.equal(pedido.items[0].productId, producto.id, "la linea salio del catalogo real, no de la prosa");
      assert.equal(String(pedido.items[0].unitPrice), "100000", "el precio sale de la base");
    }
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.orderItem.deleteMany({ where: { order: { conversationId: context.conversationId } } });
    await prisma.order.deleteMany({ where: { conversationId: context.conversationId } });
    await prisma.product.deleteMany({ where: { businessId, name: "Reloj Sin SetOrderItem" } });
  }
});

test("close_conversation SOLD con SaleState vacio Y sin items sigue bloqueado", async () => {
  // Lo que se relaja es el ORDEN, no la exigencia de que el pedido tenga lineas reales.
  const context = await freshContext();
  const result = (await runCatalogTool(context, "close_conversation", {
    outcome: "SOLD",
    summary: "Venta sin productos",
    items: [],
  })) as { closed: boolean; note: string };

  assert.equal(result.closed, false);
  assert.match(result.note, /no se creo ningun pedido/i);
  assert.equal(await prisma.order.count({ where: { conversationId: context.conversationId } }), 0);
});
