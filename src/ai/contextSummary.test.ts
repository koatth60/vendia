import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getOrRefreshContextSummary } from "./agent";

// Hits the real DeepSeek API (small cost) - the point is verifying the summary actually gets
// produced and cached, not just that a prompt string looks right.

let businessId: string;
let customerId: string;
let conversationId: string;
let seededCount = 0;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;

  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573005${Date.now()}` },
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

// Explicit increasing createdAt so ordering is deterministic - a batch insert can otherwise land
// several rows in the same millisecond, making "oldest N" ambiguous.
async function seedMessages(count: number, content: (i: number) => string) {
  const base = Date.now() + seededCount * 1000;
  await prisma.message.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      conversationId,
      role: (seededCount + i) % 2 === 0 ? ("CUSTOMER" as const) : ("ASSISTANT" as const),
      content: content(i),
      createdAt: new Date(base + i * 1000),
    })),
  });
  seededCount += count;
}

test("returns null for a short conversation (no older messages to summarize)", async () => {
  await seedMessages(10, (i) => (i === 0 ? "Quiero el Smartwatch Serie 11 Mini rosado" : `relleno ${i}`));
  const summary = await getOrRefreshContextSummary(conversationId, businessId);
  assert.equal(summary, null);
});

test("summarizes older messages once the conversation exceeds the recent window", async () => {
  // 10 already seeded (message 0 mentions the smartwatch) + 15 more filler = 25 total, so the
  // oldest 5 - including the smartwatch message - fall outside the last-20 window and get summarized.
  await seedMessages(15, (i) => `relleno ${i}`);

  const summary = await getOrRefreshContextSummary(conversationId, businessId);
  assert.ok(summary, "expected a real summary to be generated");
  assert.match(summary!, /smartwatch/i);

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.equal(conversation.contextSummary, summary);
  assert.equal(conversation.contextSummarizedUpTo, 5);
});

test("does not regenerate the summary until enough new messages have aged past the window", async () => {
  const before1 = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });

  // Total is still 25, older count is still 5 (nothing new added) - should return the cached
  // summary without calling DeepSeek again.
  const summary = await getOrRefreshContextSummary(conversationId, businessId);
  assert.equal(summary, before1.contextSummary);

  const after1 = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  assert.equal(after1.contextSummarizedUpTo, before1.contextSummarizedUpTo);
});
