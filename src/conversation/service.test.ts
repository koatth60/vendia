import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  recordMessage,
  getConversationForBusiness,
  saveCustomerName,
  saveCustomerContactInfo,
  setCustomerTags,
  listCustomerThreadsForBusiness,
  getCustomerThreadForBusiness,
  setConversationIntent,
  clearConversationIntent,
} from "./service";
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

// Coverage for grouping the Conversaciones admin-panel list by customer instead of by Conversation -
// see [[onix-conversations-group-by-customer]] and ONIX-CONVERSATIONS-GROUPING-PLAN.md. The data model
// is unchanged (still one Conversation per sales cycle); only listCustomerThreadsForBusiness/
// getCustomerThreadForBusiness, which group/paginate over it, are new.

test("listCustomerThreadsForBusiness collapses a customer's closed + open conversations into one row", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573020${Date.now()}` } });
  const now = Date.now();
  try {
    const soldOld = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", updatedAt: new Date(now - 3 * 86400000) },
    });
    await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", updatedAt: new Date(now - 2 * 86400000) },
    });
    const open = await prisma.conversation.create({
      data: { customerId: customer.id, status: "NEW", updatedAt: new Date(now), unreadCount: 2 },
    });
    await prisma.conversation.update({ where: { id: soldOld.id }, data: { unreadCount: 1 } });

    const rows = await listCustomerThreadsForBusiness(businessId);
    const row = rows.find((r) => r.customerId === customer.id);
    assert.ok(row, "customer must appear exactly once in the grouped list");
    assert.equal(row.activeConversationId, open.id, "the non-SOLD/LOST conversation is the active one");
    assert.equal(row.orderCount, 2, "one order per SOLD conversation");
    assert.equal(row.unreadCount, 3, "unread is summed across every conversation, not just the active one");
    assert.equal(rows.filter((r) => r.customerId === customer.id).length, 1, "exactly one row per customer");
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("listCustomerThreadsForBusiness picks the most recently updated conversation as active when all are closed", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573021${Date.now()}` } });
  const now = Date.now();
  try {
    await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", updatedAt: new Date(now - 86400000) },
    });
    const mostRecent = await prisma.conversation.create({
      data: { customerId: customer.id, status: "LOST", updatedAt: new Date(now) },
    });

    const rows = await listCustomerThreadsForBusiness(businessId);
    const row = rows.find((r) => r.customerId === customer.id);
    assert.ok(row);
    assert.equal(row.activeConversationId, mostRecent.id);
    assert.equal(row.status, "LOST");
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("getCustomerThreadForBusiness returns only the active cycle's messages, and `before` walks older cycles one at a time", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573022${Date.now()}` } });
  const now = Date.now();
  try {
    const oldest = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", updatedAt: new Date(now - 2 * 86400000) },
    });
    await prisma.message.create({ data: { conversationId: oldest.id, role: "CUSTOMER", content: "mensaje viejo" } });

    const middle = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", updatedAt: new Date(now - 86400000) },
    });
    await prisma.message.create({ data: { conversationId: middle.id, role: "CUSTOMER", content: "mensaje del medio" } });

    const active = await prisma.conversation.create({
      data: { customerId: customer.id, status: "NEW", updatedAt: new Date(now) },
    });
    await prisma.message.create({ data: { conversationId: active.id, role: "CUSTOMER", content: "mensaje actual" } });

    const first = await getCustomerThreadForBusiness(businessId, customer.id);
    assert.ok(first);
    assert.equal(first.conversationId, active.id);
    assert.equal(first.activeConversationId, active.id);
    assert.deepEqual(first.messages.map((m) => m.content), ["mensaje actual"]);
    assert.equal(first.hasMore, true);
    assert.equal(first.cycles.length, 3);

    const second = await getCustomerThreadForBusiness(businessId, customer.id, active.id);
    assert.ok(second);
    assert.equal(second.conversationId, middle.id);
    assert.deepEqual(second.messages.map((m) => m.content), ["mensaje del medio"]);
    assert.equal(second.hasMore, true);

    const third = await getCustomerThreadForBusiness(businessId, customer.id, middle.id);
    assert.ok(third);
    assert.equal(third.conversationId, oldest.id);
    assert.deepEqual(third.messages.map((m) => m.content), ["mensaje viejo"]);
    assert.equal(third.hasMore, false);

    const exhausted = await getCustomerThreadForBusiness(businessId, customer.id, oldest.id);
    assert.ok(exhausted);
    assert.equal(exhausted.conversationId, null);
    assert.deepEqual(exhausted.messages, []);
    assert.equal(exhausted.hasMore, false);
  } finally {
    await prisma.message.deleteMany({ where: { conversation: { customerId: customer.id } } });
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("getCustomerThreadForBusiness marks every one of the customer's conversations as read, not just the active one", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573023${Date.now()}` } });
  try {
    const closed = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", unreadCount: 2, updatedAt: new Date(Date.now() - 86400000) },
    });
    const open = await prisma.conversation.create({
      data: { customerId: customer.id, status: "NEW", unreadCount: 1, updatedAt: new Date() },
    });

    await getCustomerThreadForBusiness(businessId, customer.id);

    const freshClosed = await prisma.conversation.findUniqueOrThrow({ where: { id: closed.id } });
    const freshOpen = await prisma.conversation.findUniqueOrThrow({ where: { id: open.id } });
    assert.equal(freshClosed.unreadCount, 0);
    assert.equal(freshOpen.unreadCount, 0);
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("clearConversationIntent removes an intent badge without touching status/humanControl", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573024${Date.now()}` } });
  try {
    const conversation = await prisma.conversation.create({ data: { customerId: customer.id, status: "NEW" } });
    await setConversationIntent(businessId, conversation.id, "PQR");

    const cleared = await clearConversationIntent(businessId, conversation.id);
    assert.ok(cleared);
    assert.equal(cleared.intent, null);
    assert.equal(cleared.status, "NEW", "clearing the intent must not touch the funnel status");

    // Scoped by businessId, like setHumanControl - a foreign business can't clear another business's flag.
    const otherBusiness = await prisma.business.create({
      data: { name: `Other ${randomUUID()}`, email: `other-${randomUUID()}@example.com`, passwordHash: "x" },
    });
    try {
      const result = await clearConversationIntent(otherBusiness.id, conversation.id);
      assert.equal(result, null);
    } finally {
      await prisma.business.deleteMany({ where: { id: otherBusiness.id } });
    }
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});
