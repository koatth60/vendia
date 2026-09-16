import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runCatalogTool, type ToolContext } from "./tools";
import { handleOwnerReply } from "../routes/whatsapp";

// 2026-09-16: close_conversation recibia la forma de pago como TEXTO LIBRE, o sea que el modelo tenia que
// reproducir de memoria la cadena exacta de get_payment_methods. Medido en produccion y en la corrida de
// regresion del mismo dia, cualquier variacion razonable ("Nequi (transferencia anticipada del producto)")
// hacia que el guard de agent.ts rechazara el cierre y el cliente leyera "el sistema no me deja cerrar la
// venta automaticamente". Ahora la etiqueta la resuelve el servidor desde paymentMethodId contra la base.
// Sin llamadas al modelo: fetch de WhatsApp queda stubeado, las credenciales son falsas.

let businessId: string;
let customerId: string;
let productId: string;
let nequiId: string;
let originalFetch: typeof fetch;

const CREDENTIALS = { phoneNumberId: "test-id", accessToken: "test-token" };
const OWNER_PHONE = "573000000000";

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }),
    text: async () => "",
  })) as unknown as typeof fetch;

  const business = await prisma.business.create({
    data: {
      name: `Test Close Payment ${randomUUID()}`,
      email: `test-close-payment-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: OWNER_PHONE,
      contactName: "Owner",
    },
  });
  businessId = business.id;
  await prisma.shippingRate.create({ data: { businessId, label: "Estandar", cost: 9000 } });
  const nequi = await prisma.paymentMethod.create({
    data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "3001234567", active: true },
  });
  nequiId = nequi.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573004${Date.now()}`, name: "Camila" } });
  customerId = customer.id;
  const product = await prisma.product.create({
    data: { businessId, name: `Parlante Cierre ${randomUUID()}`, description: "x", price: 50000, currency: "COP", stock: 10 },
  });
  productId = product.id;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.shippingRate.deleteMany({ where: { businessId } });
  await prisma.ownerMessageLog.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

async function freshContext(): Promise<ToolContext> {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  await prisma.message.create({ data: { conversationId: conversation.id, role: "CUSTOMER", content: "Ya pague" } });
  return {
    businessId,
    conversationId: conversation.id,
    customerId,
    credentials: CREDENTIALS,
    recipientPhone: "573009998877",
  };
}

async function closeSold(context: ToolContext, extra: Record<string, unknown>) {
  return (await runCatalogTool(context, "close_conversation", {
    outcome: "SOLD",
    summary: "1x Parlante",
    items: [{ productName: "Parlante Cierre", quantity: 1 }],
    shippingAddress: "Calle 1, Bogota",
    shippingCost: 9000,
    ...extra,
  })) as { closed: boolean; pending?: boolean; note?: string };
}

/** El dueno responde "si" a la confirmacion pendiente: es el paso que crea el Order real. */
async function ownerConfirms(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.ok(conversation.pendingConfirmationMessageId, "close_conversation debio dejar una confirmacion pendiente");
  await handleOwnerReply(businessId, CREDENTIALS, OWNER_PHONE, {
    type: "text",
    text: { body: "si" },
    context: { id: conversation.pendingConfirmationMessageId! },
  });
}

test("close_conversation con paymentMethodId guarda la etiqueta EXACTA de la base en el Order", async () => {
  const context = await freshContext();
  const result = await closeSold(context, { paymentMethodId: nequiId });
  assert.equal(result.pending, true);

  await ownerConfirms(context.conversationId);
  const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
  assert.ok(order, "el pedido real tiene que existir");
  assert.equal(order!.paymentMethodLabel, "Nequi");
});

test("close_conversation con un paymentMethodId inexistente no cierra ni deja nada creado", async () => {
  const context = await freshContext();
  const result = await closeSold(context, { paymentMethodId: randomUUID() });
  assert.equal(result.closed, false);
  assert.match(result.note ?? "", /no existe/i);

  const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
  assert.equal(order, null);
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: context.conversationId } });
  assert.equal(conversation.pendingConfirmationAskedAt, null, "tampoco puede quedar una confirmacion pendiente");
  assert.equal(conversation.status, "NEW");
});

// Los tres casos reales medidos el 2026-09-16: dos de la corrida de regresion (las UNICAS 2
// intervenciones del guard en 470 turnos de cliente) y uno de los logs de produccion. Como texto libre
// solo, el guard de agent.ts los rechaza (ver agent.paymentGuard.test.ts) y la venta no se cierra sola;
// con el id al lado, la prosa del modelo deja de importar.
for (const escrito of [
  "Nequi (transferencia anticipada del producto)",
  "Nequi (transferencia anticipada)",
  "Contra entrega total",
]) {
  test(`close_conversation ignora el texto libre "${escrito}" cuando viene el paymentMethodId`, async () => {
    const context = await freshContext();
    const result = await closeSold(context, { paymentMethodId: nequiId, paymentMethodLabel: escrito });
    assert.equal(result.pending, true);

    await ownerConfirms(context.conversationId);
    const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
    assert.equal(order!.paymentMethodLabel, "Nequi");
  });
}

test("sin paymentMethodId, el label sigue siendo el camino de respaldo, tal cual hoy", async () => {
  const context = await freshContext();
  const result = await closeSold(context, { paymentMethodLabel: "Nequi" });
  assert.equal(result.pending, true);

  await ownerConfirms(context.conversationId);
  const order = await prisma.order.findUnique({ where: { conversationId: context.conversationId } });
  assert.equal(order!.paymentMethodLabel, "Nequi");
});
