import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { recordMessage, getConversationForBusiness, saveCustomerName, saveCustomerContactInfo, setCustomerTags } from "./service";
import { realtimeEvents } from "../realtime/events";

// Regression coverage for the unread-message-count feature: the admin panel badges each conversation
// with how many CUSTOMER messages haven't been viewed yet, but ONLY while the bot has stopped
// answering (humanControl:true) - while the bot is handling a conversation on its own, every customer
// message already gets an automatic reply, so it shouldn't count as needing the owner's attention.

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

test("recordMessage does NOT bump unreadCount for CUSTOMER messages while the bot is handling the conversation", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId, humanControl: false } });

  await recordMessage(businessId, conversation.id, "CUSTOMER", "hola, cuanto cuesta el smartwatch?");
  await recordMessage(businessId, conversation.id, "ASSISTANT", "cuesta $145.000 COP");
  await recordMessage(businessId, conversation.id, "CUSTOMER", "genial, lo quiero");

  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 0, "bot-handled traffic must not inflate the unread badge");
});

test("recordMessage increments unreadCount for CUSTOMER messages while humanControl is on, but not for ASSISTANT/SYSTEM ones", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId, humanControl: true } });

  await recordMessage(businessId, conversation.id, "CUSTOMER", "hola");
  let fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 1);

  await recordMessage(businessId, conversation.id, "ASSISTANT", "hola, en que te ayudo?");
  fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 1, "a reply (bot or the owner typing from the panel) must not bump the unread counter");

  await recordMessage(businessId, conversation.id, "CUSTOMER", "quiero el smartwatch");
  fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.unreadCount, 2);
});

test("getConversationForBusiness resets unreadCount to 0 as a side effect of viewing it", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId, humanControl: true } });
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

// Real production bug (2026-09-13): saveCustomerName updated Customer but never emitted
// conversation:updated (unlike updateConversationStatus/setHumanControl/setConversationIntent, which all
// do) - a name saved mid-conversation never reached an already-open admin panel. The socket handler in
// public/admin/index.html re-renders a row on this exact event.
function waitForEvent(eventName: string, businessId: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (emittedBusinessId: string, payload: unknown) => {
      if (emittedBusinessId !== businessId) return;
      realtimeEvents.off(eventName, handler);
      resolve(payload);
    };
    realtimeEvents.on(eventName, handler);
  });
}

// Each test below uses its OWN customer (not the shared `customerId`, which already has several
// conversations from earlier tests in this file) so exactly one conversation:updated event fires and
// waitForEvent can't accidentally resolve on some other test's leftover conversation.

test("saveCustomerName emits conversation:updated with the new name for every open conversation of that customer", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573012${Date.now()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  try {
    const eventPromise = waitForEvent("conversation:updated", businessId);
    await saveCustomerName(businessId, customer.id, "Einer");
    const payload = await eventPromise;
    assert.equal(payload.id, conversation.id);
    assert.equal(payload.customer.name, "Einer");
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("saveCustomerContactInfo also emits conversation:updated (same gap, same fix)", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573013${Date.now()}` } });
  await prisma.conversation.create({ data: { customerId: customer.id } });
  try {
    const eventPromise = waitForEvent("conversation:updated", businessId);
    await saveCustomerContactInfo(businessId, customer.id, { idNumber: "123456789" });
    const payload = await eventPromise;
    assert.equal(payload.customer.id, customer.id);
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("setCustomerTags also emits conversation:updated (same gap, same fix)", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573014${Date.now()}` } });
  await prisma.conversation.create({ data: { customerId: customer.id } });
  try {
    const eventPromise = waitForEvent("conversation:updated", businessId);
    await setCustomerTags(businessId, customer.id, ["vip"]);
    const payload = await eventPromise;
    assert.equal(payload.customer.tags.includes("vip"), true);
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});
