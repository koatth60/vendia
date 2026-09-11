import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { recordMessage, getConversationForBusiness } from "./service";

// Regression coverage for the unread-message-count feature: the admin panel badges each conversation
// with how many CUSTOMER messages haven't been viewed yet, cleared as a side effect of opening it.

let businessId: string;
let customerId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573007${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customerId } } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("recordMessage increments unreadCount for CUSTOMER messages but not for ASSISTANT/SYSTEM ones", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });

  await recordMessage(businessId, conversation.id, "CUSTOMER", "hola");
  let fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 1);

  await recordMessage(businessId, conversation.id, "ASSISTANT", "hola, en que te ayudo?");
  fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 1, "an assistant reply must not bump the unread counter");

  await recordMessage(businessId, conversation.id, "CUSTOMER", "quiero el smartwatch");
  fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 2);
});

test("getConversationForBusiness resets unreadCount to 0 as a side effect of viewing it", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  await recordMessage(businessId, conversation.id, "CUSTOMER", "primer mensaje");
  await recordMessage(businessId, conversation.id, "CUSTOMER", "segundo mensaje");

  const beforeView = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(beforeView.unreadCount, 2);

  const viewed = await getConversationForBusiness(businessId, conversation.id);
  assert.equal(viewed?.unreadCount, 0);

  const afterView = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(afterView.unreadCount, 0, "viewing must persist the reset, not just return a zeroed response");
});

test("getConversationForBusiness is a no-op write when there's nothing unread", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const before = await getConversationForBusiness(businessId, conversation.id);
  assert.equal(before?.unreadCount, 0);
  const again = await getConversationForBusiness(businessId, conversation.id);
  assert.equal(again?.unreadCount, 0);
});
