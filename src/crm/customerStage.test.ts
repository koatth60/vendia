import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { createOrder } from "../orders/service";
import { resolveOrderItems } from "../orders/service";
import { recalcularEtapaDelCliente, markCustomerInactive } from "./customers";
import { runAbandonmentJob } from "../jobs/abandonment";

// E41 (2026-09-18). CustomerStage la calcula el servidor.
//
// Estaba practicamente muerta: nada escribia jamas COMPRADOR ni RECURRENTE. Medido en produccion, los
// 84 clientes tocados en siete dias estaban TODOS en NUEVO, incluidos los que ya habian comprado. La
// columna existia, el panel la mostraba, y no significaba nada.

const negocios: string[] = [];

after(async () => {
  for (const id of negocios) {
    await prisma.order.deleteMany({ where: { businessId: id } });
    await prisma.conversation.deleteMany({ where: { customer: { businessId: id } } });
    await prisma.customer.deleteMany({ where: { businessId: id } });
    await prisma.product.deleteMany({ where: { businessId: id } });
    await prisma.business.deleteMany({ where: { id } });
  }
});

async function sembrar() {
  const business = await prisma.business.create({
    // active: true porque el job solo recorre negocios activos, y Business.active viene en false por
    // defecto. Sin esto la prueba del job pasaria por el bucle sin mirar este negocio.
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x", active: true },
  });
  negocios.push(business.id);
  const customer = await prisma.customer.create({
    data: { businessId: business.id, phoneNumber: `5730${Date.now()}${Math.floor(Math.random() * 100)}` },
  });
  await prisma.product.create({
    data: { businessId: business.id, name: "Reloj E41", description: "x", price: 10000, currency: "COP", stock: 50 },
  });
  return { businessId: business.id, customerId: customer.id };
}

async function comprar(businessId: string, customerId: string) {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const { items } = await resolveOrderItems(businessId, [{ productName: "Reloj E41", quantity: 1 }]);
  await createOrder({
    businessId,
    customerId,
    conversationId: conversation.id,
    summary: "1x Reloj E41",
    items,
  });
}

test("E41: un cliente con un pedido queda en COMPRADOR sin que nadie lo toque", async () => {
  const { businessId, customerId } = await sembrar();
  const antes = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(antes.stage, "NUEVO", "arranca en NUEVO");

  await comprar(businessId, customerId);

  const despues = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(despues.stage, "COMPRADOR", "crear el pedido tiene que moverlo solo");
});

test("E41: el segundo pedido lo pasa a RECURRENTE", async () => {
  const { businessId, customerId } = await sembrar();
  await comprar(businessId, customerId);
  await comprar(businessId, customerId);

  const despues = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(despues.stage, "RECURRENTE");
});

test("E41: la etapa solo sube - quien ya compro no vuelve a INACTIVO por enfriarse", async () => {
  const { businessId, customerId } = await sembrar();
  await comprar(businessId, customerId);

  // Esto es lo que hace el job cuando una conversacion se abandona por inactividad.
  await markCustomerInactive(businessId, customerId);

  const despues = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(despues.stage, "COMPRADOR", "una conversacion fria no borra que esta persona compro");
});

test("E41: un cliente sin pedidos no se toca", async () => {
  const { businessId, customerId } = await sembrar();
  await prisma.customer.update({ where: { id: customerId }, data: { stage: "ACTIVO" } });

  await recalcularEtapaDelCliente(businessId, customerId);

  const despues = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(despues.stage, "ACTIVO", "sin pedidos, la etapa la siguen decidiendo los otros caminos");
});

test("E41: el job pone al dia a los que ya tenian pedidos de antes", async () => {
  const { businessId, customerId } = await sembrar();
  await comprar(businessId, customerId);
  // Se lo devuelve a mano al estado historico: con pedidos, pero en NUEVO. Es exactamente como estaban
  // los 84 clientes de produccion antes de esta etapa.
  await prisma.customer.update({ where: { id: customerId }, data: { stage: "NUEVO" } });

  await runAbandonmentJob();

  const despues = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  assert.equal(despues.stage, "COMPRADOR", "el job tiene que rellenar lo historico");
});
