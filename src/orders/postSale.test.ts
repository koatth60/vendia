import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getPostSaleContext, postSaleFactsForModel, POST_SALE_WINDOW_DAYS } from "./postSale";

// El pedido que el cliente ya tiene lo lee el SERVIDOR, no una herramienta que el modelo pueda no llamar.
// Caso que motiva el archivo: Andres compro, su conversacion quedo SOLD, volvio a escribir 23 minutos
// despues y eso abrio una conversacion NUEVA con historial vacio - el modelo no llamo ninguna
// herramienta y le volvio a pedir los datos de una compra ya cerrada (produccion 2026-09-17).

let businessId: string;
let customerId: string;
let conversationVieja: string;
let conversationNueva: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `PostVenta ${randomUUID()}`, email: `pv-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573009${Date.now()}` } });
  customerId = customer.id;
  const vieja = await prisma.conversation.create({ data: { customerId, status: "SOLD" } });
  conversationVieja = vieja.id;
  const nueva = await prisma.conversation.create({ data: { customerId } });
  conversationNueva = nueva.id;
});

after(async () => {
  await prisma.orderItem.deleteMany({ where: { order: { businessId } } });
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

async function crearPedido(createdAt: Date) {
  await prisma.order.deleteMany({ where: { businessId } });
  return prisma.order.create({
    data: {
      businessId,
      customerId,
      conversationId: conversationVieja,
      createdAt,
      summary: "1x Reloj Serie 12 Ultra 3, negro. Contraentrega.",
      shippingAddress: "Calle 22 #108-62, Fontibón",
      paymentMethodLabel: "Contraentrega",
      shippingCost: 9000,
      totalAmount: 149000,
      currency: "COP",
      items: {
        create: [
          { productName: "Reloj Serie 12 Ultra 3", variantLabel: "negro", quantity: 1, unitPrice: 140000, currency: "COP" },
        ],
      },
    },
  });
}

test("el pedido se encuentra aunque se haya cerrado en OTRA conversacion", async () => {
  // Es el caso de Andres: consultar por conversationId no habria encontrado nada, porque
  // Order.conversationId apunta a la conversacion vieja y el cliente escribe desde una nueva.
  await crearPedido(new Date());
  const context = await getPostSaleContext(businessId, customerId, conversationNueva);

  assert.ok(context, "el pedido del cliente tiene que aparecer desde la conversacion nueva");
  assert.equal(context.fromAnotherConversation, true);
  assert.equal(context.order.items.length, 1);
  assert.equal(context.order.items[0].variantLabel, "negro");
  assert.equal(context.order.totalAmount, "149000");
});

test("desde la misma conversacion donde se cerro, no se marca como de otra", async () => {
  await crearPedido(new Date());
  const context = await getPostSaleContext(businessId, customerId, conversationVieja);
  assert.equal(context?.fromAnotherConversation, false);
});

test("un pedido mas viejo que la ventana ya no cuenta como post-venta", async () => {
  const viejo = new Date(Date.now() - (POST_SALE_WINDOW_DAYS + 2) * 24 * 60 * 60 * 1000);
  await crearPedido(viejo);
  assert.equal(await getPostSaleContext(businessId, customerId, conversationNueva), null);
});

test("un pedido cancelado SIGUE contando: quien escribe despues no esta navegando el catalogo", async () => {
  const pedido = await crearPedido(new Date());
  await prisma.order.update({ where: { id: pedido.id }, data: { canceledAt: new Date() } });

  const context = await getPostSaleContext(businessId, customerId, conversationNueva);
  assert.ok(context);
  assert.equal(postSaleFactsForModel(context).estado, "CANCELADO");
});

test("sin ningun pedido no hay contexto post-venta", async () => {
  await prisma.orderItem.deleteMany({ where: { order: { businessId } } });
  await prisma.order.deleteMany({ where: { businessId } });
  assert.equal(await getPostSaleContext(businessId, customerId, conversationNueva), null);
});

test("los hechos que ve el modelo llevan la direccion y la forma de pago, para que no las vuelva a pedir", async () => {
  await crearPedido(new Date());
  const context = await getPostSaleContext(businessId, customerId, conversationNueva);
  const facts = postSaleFactsForModel(context!) as Record<string, unknown>;

  assert.equal(facts.direccionDeEntrega, "Calle 22 #108-62, Fontibón");
  assert.equal(facts.formaDePago, "Contraentrega");
  assert.equal(facts.total, "149000");
  assert.equal(facts.diasDesdeLaCompra, 0);
});
