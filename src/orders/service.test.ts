import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getLatestOrderForCustomer } from "./service";

let businessId: string;
let customerId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test Business ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573005${Date.now()}` } });
  customerId = customer.id;
});

after(async () => {
  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("getLatestOrderForCustomer returns null when the customer has no orders", async () => {
  const order = await getLatestOrderForCustomer(businessId, customerId);
  assert.equal(order, null);
});

test("getLatestOrderForCustomer returns the most recent order across different conversations", async () => {
  // Order.conversationId is 1:1 with the conversation it closed in - a customer's order history spans
  // multiple conversations over time, so the lookup must go through customerId, not conversationId.
  const conversationA = await prisma.conversation.create({ data: { customerId } });
  const orderA = await prisma.order.create({
    data: { businessId, customerId, conversationId: conversationA.id, summary: "Pedido viejo", totalAmount: 50000, currency: "COP" },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const conversationB = await prisma.conversation.create({ data: { customerId } });
  const orderB = await prisma.order.create({
    data: { businessId, customerId, conversationId: conversationB.id, summary: "Pedido nuevo", totalAmount: 90000, currency: "COP" },
  });

  const latest = await getLatestOrderForCustomer(businessId, customerId);
  assert.ok(latest);
  assert.equal(latest!.id, orderB.id);
  assert.equal(latest!.summary, "Pedido nuevo");
  assert.notEqual(latest!.id, orderA.id);

  await prisma.order.deleteMany({ where: { customerId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
});
