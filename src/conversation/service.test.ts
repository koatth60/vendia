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
  createPendingOwnerQuestion,
  resolvePendingOwnerQuestion,
  findOpenPendingOwnerQuestionsForBusiness,
  getWindowState,
  setHumanControl,
  queueOutboundMessage,
  listQueuedOutbound,
  cancelQueuedOutbound,
  countConversationsWithQueuedOutbound,
  customerDisplayName,
  getOrCreateCustomer,
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
  await prisma.queuedOutboundMessage.deleteMany({ where: { businessId } });
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

// resolvePendingOwnerQuestion: marcar resuelta a mano desde Bot > Salud (feedback del dueño,
// 2026-09-13 - el card del dashboard llevaba a la Bandeja sin forma de sacar la pregunta de la
// lista sin contestarle al cliente).
test("resolvePendingOwnerQuestion borra la pregunta y no aparece mas en la lista del negocio", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  try {
    await createPendingOwnerQuestion(conversation.id, `wamid-${randomUUID()}`, "¿Hacen envíos a Leticia?");
    const before = await findOpenPendingOwnerQuestionsForBusiness(businessId);
    assert.equal(before.length, 1);

    const resolved = await resolvePendingOwnerQuestion(businessId, before[0].questionId);
    assert.equal(resolved, true);

    const after = await findOpenPendingOwnerQuestionsForBusiness(businessId);
    assert.equal(after.length, 0);
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
});

test("resolvePendingOwnerQuestion no deja que un negocio resuelva la pregunta de otro", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const otherBusiness = await prisma.business.create({
    data: { name: `Other ${randomUUID()}`, email: `other-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await createPendingOwnerQuestion(conversation.id, `wamid-${randomUUID()}`, "¿Tienen talla M?");
    const [pending] = await findOpenPendingOwnerQuestionsForBusiness(businessId);

    const resolved = await resolvePendingOwnerQuestion(otherBusiness.id, pending.questionId);
    assert.equal(resolved, false, "un negocio ajeno no puede resolver esta pregunta");

    const stillThere = await findOpenPendingOwnerQuestionsForBusiness(businessId);
    assert.equal(stillThere.length, 1, "la pregunta sigue intacta");
  } finally {
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
    await prisma.business.deleteMany({ where: { id: otherBusiness.id } });
  }
});

// getWindowState: WhatsApp's 24h customer-service window. Real incident (2026-09-14) - the admin panel
// composer and the escalation-reminder job both sent free text well past this, WhatsApp accepted both
// (real wamid) and only failed hours later via the async status webhook. This is the check that has to
// run BEFORE a send to catch that ahead of time.
test("getWindowState says closed when the customer has never written", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  try {
    const state = await getWindowState(conversation.id);
    assert.equal(state.windowOpen, false);
    assert.equal(state.hoursSinceLastCustomerMessage, null);
  } finally {
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
});

test("getWindowState says open right after the customer writes, closed 33h later", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  try {
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "CUSTOMER", content: "hola", createdAt: new Date() },
    });
    const fresh = await getWindowState(conversation.id);
    assert.equal(fresh.windowOpen, true);

    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "CUSTOMER",
        content: "hola",
        createdAt: new Date(Date.now() - 33 * 60 * 60 * 1000),
      },
    });
    const stale = await getWindowState(conversation.id);
    assert.equal(stale.windowOpen, false);
    assert.ok(stale.hoursSinceLastCustomerMessage! > 24);
  } finally {
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
});

test("getWindowState only looks at the customer's own messages, not the business's replies", async () => {
  // A business/bot reply after the customer's last message must never look like it reopened the
  // window - only the CUSTOMER writing again does that.
  const conversation = await prisma.conversation.create({ data: { customerId } });
  try {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "CUSTOMER",
        content: "hola",
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
      },
    });
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "seguimos revisando", createdAt: new Date() },
    });
    const state = await getWindowState(conversation.id);
    assert.equal(state.windowOpen, false, "una respuesta del negocio no reabre la ventana");
  } finally {
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
});

// Real incident (2026-09-14): a message with a real wamid (WhatsApp accepted it) still failed hours
// later via the async status webhook, and the panel showed it as an ordinary sent bubble - the owner
// had no way to know without checking "Salud del bot" separately.
test("getConversationForBusiness marks a message as deliveryFailed when a DeliveryFailure exists for its wamid", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const wamid = `wamid.ok-${randomUUID()}`;
  const wamidFailed = `wamid.failed-${randomUUID()}`;
  try {
    await recordMessage(businessId, conversation.id, "ASSISTANT", "Hola buen día", wamid);
    await recordMessage(businessId, conversation.id, "ASSISTANT", "Seguimos revisando", wamidFailed);
    await prisma.deliveryFailure.create({
      data: {
        businessId,
        wamid: wamidFailed,
        recipientPhone: "573000000000",
        errorCode: 131047,
        errorMessage: "Re-engagement message: Message failed to send because more than 24 hours have passed",
      },
    });

    const result = await getConversationForBusiness(businessId, conversation.id);
    const ok = result!.messages.find((m) => m.content === "Hola buen día");
    const failed = result!.messages.find((m) => m.content === "Seguimos revisando");
    assert.equal(ok!.deliveryFailed, false);
    assert.equal(failed!.deliveryFailed, true);
    assert.match(failed!.deliveryError!, /24 hours/);
  } finally {
    await prisma.deliveryFailure.deleteMany({ where: { businessId, wamid: { in: [wamid, wamidFailed] } } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
});

test("getConversationForBusiness never shows another business's delivery failure on a matching wamid", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const otherBusiness = await prisma.business.create({
    data: { name: `Other ${randomUUID()}`, email: `other-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const wamid = `wamid.shared-${randomUUID()}`;
  try {
    await recordMessage(businessId, conversation.id, "ASSISTANT", "Hola", wamid);
    await prisma.deliveryFailure.create({
      data: { businessId: otherBusiness.id, wamid, recipientPhone: "573000000000", errorMessage: "fallo de otro negocio" },
    });

    const result = await getConversationForBusiness(businessId, conversation.id);
    assert.equal(result!.messages[0].deliveryFailed, false);
  } finally {
    await prisma.deliveryFailure.deleteMany({ where: { wamid } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
    await prisma.business.deleteMany({ where: { id: otherBusiness.id } });
  }
});

test("getConversationForBusiness reports the window state alongside the thread", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  try {
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "CUSTOMER", content: "hola", createdAt: new Date() },
    });
    const result = await getConversationForBusiness(businessId, conversation.id);
    assert.equal(result!.windowOpen, true);
    assert.ok(result!.hoursSinceLastCustomerMessage! < 1);
  } finally {
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
  }
});

