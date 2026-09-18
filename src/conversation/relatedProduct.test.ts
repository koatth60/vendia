import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getRelatedProductIdForMessage } from "./service";

// Vitrina de categoria (2026-09-17). Cuando el cliente toca "Responder" sobre una de las fotos, ese
// gesto tiene que resolver al producto de ESA foto por id, igual que tocar una fila de una lista
// interactiva. Hasta hoy solo se resolvia el NOMBRE y viajaba metido en la prosa del mensaje.

let businessId: string;
let otroBusinessId: string;
let productId: string;
let inactivoId: string;
let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  businessId = business.id;
  const otro = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  otroBusinessId = otro.id;

  const producto = await prisma.product.create({
    // currency explicita: desde E33 el tipo la exige, justamente para que ninguna fila pueda quedar con
    // una moneda que nadie eligio.
    data: { businessId, name: "Audifonos Bluetooth", description: "d", price: 59900, currency: "COP", stock: 4 },
  });
  productId = producto.id;
  const inactivo = await prisma.product.create({
    data: { businessId, name: "Parlante viejo", description: "d", price: 80000, currency: "COP", stock: 0, active: false },
  });
  inactivoId = inactivo.id;

  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `5730${Date.now()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: { in: [businessId, otroBusinessId] } } });
});

async function fotoEnviada(relatedProductId: string | null, wamid: string) {
  await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: "[Foto de X]",
      whatsappMessageId: wamid,
      relatedProductId,
    },
  });
}

test("una foto citada resuelve al id del producto de esa foto", async () => {
  await fotoEnviada(productId, "wamid.foto-1");
  assert.equal(await getRelatedProductIdForMessage(businessId, "wamid.foto-1"), productId);
});

test("un mensaje que no era una foto de producto no resuelve nada", async () => {
  await fotoEnviada(null, "wamid.texto-1");
  assert.equal(await getRelatedProductIdForMessage(businessId, "wamid.texto-1"), null);
  assert.equal(await getRelatedProductIdForMessage(businessId, "wamid.no-existe"), null);
});

test("un producto desactivado despues de mandar la foto no resuelve", async () => {
  // Si no, el turno se centraria en un producto que el negocio ya no vende.
  await fotoEnviada(inactivoId, "wamid.foto-inactivo");
  assert.equal(await getRelatedProductIdForMessage(businessId, "wamid.foto-inactivo"), null);
});

test("el producto se verifica contra el negocio que pregunta, no solo contra el mensaje", async () => {
  await fotoEnviada(productId, "wamid.foto-2");
  assert.equal(await getRelatedProductIdForMessage(otroBusinessId, "wamid.foto-2"), null);
});
