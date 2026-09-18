import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db/client";
import { comprobanteEsperandoVerificacion } from "./comprobanteEnRevision";

// El hecho "hay un comprobante sin verificar" sale de cuatro SELECT. Cada prueba apaga UNA de las cuatro
// condiciones y comprueba que el hecho deja de ser cierto -- que es lo que evita que el aviso aparezca
// donde no corresponde.

async function montar(opts: { requirePaymentProof?: boolean; settlement?: "PREPAID" | "ON_DELIVERY" } = {}) {
  const sufijo = Math.random().toString(36).slice(2, 8);
  const business = await prisma.business.create({
    data: {
      name: `Comprobante ${sufijo}`,
      email: `comprobante-${sufijo}@test.local`,
      passwordHash: "x",
      whatsappPhoneNumberId: `pnid-${sufijo}`,
      whatsappAccessToken: "token",
      currency: "COP",
      requirePaymentProof: opts.requirePaymentProof ?? true,
    },
  });
  const metodo = await prisma.paymentMethod.create({
    data: { businessId: business.id, type: "TRANSFERENCIA", label: `Nequi ${sufijo}`, details: "3001112233", settlement: opts.settlement ?? "PREPAID" },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, phoneNumber: `57300${Date.now() % 10000000}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  return { business, metodo, customer, conversation };
}

async function desmontar(businessId: string) {
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.agentTurn.deleteMany({ where: { businessId } });
  await prisma.saleState.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.order.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
}

/** Le pasa los datos de pago y despues el cliente manda la imagen, que es el caso real. */
async function comprobanteMandado(businessId: string, conversationId: string, metodoId: string) {
  const datosDePago = new Date(Date.now() - 60_000);
  await prisma.agentTurn.create({
    data: { businessId, conversationId, toolsCalled: ["get_payment_methods"], createdAt: datosDePago },
  });
  await prisma.saleState.create({ data: { conversationId, items: [], paymentMethodId: metodoId } });
  await prisma.message.create({
    data: { conversationId, role: "CUSTOMER", content: "ya te transferi", mediaType: "IMAGE", createdAt: new Date(datosDePago.getTime() + 30_000) },
  });
}

test("con el comprobante mandado y sin verificar, el hecho es cierto", async () => {
  const { business, conversation, metodo } = await montar();
  try {
    await comprobanteMandado(business.id, conversation.id, metodo.id);
    assert.equal(await comprobanteEsperandoVerificacion(business.id, conversation.id), true);
  } finally {
    await desmontar(business.id);
  }
});

test("si el negocio no exige comprobante, no hay nada en revision", async () => {
  const { business, conversation, metodo } = await montar({ requirePaymentProof: false });
  try {
    await comprobanteMandado(business.id, conversation.id, metodo.id);
    assert.equal(await comprobanteEsperandoVerificacion(business.id, conversation.id), false);
  } finally {
    await desmontar(business.id);
  }
});

test("en contraentrega no hay comprobante que revisar", async () => {
  const { business, conversation, metodo } = await montar({ settlement: "ON_DELIVERY" });
  try {
    await comprobanteMandado(business.id, conversation.id, metodo.id);
    assert.equal(await comprobanteEsperandoVerificacion(business.id, conversation.id), false);
  } finally {
    await desmontar(business.id);
  }
});

test("una imagen ANTERIOR a los datos de pago no es un comprobante", async () => {
  const { business, conversation, metodo } = await montar();
  try {
    const datosDePago = new Date();
    await prisma.saleState.create({ data: { conversationId: conversation.id, items: [], paymentMethodId: metodo.id } });
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "CUSTOMER", content: "mira este reloj", mediaType: "IMAGE", createdAt: new Date(datosDePago.getTime() - 60_000) },
    });
    await prisma.agentTurn.create({
      data: { businessId: business.id, conversationId: conversation.id, toolsCalled: ["get_payment_methods"], createdAt: datosDePago },
    });
    assert.equal(await comprobanteEsperandoVerificacion(business.id, conversation.id), false);
  } finally {
    await desmontar(business.id);
  }
});

test("con el pedido ya marcado pagado deja de estar en revision", async () => {
  const { business, conversation, customer, metodo } = await montar();
  try {
    await comprobanteMandado(business.id, conversation.id, metodo.id);
    await prisma.order.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        conversationId: conversation.id,
        summary: "1x algo",
        totalAmount: 80000,
        currency: "COP",
        paymentStatus: "PAID",
      },
    });
    assert.equal(await comprobanteEsperandoVerificacion(business.id, conversation.id), false);
  } finally {
    await desmontar(business.id);
  }
});

test("sin metodo de pago resuelto no se afirma nada", async () => {
  const { business, conversation } = await montar();
  try {
    const datosDePago = new Date(Date.now() - 60_000);
    await prisma.agentTurn.create({
      data: { businessId: business.id, conversationId: conversation.id, toolsCalled: ["get_payment_methods"], createdAt: datosDePago },
    });
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "CUSTOMER", content: "ya pague", mediaType: "IMAGE", createdAt: new Date(datosDePago.getTime() + 30_000) },
    });
    assert.equal(await comprobanteEsperandoVerificacion(business.id, conversation.id), false);
  } finally {
    await desmontar(business.id);
  }
});
