import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { requiresPaymentConfirmation, parseSettlement } from "./paymentMethods";

// No se le pide al dueno que confirme plata que todavia no existe (2026-09-17). Con contraentrega no hay
// nada que verificar antes de despachar; con transferencia si, porque el dueno es la unica persona que
// puede mirar si entro.

let businessId: string;
let contraentregaId: string;
let nequiId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Pagos ${randomUUID()}`, email: `pagos-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const contraentrega = await prisma.paymentMethod.create({
    data: { businessId, type: "EFECTIVO", label: "Contraentrega", details: "Paga al recibir", settlement: "ON_DELIVERY" },
  });
  contraentregaId = contraentrega.id;
  const nequi = await prisma.paymentMethod.create({
    data: { businessId, type: "TRANSFERENCIA", label: "Nequi", details: "300", settlement: "PREPAID" },
  });
  nequiId = nequi.id;
});

after(async () => {
  await prisma.paymentMethod.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("contraentrega no necesita que el dueno confirme ningun pago", async () => {
  assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodId: contraentregaId }), false);
});

test("una transferencia si necesita confirmacion: el dueno es el unico que puede verla", async () => {
  assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodId: nequiId }), true);
});

test("la etiqueta sirve de respaldo cuando no viene el id", async () => {
  assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodLabel: "contraentrega" }), false);
  assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodLabel: "Nequi" }), true);
});

test("sin metodo identificable se confirma: el lado seguro del error es una pregunta de mas", async () => {
  assert.equal(await requiresPaymentConfirmation(businessId, {}), true);
  assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodLabel: "algo que no existe" }), true);
  assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodId: "id-inventado" }), true);
});

test("un metodo desactivado despues de que el cliente lo eligio no cambia las reglas de la venta", async () => {
  await prisma.paymentMethod.update({ where: { id: contraentregaId }, data: { active: false } });
  try {
    assert.equal(await requiresPaymentConfirmation(businessId, { paymentMethodId: contraentregaId }), false);
  } finally {
    await prisma.paymentMethod.update({ where: { id: contraentregaId }, data: { active: true } });
  }
});

test("el metodo de otro negocio nunca decide sobre esta venta", async () => {
  const otro = await prisma.business.create({
    data: { name: `Otro ${randomUUID()}`, email: `otro-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    assert.equal(await requiresPaymentConfirmation(otro.id, { paymentMethodId: contraentregaId }), true);
  } finally {
    await prisma.business.deleteMany({ where: { id: otro.id } });
  }
});

test("el panel solo puede mandar los dos valores reales", () => {
  assert.equal(parseSettlement("ON_DELIVERY"), "ON_DELIVERY");
  assert.equal(parseSettlement("PREPAID"), "PREPAID");
  assert.equal(parseSettlement("cualquier cosa"), undefined);
  assert.equal(parseSettlement(undefined), undefined);
});
