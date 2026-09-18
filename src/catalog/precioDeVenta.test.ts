import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { hashPassword } from "../auth/service";
import { precioDeVenta } from "./precioDeVenta";
import { resolveOrderItems, createOrder } from "../orders/service";

// E36 (2026-09-18). El criterio de aceptacion de la etapa, textual: "un pedido de la variante cara cobra
// el precio de la variante".
//
// La otra mitad, que no esta escrita en la etapa pero es la que decide si esto se puede desplegar sin
// romper a nadie: un catalogo que NUNCA toco precios por variante tiene que comportarse exactamente
// igual que antes.

let businessId: string;
let customerId: string;
let conversationId: string;

beforeEach(async () => {
  const negocio = await prisma.business.create({
    data: {
      name: "Ropa",
      email: `ropa-${randomUUID()}@ejemplo.com`,
      passwordHash: await hashPassword("x"),
      active: true,
      currency: "COP",
    },
  });
  businessId = negocio.id;
  const cliente = await prisma.customer.create({ data: { businessId, phoneNumber: `57${Date.now()}${Math.floor(Math.random() * 999)}` } });
  customerId = cliente.id;
  const conversacion = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversacion.id;
});

afterEach(async () => {
  await prisma.business.delete({ where: { id: businessId } }).catch(() => undefined);
});

async function camisaConTallas(precioBase: number, precioXL: number | null) {
  return prisma.product.create({
    data: {
      businessId,
      name: "Camisa de lino",
      description: "d",
      price: precioBase,
      currency: "COP",
      stock: 0,
      variants: {
        create: [
          { size: "S", stock: 5 },
          // null = el precio del producto. NO es gratis: esa es la decision entera de la columna.
          { size: "XL", stock: 5, price: precioXL },
        ],
      },
    },
    include: { variants: true },
  });
}

test("la funcion pura: la variante manda cuando tiene precio, el producto cuando no", () => {
  const producto = { price: new Prisma.Decimal("50000"), currency: "COP" };

  assert.equal(precioDeVenta(producto, { price: new Prisma.Decimal("62000") }).toString(), "62000");
  assert.equal(precioDeVenta(producto, { price: null }).toString(), "50000");
  assert.equal(precioDeVenta(producto, null).toString(), "50000");
  assert.equal(precioDeVenta(producto).toString(), "50000");

  // La moneda es SIEMPRE la del producto: dos tallas del mismo producto en monedas distintas no es un
  // caso real, seria un producto distinto.
  assert.equal(precioDeVenta(producto, { price: new Prisma.Decimal("62000") }).moneda, "COP");
});

test("un precio de variante en CERO es cero de verdad, no 'sin precio'", () => {
  const producto = { price: new Prisma.Decimal("50000"), currency: "COP" };
  // Si esto cayera al precio del producto, un dueno no podria regalar una talla que quiere liquidar. El
  // `??` esta puesto justamente para que 0 no se confunda con null; un `||` habria roto este caso.
  assert.equal(precioDeVenta(producto, { price: new Prisma.Decimal("0") }).toString(), "0");
});

test("E36: el pedido de la talla cara cobra el precio de la talla, no el del producto", async () => {
  const producto = await camisaConTallas(50000, 62000);
  const xl = producto.variants.find((v) => v.size === "XL")!;

  const { items } = await resolveOrderItems(businessId, [{ productName: "Camisa de lino", quantity: 2, variantId: xl.id }], conversationId);
  assert.equal(items.length, 1);
  assert.equal(items[0].unitPrice, 62000, "la XL cuesta mas que la S y eso tiene que llegar al pedido");

  const pedido = await createOrder({
    businessId,
    customerId,
    conversationId,
    summary: "2x Camisa XL",
    items,
  });

  // 2 x 62000 = 124000. Con el precio del producto habrian sido 100000, o sea 24000 menos por pedido.
  assert.equal(Number(pedido.totalAmount), 124000);
  assert.equal(Number(pedido.items[0].unitPrice), 62000);
});

test("E36: sin precio de variante, el catalogo se comporta EXACTAMENTE como antes", async () => {
  const producto = await camisaConTallas(50000, null);
  const xl = producto.variants.find((v) => v.size === "XL")!;

  const { items } = await resolveOrderItems(businessId, [{ productName: "Camisa de lino", quantity: 2, variantId: xl.id }], conversationId);

  // Esta es la prueba que decide si se puede desplegar: un catalogo que nunca toco precios por variante
  // no puede cambiar de comportamiento. Con un default de 0 en vez de null, aca habria dado 0 y el bot
  // habria vendido regalado.
  assert.equal(items[0].unitPrice, 50000);

  const pedido = await createOrder({ businessId, customerId, conversationId, summary: "2x Camisa XL", items });
  assert.equal(Number(pedido.totalAmount), 100000);
});

test("E36: el precio de la variante tambien manda cuando se la elige por etiqueta, no por id", async () => {
  await camisaConTallas(50000, 62000);

  // Este es el camino que usa el bot cuando la clienta escribe "la XL" en vez de tocar un boton: la
  // variante se resuelve por texto. Antes devolvia un tipo angosto que ya no traia el precio, asi que
  // este camino habria seguido cobrando el del producto aunque el otro estuviera arreglado.
  const { items } = await resolveOrderItems(businessId, [{ productName: "Camisa de lino", quantity: 1, variantLabel: "XL" }], conversationId);

  assert.equal(items.length, 1);
  assert.equal(items[0].variantLabel, "XL");
  assert.equal(items[0].unitPrice, 62000);
});
