import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { checkPlanCap, getAiUsageSummary } from "./usage";

let businessId: string;
let customerId: string;
let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      planTier: "BASICO", // cap = 2000, see PLAN_MESSAGE_CAPS in ./usage.ts
    },
  });
  businessId = business.id;

  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573000${Date.now()}` },
  });
  customerId = customer.id;

  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("checkPlanCap is not capped right at the plan limit", async () => {
  await prisma.message.createMany({
    data: Array.from({ length: 2000 }, () => ({ conversationId, role: "CUSTOMER" as const, content: "hola" })),
  });

  const status = await checkPlanCap(businessId);
  assert.equal(status.capped, false);
  assert.equal(status.messageCap, 2000);
});

test("checkPlanCap trips once the limit is exceeded, and only notifies once per period", async () => {
  await prisma.message.create({ data: { conversationId, role: "CUSTOMER", content: "uno mas" } });

  const first = await checkPlanCap(businessId);
  assert.equal(first.capped, true);
  assert.equal(first.justCrossed, true);

  const second = await checkPlanCap(businessId);
  assert.equal(second.capped, true);
  assert.equal(second.justCrossed, false, "should not re-notify the owner every single message");
});

test("getAiUsageSummary computes cacheHitRatio from real AiUsageLog rows", async () => {
  await prisma.aiUsageLog.createMany({
    data: [
      { businessId, kind: "CHAT", model: "deepseek-v4-flash", cacheHitTokens: 9000, cacheMissTokens: 1000, outputTokens: 100, costUsd: 0.001 },
      { businessId, kind: "CHAT", model: "deepseek-v4-flash", cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 50, costUsd: 0.0001 },
    ],
  });

  const summary = await getAiUsageSummary(businessId);
  assert.equal(summary.totalCacheHitTokens, 9000);
  assert.equal(summary.totalCacheMissTokens, 1000);
  assert.equal(summary.cacheHitRatio, 90, "9000/10000 cache-hit tokens = 90%");

  await prisma.aiUsageLog.deleteMany({ where: { businessId } });
});

test("getAiUsageSummary reports cacheHitRatio 0 instead of NaN when there are no logs", async () => {
  const summary = await getAiUsageSummary(businessId);
  assert.equal(summary.cacheHitRatio, 0);
});
