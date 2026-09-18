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
  decodeInboxCursor,
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
  recordMessageDeliveryStatus,
  getOrCreateOpenConversation,
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

    const { items: rows } = await listCustomerThreadsForBusiness(businessId, { limit: 100 });
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

// Caso real, Laura Manjarrez (2026-09-16): su venta SOLD vieja se cancela y esa acción le pisa el
// updatedAt (14:28-como-hora, mucho más nuevo que su conversación NEW activa, donde en realidad
// sigue hablando ahora mismo). Antes del fix, la fila mostraba "Tu pedido fue cancelado" - un mensaje
// que vivía en la OTRA conversación - y al abrir el chat (que carga la conversación activa) ese
// mensaje no estaba en ningún lado.
test("listCustomerThreadsForBusiness muestra el mensaje mas reciente de VERDAD, no el de la conversacion que alguien tocó por última vez", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573025${Date.now()}` } });
  const now = Date.now();
  try {
    const sold = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", createdAt: new Date(now - 3600000), updatedAt: new Date(now - 3600000) },
    });
    await prisma.message.create({
      data: { conversationId: sold.id, role: "ASSISTANT", content: "¡Listo! Tu pedido va en camino.", createdAt: new Date(now - 3600000) },
    });

    const active = await prisma.conversation.create({
      data: { customerId: customer.id, status: "NEW", createdAt: new Date(now - 1800000), updatedAt: new Date(now - 1800000) },
    });
    await prisma.message.create({
      data: { conversationId: active.id, role: "CUSTOMER", content: "Quiero pedir otra cosa", createdAt: new Date(now - 1800000) },
    });

    // Cancela la venta vieja DESPUÉS de que la conversación activa ya tiene su propio mensaje más
    // reciente - esto es lo que le pasó a Laura: la cancelación le pisa el updatedAt a `sold`.
    await prisma.conversation.update({ where: { id: sold.id }, data: { updatedAt: new Date(now) } });
    await prisma.message.create({
      data: { conversationId: sold.id, role: "ASSISTANT", content: "Tu pedido fue cancelado. Cualquier duda me escribes.", createdAt: new Date(now) },
    });

    const { items: rows } = await listCustomerThreadsForBusiness(businessId, { limit: 100 });
    const row = rows.find((r) => r.customerId === customer.id);
    assert.ok(row);
    assert.equal(row.activeConversationId, active.id, "la conversación NEW sigue siendo la activa");
    assert.equal(row.lastMessage?.content, "Tu pedido fue cancelado. Cualquier duda me escribes.", "el mensaje mas nuevo de verdad, sea de la conversacion que sea");
  } finally {
    await prisma.message.deleteMany({ where: { conversation: { customerId: customer.id } } });
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

    const { items: rows } = await listCustomerThreadsForBusiness(businessId, { limit: 100 });
    const row = rows.find((r) => r.customerId === customer.id);
    assert.ok(row);
    assert.equal(row.activeConversationId, mostRecent.id);
    assert.equal(row.status, "LOST");
  } finally {
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("getCustomerThreadForBusiness trae ciclos hacia atras hasta juntar 30 mensajes, y `before` sigue caminando hacia lo mas viejo", async () => {
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

    // Desde el 2026-09-17 abrir el hilo trae ciclos hacia atras hasta juntar 30 mensajes: con tres
    // ciclos de un mensaje cada uno, vienen los tres. `messages` sigue siendo el del ciclo mas nuevo.
    const first = await getCustomerThreadForBusiness(businessId, customer.id);
    assert.ok(first);
    assert.equal(first.conversationId, active.id);
    assert.equal(first.activeConversationId, active.id);
    assert.deepEqual(first.messages.map((m) => m.content), ["mensaje actual"]);
    assert.deepEqual(
      first.blocks.flatMap((b) => b.messages.map((m) => m.content)),
      ["mensaje viejo", "mensaje del medio", "mensaje actual"]
    );
    assert.equal(first.hasMore, false, "ya no queda nada mas viejo por cargar");
    assert.equal(first.cycles.length, 3);

    // Con los tres ciclos ya cargados de entrada no queda nada por pedir, pero el camino `before` sigue
    // existiendo y sigue caminando hacia atras (lo usa un panel abierto desde antes del cambio).
    const second = await getCustomerThreadForBusiness(businessId, customer.id, active.id);
    assert.ok(second);
    assert.equal(second.conversationId, middle.id);
    assert.deepEqual(
      second.blocks.flatMap((b) => b.messages.map((m) => m.content)),
      ["mensaje viejo", "mensaje del medio"]
    );

    const third = await getCustomerThreadForBusiness(businessId, customer.id, middle.id);
    assert.ok(third);
    assert.equal(third.conversationId, oldest.id);
    assert.deepEqual(third.messages.map((m) => m.content), ["mensaje viejo"]);
    assert.equal(third.hasMore, false);
    assert.equal(second.hasMore, false, "ya se habia cargado todo");

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

// Caso real, Laura Manjarrez (2026-09-16): se cancela una venta SOLD vieja MIENTRAS la clienta ya
// tiene una conversación NEW activa hablando de otra cosa - el aviso de cancelación es un mensaje
// genuino, nuevo, que cae en el ciclo SOLD. Decisión del dueño: al abrir la ficha se muestra el
// ciclo con el mensaje más reciente de VERDAD (acá, el SOLD con la cancelación), no siempre "el
// ciclo sin cerrar" - eso quedaba tapando el aviso que el cliente sí recibió. El composer sigue
// apuntando al ciclo activo (NEW) sea cual sea el que se esté mostrando.
test("getCustomerThreadForBusiness muestra por defecto el ciclo con el mensaje mas reciente, aunque ese ciclo este SOLD/LOST", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573026${Date.now()}` } });
  const now = Date.now();
  try {
    const sold = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", createdAt: new Date(now - 3600000) },
    });
    await prisma.message.create({
      data: { conversationId: sold.id, role: "ASSISTANT", content: "¡Listo! Tu pedido va en camino.", createdAt: new Date(now - 3600000) },
    });

    const active = await prisma.conversation.create({
      data: { customerId: customer.id, status: "NEW", createdAt: new Date(now - 1800000) },
    });
    await prisma.message.create({
      data: { conversationId: active.id, role: "CUSTOMER", content: "Quiero pedir otra cosa", createdAt: new Date(now - 1800000) },
    });

    // El aviso de cancelación llega DESPUÉS, al ciclo SOLD - el mensaje más nuevo de los dos, aunque
    // su conversación sea la más vieja de las dos por creación.
    await prisma.message.create({
      data: { conversationId: sold.id, role: "ASSISTANT", content: "Tu pedido fue cancelado. Cualquier duda me escribes.", createdAt: new Date(now) },
    });

    const result = await getCustomerThreadForBusiness(businessId, customer.id);
    assert.ok(result);
    assert.equal(result.conversationId, sold.id, "se muestra el ciclo con el mensaje mas reciente");
    assert.deepEqual(result.messages.map((m) => m.content), ["¡Listo! Tu pedido va en camino.", "Tu pedido fue cancelado. Cualquier duda me escribes."]);
    assert.equal(result.activeConversationId, active.id, "el composer sigue apuntando al ciclo NEW, no al SOLD que se esta mostrando");
    // Antes esto era `hasMore: true` y el ciclo NEW quedaba detras del boton. Desde el 2026-09-17 el
    // hilo carga hacia atras hasta juntar 30 mensajes, asi que llega solo: lo que importa sigue siendo
    // que ESTE, con lo mas nuevo, es el ciclo "actual".
    assert.ok(
      result.blocks.flatMap((b) => b.messages.map((m) => m.content)).includes("Quiero pedir otra cosa"),
      "el ciclo NEW con historia real llega sin apretar nada"
    );

    const older = await getCustomerThreadForBusiness(businessId, customer.id, sold.id);
    assert.ok(older);
    assert.equal(older.conversationId, active.id);
    assert.deepEqual(older.messages.map((m) => m.content), ["Quiero pedir otra cosa"]);
    assert.equal(older.hasMore, false);
  } finally {
    await prisma.message.deleteMany({ where: { conversation: { customerId: customer.id } } });
    await prisma.conversation.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// Caso real, Milena Hernández Parra (2026-09-16): un ciclo SOLD queda con updatedAt más nuevo que el
// ciclo NEW activo (una nota, una edición del pedido, cualquier toque administrativo después de que
// el cliente ya escribió el siguiente ciclo) - si el orden que usa hasMore fuera por updatedAt, el
// ciclo activo dejaba de estar en el índice 0 y "Ver conversación anterior" desaparecía con historia
// vieja real esperando. createdAt no se mueve después de creado, así que el orden no se corrompe.
test("getCustomerThreadForBusiness sigue mostrando hasMore=true aunque el ciclo SOLD se toque despues de que el ciclo activo arranco", async () => {
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573024${Date.now()}` } });
  const now = Date.now();
  try {
    const sold = await prisma.conversation.create({
      data: { customerId: customer.id, status: "SOLD", createdAt: new Date(now - 86400000) },
    });
    await prisma.message.create({ data: { conversationId: sold.id, role: "CUSTOMER", content: "mensaje viejo" } });

    const active = await prisma.conversation.create({
      data: { customerId: customer.id, status: "NEW", createdAt: new Date(now) },
    });
    await prisma.message.create({ data: { conversationId: active.id, role: "CUSTOMER", content: "mensaje actual" } });

    // Toca el ciclo SOLD DESPUÉS de que el ciclo activo ya existe - esto es lo que le pasó a Milena.
    await prisma.conversation.update({ where: { id: sold.id }, data: { updatedAt: new Date(now + 60000) } });

    // Lo que esta prueba cuida es el ORDEN: que un toque administrativo al ciclo SOLD no lo vuelva "el
    // mas reciente" ni haga desaparecer la historia vieja. Desde el 2026-09-17 esa historia ya no vive
    // detras del boton - llega con el hilo - asi que se comprueba que este, y no que hasMore sea true.
    const result = await getCustomerThreadForBusiness(businessId, customer.id);
    assert.ok(result);
    assert.equal(result.activeConversationId, active.id);
    assert.equal(result.conversationId, active.id, "el mensaje mas nuevo es el del ciclo activo, no el toque al SOLD");
    assert.deepEqual(
      result.blocks.flatMap((b) => b.messages.map((m) => m.content)),
      ["mensaje viejo", "mensaje actual"]
    );
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

  let pending = await listQueuedOutbound(businessId, conversation.id);
  assert.deepEqual(
    pending.map((q) => q.body),
    ["Tu pedido sale el lunes", "Confirmame la direccion"],
    "se entregan en el orden en que se escribieron"
  );
  assert.equal(await countConversationsWithQueuedOutbound(businessId), 1, "cuenta conversaciones, no mensajes");

  assert.equal(await cancelQueuedOutbound(businessId, first.id), true);
  pending = await listQueuedOutbound(businessId, conversation.id);
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

// Fase 7 del plan maestro (2026-09-15): antes el webhook de `statuses` de Meta solo pasaba por un
// console.log - el panel no podia mostrar si un mensaje realmente llego.
test("recordMessageDeliveryStatus guarda sent/delivered/read matcheando por wamid", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const wamid = `wamid.delivery-${randomUUID()}`;
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: "Hola", whatsappMessageId: wamid },
  });

  await recordMessageDeliveryStatus(wamid, "sent");
  let updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
  assert.equal(updated.deliveryStatus, "SENT");
  assert.ok(updated.deliveryStatusAt);

  await recordMessageDeliveryStatus(wamid, "delivered");
  updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
  assert.equal(updated.deliveryStatus, "DELIVERED");

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

test("recordMessageDeliveryStatus no deja que un sent tardio pise un read mas reciente", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const wamid = `wamid.delivery-order-${randomUUID()}`;
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: "Hola", whatsappMessageId: wamid },
  });

  await recordMessageDeliveryStatus(wamid, "read");
  await recordMessageDeliveryStatus(wamid, "sent");

  const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
  assert.equal(updated.deliveryStatus, "READ", "Meta no garantiza el orden de los webhooks de estado");

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

test("recordMessageDeliveryStatus ignora un wamid desconocido o un status que no es de entrega", async () => {
  await recordMessageDeliveryStatus(`wamid.unknown-${randomUUID()}`, "sent"); // no debe tirar
  const conversation = await prisma.conversation.create({ data: { customerId } });
  const wamid = `wamid.delivery-failed-${randomUUID()}`;
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: "Hola", whatsappMessageId: wamid },
  });

  // "failed" se registra aparte como DeliveryFailure (ver src/routes/whatsapp.ts) - no es un
  // MessageDeliveryStatus valido.
  await recordMessageDeliveryStatus(wamid, "failed");
  const updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
  assert.equal(updated.deliveryStatus, null);

  await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

// Fase 9 del plan maestro (2026-09-15): ABANDONED no es un rechazo como LOST - si el cliente vuelve a
// escribir despues de irse en silencio, la conversacion se reabre (no se crea una nueva) para no perder
// el SaleState/carrito que ya tenia armado.
test("getOrCreateOpenConversation reopens an ABANDONED conversation (back to NEW) instead of creating a new one", async () => {
  const conversation = await prisma.conversation.create({
    data: { customerId, status: "ABANDONED", cartRecoverySentAt: new Date() },
  });

  const reopened = await getOrCreateOpenConversation(businessId, customerId);

  assert.equal(reopened.id, conversation.id, "must reuse the same conversation, not create a new one");
  assert.equal(reopened.status, "NEW");
  assert.equal(reopened.cartRecoverySentAt, null, "a later abandonment must be able to send the template again");

  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

test("getOrCreateOpenConversation never reopens a LOST conversation - it starts a fresh one, same as always", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId, status: "LOST" } });

  const result = await getOrCreateOpenConversation(businessId, customerId);

  assert.notEqual(result.id, conversation.id);
  assert.equal(result.status, "NEW");

  await prisma.conversation.deleteMany({ where: { id: result.id } });
  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

// ==============================================================================================
// Por que quedo en manos de una persona (2026-09-17)
// ==============================================================================================

test("tomar el control guarda el motivo, y devolverlo lo borra", async () => {
  const conversation = await prisma.conversation.create({ data: { customerId } });

  const tomada = await setHumanControl(businessId, conversation.id, true, "STALE_REPLY");
  assert.equal(tomada?.humanControl, true);
  assert.equal(tomada?.humanControlReason, "STALE_REPLY");

  const devuelta = await setHumanControl(businessId, conversation.id, false);
  assert.equal(devuelta?.humanControl, false);
  assert.equal(devuelta?.humanControlReason, null, "sin control humano no hay motivo que mostrar");

  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

test("un mensaje del panel sobre una escalacion del bot no reescribe quien la empezo", async () => {
  // La duena contesta desde el panel una conversacion que el bot ya habia escalado: el motivo tiene que
  // seguir diciendo que la empezo el bot, no el ultimo que escribio.
  const conversation = await prisma.conversation.create({ data: { customerId } });

  await setHumanControl(businessId, conversation.id, true, "INTENT_ESCALATION");
  const despues = await setHumanControl(businessId, conversation.id, true, "PANEL_MESSAGE");
  assert.equal(despues?.humanControlReason, "INTENT_ESCALATION");

  await prisma.conversation.deleteMany({ where: { id: conversation.id } });
});

// ==============================================================================================
// Abrir un hilo muestra conversacion, no un ciclo (2026-09-17)
// ==============================================================================================
//
// Hasta hoy se cargaba UN ciclo. Cuando una venta cerraba y el cliente escribia de nuevo, ese ciclo
// tenia un solo mensaje: el dueno abria el chat, veia una linea suelta y tenia que apretar "Ver
// conversacion anterior" para entender de que se estaba hablando.

test("una conversacion nueva despues de una venta abre con el historial anterior, sin tener que pedirlo", async () => {
  const cliente = await prisma.customer.create({ data: { businessId, phoneNumber: `573027${Date.now()}` } });
  const customerId = cliente.id;
  const vieja = await prisma.conversation.create({ data: { customerId, status: "SOLD" } });
  for (let i = 0; i < 12; i++) {
    await prisma.message.create({
      data: { conversationId: vieja.id, role: i % 2 === 0 ? "CUSTOMER" : "ASSISTANT", content: `viejo ${i}` },
    });
  }
  const nueva = await prisma.conversation.create({ data: { customerId } });
  await prisma.message.create({ data: { conversationId: nueva.id, role: "CUSTOMER", content: "confirmado lo del reloj" } });

  try {
    const hilo = await getCustomerThreadForBusiness(businessId, customerId, undefined);
    assert.ok(hilo);

    const total = hilo.blocks.reduce((n, b) => n + b.messages.length, 0);
    assert.equal(total, 13, "los 12 del ciclo cerrado mas el nuevo, sin apretar nada");
    assert.equal(hilo.blocks.length, 2, "siguen siendo dos ciclos: el separador de venta cerrada no se pierde");
    assert.equal(hilo.blocks[0].conversationId, vieja.id, "del mas viejo al mas nuevo");
    assert.equal(hilo.blocks[1].conversationId, nueva.id);
    assert.equal(hilo.conversationId, nueva.id, "el ciclo 'actual' sigue siendo el mas nuevo");
  } finally {
    await prisma.message.deleteMany({ where: { conversationId: { in: [vieja.id, nueva.id] } } });
    await prisma.conversation.deleteMany({ where: { id: { in: [vieja.id, nueva.id] } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  }
});

test("un ciclo que ya trae 30 mensajes no arrastra los anteriores", async () => {
  const cliente = await prisma.customer.create({ data: { businessId, phoneNumber: `573028${Date.now()}` } });
  const customerId = cliente.id;
  const vieja = await prisma.conversation.create({ data: { customerId, status: "SOLD" } });
  await prisma.message.create({ data: { conversationId: vieja.id, role: "CUSTOMER", content: "compra anterior" } });
  const actual = await prisma.conversation.create({ data: { customerId } });
  for (let i = 0; i < 30; i++) {
    await prisma.message.create({ data: { conversationId: actual.id, role: "CUSTOMER", content: `actual ${i}` } });
  }

  try {
    const hilo = await getCustomerThreadForBusiness(businessId, customerId, undefined);
    assert.ok(hilo);
    assert.equal(hilo.blocks.length, 1, "con 30 ya alcanza: no se lee historia que nadie pidio");
    assert.equal(hilo.blocks[0].conversationId, actual.id);
    assert.equal(hilo.hasMore, true, "y el boton sigue estando para lo mas viejo");
  } finally {
    await prisma.message.deleteMany({ where: { conversationId: { in: [vieja.id, actual.id] } } });
    await prisma.conversation.deleteMany({ where: { id: { in: [vieja.id, actual.id] } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  }
});

// LA BANDEJA PAGINADA (2026-09-18). Cargaba TODOS los clientes del negocio en la primera pantalla: 72
// conversaciones el dia que se midio, con la ultima linea de cada una y su cuenta de compras, y
// creciendo cada semana. El agrupado por cliente ahora lo hace la base con un GROUP BY, y la paginacion
// es por llave (updatedAt, customerId) y no por OFFSET: mientras alguien scrollea entran mensajes
// nuevos, y con OFFSET una fila que sube de posicion se muestra dos veces o no se muestra nunca.

test("la Bandeja devuelve solo la pagina pedida y dice desde donde sigue", async () => {
  const negocio = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      const cliente = await prisma.customer.create({ data: { businessId: negocio.id, phoneNumber: `5731${Date.now()}${i}` } });
      await prisma.conversation.create({ data: { customerId: cliente.id, updatedAt: new Date(base + i * 1000) } });
    }

    const primera = await listCustomerThreadsForBusiness(negocio.id, { limit: 2 });
    assert.equal(primera.items.length, 2);
    assert.ok(primera.nextCursor, "con mas clientes por delante tiene que decir desde donde sigue");

    const segunda = await listCustomerThreadsForBusiness(negocio.id, {
      limit: 2,
      cursor: decodeInboxCursor(primera.nextCursor!),
    });
    assert.equal(segunda.items.length, 2);

    const tercera = await listCustomerThreadsForBusiness(negocio.id, {
      limit: 2,
      cursor: decodeInboxCursor(segunda.nextCursor!),
    });
    assert.equal(tercera.items.length, 1, "la ultima pagina trae lo que queda");
    assert.equal(tercera.nextCursor, null, "y no promete una pagina que no existe");

    // Ninguna fila repetida entre paginas, y todas las que hay.
    const ids = [...primera.items, ...segunda.items, ...tercera.items].map((r) => r.customerId);
    assert.equal(new Set(ids).size, 5, "cinco clientes distintos, ninguno dos veces");

    // Y el orden es por actividad mas reciente primero, que es lo que ve el dueño.
    const tiempos = [...primera.items, ...segunda.items, ...tercera.items].map((r) => r.updatedAt.getTime());
    assert.deepEqual(tiempos, [...tiempos].sort((a, b) => b - a));
  } finally {
    await prisma.conversation.deleteMany({ where: { customer: { businessId: negocio.id } } });
    await prisma.customer.deleteMany({ where: { businessId: negocio.id } });
    await prisma.business.deleteMany({ where: { id: negocio.id } });
  }
});

test("un cliente con varias conversaciones ocupa UNA fila y no se repite en la pagina siguiente", async () => {
  // Es el defecto que abre la paginacion mal hecha: agrupar en memoria y despues cortar significa que la
  // conversacion vieja del mismo cliente reaparece mas abajo como otra fila.
  const negocio = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const base = Date.now() - 60 * 60 * 1000;
    const repetido = await prisma.customer.create({ data: { businessId: negocio.id, phoneNumber: `5732${Date.now()}` } });
    // Su conversacion mas nueva es la primera de todas; la vieja caeria en la ultima pagina.
    await prisma.conversation.create({ data: { customerId: repetido.id, status: "SOLD", updatedAt: new Date(base) } });
    await prisma.conversation.create({ data: { customerId: repetido.id, updatedAt: new Date(base + 10_000) } });
    for (let i = 0; i < 3; i++) {
      const otro = await prisma.customer.create({ data: { businessId: negocio.id, phoneNumber: `5733${Date.now()}${i}` } });
      await prisma.conversation.create({ data: { customerId: otro.id, updatedAt: new Date(base + 1000 + i * 1000) } });
    }

    const todas: string[] = [];
    let cursor = undefined as ReturnType<typeof decodeInboxCursor>;
    for (let pagina = 0; pagina < 5; pagina++) {
      const res = await listCustomerThreadsForBusiness(negocio.id, { limit: 2, cursor });
      todas.push(...res.items.map((r) => r.customerId));
      if (!res.nextCursor) break;
      cursor = decodeInboxCursor(res.nextCursor);
    }

    assert.equal(todas.filter((id) => id === repetido.id).length, 1, "el cliente con dos conversaciones sale una sola vez");
    assert.equal(new Set(todas).size, 4);
  } finally {
    await prisma.conversation.deleteMany({ where: { customer: { businessId: negocio.id } } });
    await prisma.customer.deleteMany({ where: { businessId: negocio.id } });
    await prisma.business.deleteMany({ where: { id: negocio.id } });
  }
});