// getCustomerThreadForBusiness (the grouped view the panel actually loads from) must check the window
// against activeConversationId - the composer always sends there regardless of which cycle's messages
// happen to be on screen (loadOlderCycle only prepends history, it never changes the send target).
test("getCustomerThreadForBusiness reports the window state for activeConversationId, and flags failed messages", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573030${Date.now()}` } });
  const oldConv = await prisma.conversation.create({
    data: { customerId: customer.id, status: "SOLD", updatedAt: new Date(Date.now() - 60 * 60 * 60 * 1000) },
  });
  const activeConv = await prisma.conversation.create({ data: { customerId: customer.id, status: "NEW" } });
  const wamid = `wamid.thread-${randomUUID()}`;
  try {
    await prisma.message.create({
      data: {
        conversationId: activeConv.id,
        role: "CUSTOMER",
        content: "hola",
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
      },
    });
    await recordMessage(businessId, activeConv.id, "ASSISTANT", "Seguimos revisando", wamid);
    await prisma.deliveryFailure.create({
      data: { businessId, wamid, recipientPhone: customer.phoneNumber, errorMessage: "ventana cerrada" },
    });

    const result = await getCustomerThreadForBusiness(businessId, customer.id);
    assert.equal(result!.activeConversationId, activeConv.id);
    assert.equal(result!.windowOpen, false, "el ultimo mensaje del cliente en la conversacion activa fue hace 30h");
    const bubble = result!.messages.find((m) => m.content === "Seguimos revisando");
    assert.equal(bubble!.deliveryFailed, true);
  } finally {
    await prisma.deliveryFailure.deleteMany({ where: { wamid } });
    await prisma.message.deleteMany({ where: { conversationId: { in: [oldConv.id, activeConv.id] } } });
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// Incidente real 2026-09-14 (conversacion 573133260330): la duena estaba contestando a mano desde el
// panel y el bot le metia "Ya te leimos, en un momento te contesta el equipo directamente" entre sus
// propios mensajes. Cada mensaje del panel llama a setHumanControl(true), que limpiaba
// humanControlAckSent siempre - asi que el acuse, que debia ser uno por PAUSA, se re-armaba por MENSAJE.
test("setHumanControl solo reinicia el acuse en una transicion real a control humano", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId, humanControl: false } });

  await setHumanControl(businessId, conversation.id, true);
  let fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.humanControlAckSent, false, "una pausa nueva arranca con su propio acuse pendiente");

  // El bot manda el acuse una vez.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { humanControlAckSent: true } });

  // La duena sigue contestando desde el panel: cada mensaje vuelve a llamar a setHumanControl(true).
  await setHumanControl(businessId, conversation.id, true);
  await setHumanControl(businessId, conversation.id, true);
  fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.humanControlAckSent, true, "el acuse ya se mando en esta pausa, no se re-arma por mensaje");
  assert.notEqual(fresh.humanControlSince, null, "el reloj del watchdog SI se re-arma en cada mensaje");

  // Devolverle el control al bot cierra la pausa: la proxima tiene su propio acuse.
  await setHumanControl(businessId, conversation.id, false);
  await setHumanControl(businessId, conversation.id, true);
  fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(fresh.humanControlAckSent, false, "una pausa nueva vuelve a tener acuse pendiente");
});

// La ventana de 24h cerrada dejaba de ser un mensaje perdido: lo que el equipo quiso decir queda en cola
// hasta que el cliente escribe (ese mensaje entrante es lo que reabre la ventana).
test("la cola de salida guarda, lista, cancela y se cuenta por conversacion", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId, humanControl: true } });

  const first = await queueOutboundMessage(businessId, conversation.id, "Tu pedido sale el lunes", "PANEL");
  await queueOutboundMessage(businessId, conversation.id, "Confirmame la direccion", "OWNER_ANSWER");

  let pending = await listQueuedOutbound(conversation.id);
  assert.deepEqual(
    pending.map((q) => q.body),
    ["Tu pedido sale el lunes", "Confirmame la direccion"],
    "se entregan en el orden en que se escribieron"
  );
  assert.equal(await countConversationsWithQueuedOutbound(businessId), 1, "cuenta conversaciones, no mensajes");

  assert.equal(await cancelQueuedOutbound(businessId, first.id), true);
  pending = await listQueuedOutbound(conversation.id);
  assert.deepEqual(pending.map((q) => q.body), ["Confirmame la direccion"], "lo cancelado no se entrega nunca");

  assert.equal(await cancelQueuedOutbound(businessId, first.id), false, "cancelar dos veces no hace nada");
});

// El nombre de perfil de WhatsApp (contacts[0].profile.name del webhook) llena la bandeja sin que nadie
// pregunte nada, pero NUNCA puede pisar al nombre autoritativo: ese lo puso la clienta diciendolo por
// chat, o el dueno escribiendolo a mano, y un cambio de perfil ajeno no puede borrarlo.
test("customerDisplayName respeta la precedencia nombre propio > perfil de WhatsApp > numero", () => {
  assert.equal(
    customerDisplayName({ name: "Carolina Ruiz", whatsappProfileName: "caro🌸", phoneNumber: "573001112233" }),
    "Carolina Ruiz",
    "el nombre autoritativo gana siempre"
  );
  assert.equal(
    customerDisplayName({ name: null, whatsappProfileName: "caro🌸", phoneNumber: "573001112233" }),
    "caro🌸",
    "sin nombre propio, el de WhatsApp es mejor que un numero crudo"
  );
  assert.equal(
    customerDisplayName({ name: null, whatsappProfileName: null, phoneNumber: "573001112233" }),
    "573001112233"
  );
  assert.equal(
    customerDisplayName({ name: "", whatsappProfileName: "caro", phoneNumber: "573001112233" }),
    "caro",
    "un nombre vacio no es un nombre"
  );
});

test("getOrCreateCustomer refresca el perfil de WhatsApp sin tocar el nombre autoritativo", async () => {
  const phone = `57300${Date.now()}`.slice(0, 12);
  const first = await getOrCreateCustomer(businessId, phone, "caro");
  assert.equal(first.whatsappProfileName, "caro");
  assert.equal(first.name, null, "el webhook no rellena `name`, solo el campo de perfil");

  // La clienta dice su nombre por chat: ese es el autoritativo.
  await prisma.customer.update({ where: { id: first.id }, data: { name: "Carolina Ruiz" } });

  // Cambia su foto/nombre de perfil de WhatsApp. El nombre bueno tiene que sobrevivir.
  const after = await getOrCreateCustomer(businessId, phone, "caro 2026 ✨");
  assert.equal(after.whatsappProfileName, "caro 2026 ✨", "el de perfil si se refresca");
  assert.equal(after.name, "Carolina Ruiz", "el autoritativo NO se toca");
  assert.equal(customerDisplayName(after), "Carolina Ruiz");

  // Un webhook sin nombre de perfil (Meta no siempre lo manda) no puede borrar el que ya teniamos.
  const noProfile = await getOrCreateCustomer(businessId, phone, undefined);
  assert.equal(noProfile.whatsappProfileName, "caro 2026 ✨", "sin dato nuevo, se conserva el anterior");

  await prisma.customer.deleteMany({ where: { id: first.id } });
});
