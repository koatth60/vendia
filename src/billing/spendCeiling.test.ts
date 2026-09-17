import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  getSpendStatus,
  checkSpendCeiling,
  defaultCeilingUsd,
  DEFAULT_CEILING_USD_PER_CHAT,
} from "./spendCeiling";
import { getChatCap } from "./chats";

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      planTier: "BASICO",
    },
  });
  businessId = business.id;
});

beforeEach(async () => {
  await prisma.aiUsageLog.deleteMany({ where: { businessId } });
  await prisma.business.update({
    where: { id: businessId },
    data: { aiSpendCeilingUsd: null, spendCeilingNotifiedAt: null },
  });
});

after(async () => {
  await prisma.aiUsageLog.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

async function spend(costUsd: number) {
  await prisma.aiUsageLog.create({
    data: {
      businessId,
      kind: "CHAT",
      model: "deepseek-flash",
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      costUsd,
    },
  });
}

test("un negocio sin techo propio hereda el que sale de su plan", async () => {
  const status = await getSpendStatus(businessId);
  assert.equal(status.ceilingIsDefault, true);
  assert.equal(status.ceilingUsd, defaultCeilingUsd("BASICO"));
  assert.equal(status.ceilingUsd, getChatCap("BASICO") * DEFAULT_CEILING_USD_PER_CHAT);
  assert.equal(status.exceeded, false, "sin gasto no hay nada cruzado");
});

test("el default aguanta con holgura el gasto real medido en produccion", async () => {
  // MAGByLizN, 2026-09: USD 1,0847 en el mes, plan EMPRENDEDOR. Si este numero llegara a rozar el
  // techo, el freno estaria cortando negocios sanos en vez de anomalias.
  const ceiling = defaultCeilingUsd("EMPRENDEDOR");
  assert.ok(ceiling > 1.0847 * 10, `el techo (${ceiling}) deberia estar muy por encima del gasto real`);
});

test("el gasto se suma del periodo corriente y cruza el techo", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { aiSpendCeilingUsd: 1 } });

  await spend(0.4);
  await spend(0.4);
  const under = await getSpendStatus(businessId);
  assert.equal(Math.round(under.spentUsd * 100) / 100, 0.8);
  assert.equal(under.exceeded, false);
  assert.equal(under.usagePercent, 80);

  await spend(0.3);
  const over = await getSpendStatus(businessId);
  assert.equal(over.exceeded, true);
  assert.equal(over.ceilingIsDefault, false);
});

test("justo en el techo ya corta: se gasto lo que se permitia", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { aiSpendCeilingUsd: 0.5 } });
  await spend(0.5);

  const status = await getSpendStatus(businessId);
  assert.equal(status.exceeded, true);
  assert.equal(status.usagePercent, 100);
});

test("al dueno se le avisa una sola vez por periodo", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { aiSpendCeilingUsd: 0.1 } });
  await spend(0.5);

  const first = await checkSpendCeiling(businessId);
  assert.equal(first.exceeded, true);
  assert.equal(first.justCrossed, true);

  const second = await checkSpendCeiling(businessId);
  assert.equal(second.exceeded, true);
  assert.equal(second.justCrossed, false);
});

test("subir el techo despausa el bot sin esperar al mes siguiente", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { aiSpendCeilingUsd: 0.1 } });
  await spend(0.5);
  assert.equal((await checkSpendCeiling(businessId)).exceeded, true);

  // Lo que hace la ruta PATCH /businesses/:id/spend-ceiling del panel de plataforma.
  await prisma.business.update({
    where: { id: businessId },
    data: { aiSpendCeilingUsd: 5, spendCeilingNotifiedAt: null },
  });

  const after = await checkSpendCeiling(businessId);
  assert.equal(after.exceeded, false, "el bot vuelve a responder apenas se sube el techo");
  assert.equal(after.justCrossed, false);
});

test("el gasto de un mes anterior no cuenta contra el techo de este", async () => {
  await prisma.business.update({ where: { id: businessId }, data: { aiSpendCeilingUsd: 0.1 } });

  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1, 15);
  await prisma.aiUsageLog.create({
    data: {
      businessId,
      kind: "CHAT",
      model: "deepseek-flash",
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      costUsd: 99,
      createdAt: lastMonth,
    },
  });

  const status = await getSpendStatus(businessId);
  assert.equal(status.spentUsd, 0);
  assert.equal(status.exceeded, false);
});
