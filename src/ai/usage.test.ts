import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getAiUsageSummary } from "./usage";

let businessId: string;
let customerId: string;
let conversationId: string;

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
