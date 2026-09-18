import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { faltaComprobanteDePago } from "./paymentProof";

// 2026-09-17. Pedir el comprobante era una frase del prompt y nada mas: ningun codigo miraba si la foto
// existia. Aca se prueba la version verificable, y sobre todo el caso que el dueno del proyecto reporto -
// un pedido contraentrega no tiene comprobante que mostrar, porque el pago todavia no ocurrio.

let businessId: string;
let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      requirePaymentProof: true,
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `5731${Date.now()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  conversationId = conversation.id;
});

afterEach(async () => {
  await prisma.agentTurn.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
});

after(async () => {
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

// EL ORDEN ENTRE LOS DOS HECHOS SE ESCRIBE, NO SE DEJA AL RELOJ (2026-09-18).
//
// Las dos funciones de abajo dejaban que `createdAt` saliera de `now()`. Escribir una fila y despues la
// otra tarda menos de un milisegundo, asi que las dos podian caer en el MISMO instante -- y entonces "la
// imagen es anterior a los datos de pago" no se cumple y la prueba falla sin que nada este roto.
// Reproducido: una de cada tres corridas. En una conversacion real hay segundos entre un hecho y el
// otro; en una prueba, el orden hay que decirlo.
let reloj = Date.now();
function instanteSiguiente(): Date {
  reloj += 1000;
  return new Date(reloj);
}

async function sePasaronLosDatosDePago() {
  await prisma.agentTurn.create({
    data: { businessId, conversationId, iterations: 1, toolsCalled: ["get_payment_methods"], createdAt: instanteSiguiente() },
  });
}

async function clienteMandaImagen() {
  await prisma.message.create({
    data: {
      conversationId,
      role: "CUSTOMER",
      content: "[imagen]",
      mediaType: "IMAGE",
      mediaS3Key: `k-${randomUUID()}`,
      createdAt: instanteSiguiente(),
    },
  });
}

test("contraentrega: nunca falta el comprobante, porque no hay pago que mostrar todavia", async () => {
  // El caso reportado. Antes, la directiva del prompt le pedia igual la foto y frenaba la venta.
  await sePasaronLosDatosDePago();
  assert.equal(await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado: false }), false);
});

test("pago por adelantado sin ninguna imagen del cliente: falta el comprobante", async () => {
  await sePasaronLosDatosDePago();
  assert.equal(await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado: true }), true);
});

test("con la imagen mandada despues de los datos de pago, ya no falta", async () => {
  await sePasaronLosDatosDePago();
  await clienteMandaImagen();
  assert.equal(await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado: true }), false);
});

test("una imagen ANTERIOR a los datos de pago no cuenta como comprobante", async () => {
  // Una foto del producto que el cliente mando al principio de la conversacion no es la prueba de un pago
  // que todavia no se le habia pedido.
  await clienteMandaImagen();
  await sePasaronLosDatosDePago();
  assert.equal(await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado: true }), true);
});

test("si nunca se le pasaron los datos de pago, no se le reclama nada", async () => {
  // Del lado seguro: una venta no se frena por una duda nuestra. Sin datos de pago entregados no hay
  // comprobante que exigir.
  await clienteMandaImagen();
  assert.equal(await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado: true }), false);
});

test("un negocio que no exige comprobante nunca frena un cierre por esto", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { requirePaymentProof: false } });
  try {
    await sePasaronLosDatosDePago();
    assert.equal(await faltaComprobanteDePago(businessId, conversationId, { pagoPorAdelantado: true }), false);
  } finally {
    await prisma.business.update({ where: { id: businessId }, data: { requirePaymentProof: true } });
  }
});
