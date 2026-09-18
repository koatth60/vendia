import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { createOrder, markOrderCanceled, markOrderShipped, resolveOrderItems } from "./service";
import { TransicionNoPermitida } from "./stateMachine";

// E32 (2026-09-18). Cancelar devuelve el stock.
//
// El stock se descontaba en la venta y NO volvia nunca: cada cancelacion destruia unidades para
// siempre. Y el descuento venia con Math.max(0, ...), que tapaba la sobreventa y ademas hacia
// imposible devolver lo justo - se habia descontado hasta cero, no lo que decia el pedido.

const negocios: string[] = [];

after(async () => {
  for (const id of negocios) {
    await prisma.orderEvent.deleteMany({ where: { businessId: id } });
    await prisma.orderItem.deleteMany({ where: { order: { businessId: id } } });
    await prisma.order.deleteMany({ where: { businessId: id } });
    await prisma.conversation.deleteMany({ where: { customer: { businessId: id } } });
    await prisma.customer.deleteMany({ where: { businessId: id } });
    await prisma.productVariant.deleteMany({ where: { product: { businessId: id } } });
    await prisma.product.deleteMany({ where: { businessId: id } });
    await prisma.business.deleteMany({ where: { id } });
  }
});

async function sembrar(stockInicial: number) {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x", active: true },
  });
  negocios.push(business.id);
  const customer = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: `5732${Date.now()}${Math.floor(Math.random() * 100)}` },
  });
  const producto = await prisma.product.create({
    data: {
      businessId: business.id,
      name: `Reloj E32 ${randomUUID().slice(0, 6)}`,
      description: "x",
      price: 10000,
      currency: "COP",
      stock: stockInicial,
    },
  });
  return { businessId: business.id, customerId: customer.id, producto };
}

async function comprar(businessId: string, customerId: string, nombre: string, cantidad: number) {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const { items } = await resolveOrderItems(businessId, [{ productName: nombre, quantity: cantidad }]);
  const order = await createOrder({
    businessId,
    customerId,
    conversationId: conversation.id,
    summary: `${cantidad}x ${nombre}`,
    items,
  });
  return order;
}

test("E32: cancelar devuelve exactamente las unidades que descontó", async () => {
  const { businessId, customerId, producto } = await sembrar(5);

  const order = await comprar(businessId, customerId, producto.name, 2);
  const vendido = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(vendido.stock, 3, "la venta descuenta 2 de 5");

  await markOrderCanceled(businessId, order.id);

  const devuelto = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(devuelto.stock, 5, "cancelar tiene que dejarlo como estaba");
});

test("E32: el descuento ya no recorta en cero, asi que la sobreventa se ve y se puede deshacer", async () => {
  const { businessId, customerId, producto } = await sembrar(1);

  const order = await comprar(businessId, customerId, producto.name, 3);
  const vendido = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(vendido.stock, -2, "vender 3 con 1 deja -2: faltan 2, y eso es un dato, no un error");

  await markOrderCanceled(businessId, order.id);

  const devuelto = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(devuelto.stock, 1, "y la devolucion cierra igual de exacta");
});

test("E32: no se puede cancelar dos veces, asi que el stock no se devuelve dos veces", async () => {
  const { businessId, customerId, producto } = await sembrar(4);
  const order = await comprar(businessId, customerId, producto.name, 1);
  await markOrderCanceled(businessId, order.id);

  await assert.rejects(() => markOrderCanceled(businessId, order.id), TransicionNoPermitida);

  const final = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(final.stock, 4, "una sola devolucion, no dos");
});

test("E32: enviar NO devuelve stock - solo cancelar", async () => {
  const { businessId, customerId, producto } = await sembrar(6);
  const order = await comprar(businessId, customerId, producto.name, 2);

  await markOrderShipped(businessId, order.id, { note: "salio" });

  const final = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(final.stock, 4, "el pedido salio: esas unidades no vuelven");
});

test("E32: con variantes, la devolucion va a la variante y no al producto padre", async () => {
  const { businessId, customerId, producto } = await sembrar(0);
  const variante = await prisma.productVariant.create({
    data: { productId: producto.id, color: "Negro", stock: 7 },
  });

  const conversation = await prisma.conversation.create({ data: { customerId } });
  const order = await createOrder({
    businessId,
    customerId,
    conversationId: conversation.id,
    summary: `3x ${producto.name} Negro`,
    items: [
      {
        productId: producto.id,
        productName: producto.name,
        variantId: variante.id,
        variantLabel: "Negro",
        quantity: 3,
        unitPrice: 10000,
        currency: "COP",
      },
    ],
  });

  const vendida = await prisma.productVariant.findUniqueOrThrow({ where: { id: variante.id } });
  assert.equal(vendida.stock, 4);

  await markOrderCanceled(businessId, order.id);

  const devuelta = await prisma.productVariant.findUniqueOrThrow({ where: { id: variante.id } });
  assert.equal(devuelta.stock, 7);
  const padre = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
  assert.equal(padre.stock, 0, "el producto padre no se toca cuando el stock vive en la variante");
});
