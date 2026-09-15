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
    },
  });
  businessId = business.id;
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

test("close_conversation SOLD con la bandera activa cierra con los items de SaleState y borra el estado en curso", async () => {
  const context = await freshContext();
  await runCatalogTool(context, "set_order_item", { productId, quantity: 1 });

  const result = (await runCatalogTool(context, "close_conversation", {
    outcome: "SOLD",
    summary: "Venta de prueba SaleState",
  })) as { closed: boolean };
  assert.equal(result.closed, true);

  const order = await prisma.order.findUniqueOrThrow({ where: { conversationId: context.conversationId }, include: { items: true } });
  assert.equal(order.items.length, 1);
  assert.equal(Number(order.totalAmount), 30000);

  const state = await prisma.saleState.findUnique({ where: { conversationId: context.conversationId } });
  assert.equal(state, null);
});

test("close_conversation SOLD con la bandera activa bloquea si todavia no hay productos", async () => {
  const context = await freshContext();
  const result = (await runCatalogTool(context, "close_conversation", { outcome: "SOLD", summary: "x" })) as {
    closed: boolean;
    note?: string;
  };
  assert.equal(result.closed, false);
  assert.match(result.note ?? "", /set_order_item/);
});
