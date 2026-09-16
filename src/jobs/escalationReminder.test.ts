import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runEscalationReminderJob } from "./escalationReminder";
import { CUSTOMER_FOLLOWUP_TEXT } from "../conversation/service";

let businessId: string;
let conversationId: string;
let originalFetch: typeof fetch;
let sentMessages: { to: string; body: string }[];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      contactPhone: "573000000000",
      contactName: "Owner",
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
    },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573006${Date.now()}`, name: "Cliente Test" } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId } });
  // The customer-followup send now writes a real Message row (see CUSTOMER_FOLLOWUP_TEXT), which the
  // Conversation FK blocks deleting without clearing first.
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") {
      sentMessages.push({ to, body: body.text?.body ?? "" });
    } else if (body.type === "template") {
      const paramText = body.template?.components?.[0]?.parameters?.[0]?.text ?? "";
      sentMessages.push({ to, body: paramText });
    }
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("runEscalationReminderJob reminds the owner once for an old unanswered question, then never again", async () => {
  stubWhatsappFetch();
  try {
    // A PendingOwnerQuestion always follows a real customer message in production (ask_owner only ever
    // fires in response to one) - seeded here so the 24h-window check the customer nudge now goes
    // through (see canReachCustomer) has something real to find.
    await prisma.message.create({
      data: { conversationId, role: "CUSTOMER", content: "¿Tienen envio a Medellin?", createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000) },
    });
    const pending = await prisma.pendingOwnerQuestion.create({
      data: {
        conversationId,
        wamid: `wamid.old-${randomUUID()}`,
        question: "¿Tienen envio a Medellin?",
        createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h ago, past the 3h threshold
      },
    });

    await runEscalationReminderJob();

    // One reminder to the owner (repeating the customer's question) and one proactive follow-up to the
    // customer itself ("seguimos revisando") - previously only the owner side existed, leaving the
    // customer with zero heads-up while a real business's own script promised exactly this follow-up.
    assert.equal(sentMessages.length, 2, "owner reminder + customer follow-up must both go out");
    assert.match(sentMessages[0].body, /Medellin/);
    assert.match(sentMessages[1].body, /revisando/i);

    const updated = await prisma.pendingOwnerQuestion.findUniqueOrThrow({ where: { id: pending.id } });
    assert.ok(updated.remindedAt, "remindedAt must be set so this question is never reminded again");

    // Second run must not re-send - remindedAt already set.
    sentMessages = [];
    await runEscalationReminderJob();
    assert.equal(sentMessages.length, 0, "must not send a second reminder for the same question");
  } finally {
    restoreFetch();
  }
});

test("runEscalationReminderJob does not remind about a question whose conversation already moved on", async () => {
  // Regression: a real orphaned PendingOwnerQuestion row (left over from the 2026-09-11 migration that
  // moved this off a single Conversation column) had humanControl:false - the conversation had already
  // resolved and even closed a sale - but nothing ever cleared the row, so it looked "due" and produced
  // a false reminder in production.
  stubWhatsappFetch();
  const customer2 = await prisma.customer.create({ data: { businessId, phoneNumber: `573007${Date.now()}` } });
  const resolvedConversation = await prisma.conversation.create({ data: { customerId: customer2.id, humanControl: false, status: "SOLD" } });
  try {
    await prisma.pendingOwnerQuestion.create({
      data: {
        conversationId: resolvedConversation.id,
        wamid: `wamid.orphaned-${randomUUID()}`,
        question: "(pregunta anterior a la migracion)",
        createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      },
    });

    await runEscalationReminderJob();
    assert.equal(sentMessages.length, 0, "must not remind about a question whose conversation is no longer muted");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: resolvedConversation.id } });
    await prisma.conversation.deleteMany({ where: { id: resolvedConversation.id } });
    await prisma.customer.deleteMany({ where: { id: customer2.id } });
  }
});

test("runEscalationReminderJob leaves a recent unanswered question alone", async () => {
  stubWhatsappFetch();
  try {
    await prisma.pendingOwnerQuestion.create({
      data: { conversationId, wamid: `wamid.recent-${randomUUID()}`, question: "¿Cuanto cuesta el envio?" },
    });

    await runEscalationReminderJob();
    assert.equal(sentMessages.length, 0, "a question younger than the threshold must not be reminded yet");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId } });
  }
});

test("runEscalationReminderJob reminds about a stalled conversation with no PendingOwnerQuestion (flag_conversation_intent origin)", async () => {
  // F1 from the 2026-09-13 audit: flag_conversation_intent sets humanControl:true but never creates a
  // PendingOwnerQuestion, so it was invisible to findPendingOwnerQuestionsDueForReminder forever.
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573008${Date.now()}` } });
  const conv = await prisma.conversation.create({
    data: {
      customerId: customer.id,
      humanControl: true,
      intent: "SOLICITA_AGENTE",
      humanControlSince: new Date(Date.now() - 4 * 60 * 60 * 1000),
    },
  });
  try {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "Necesito hablar con alguien", createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000) },
    });

    await runEscalationReminderJob();

    assert.equal(sentMessages.length, 2, "owner reminder + customer follow-up");
    assert.match(sentMessages[0].body, /asesor/i);

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(updated.stalledReminderStage, 1);
    assert.ok(updated.stalledReminderSentAt);

    sentMessages = [];
    await runEscalationReminderJob();
    assert.equal(sentMessages.length, 0, "must not repeat the stage-1 reminder on the next run");
  } finally {
    restoreFetch();
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("runEscalationReminderJob sends a final stage-2 reminder 24h after stage 1, then caps", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573009${Date.now()}` } });
  const conv = await prisma.conversation.create({
    data: {
      customerId: customer.id,
      humanControl: true,
      humanControlSince: new Date(Date.now() - 30 * 60 * 60 * 1000),
      stalledReminderStage: 1,
      stalledReminderSentAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    },
  });
  try {
    // The stage-1 run already left its own "seguimos revisando" as the last thing in the thread. That
    // must not read as a reply, or the final reminder would never fire for the conversations that need it.
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "¿Alguna novedad?", createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
    });
    await prisma.message.create({
      data: { conversationId: conv.id, role: "ASSISTANT", content: CUSTOMER_FOLLOWUP_TEXT, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    await runEscalationReminderJob();

    assert.equal(sentMessages.length, 1, "stage 2 only alerts the owner, no repeat customer message");
    assert.match(sentMessages[0].body, /24 horas/);

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(updated.stalledReminderStage, 2);

    sentMessages = [];
    await runEscalationReminderJob();
    assert.equal(sentMessages.length, 0, "stage 2 is the cap - no further reminders ever");
  } finally {
    restoreFetch();
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("runEscalationReminderJob does not double-fire the watchdog for a conversation whose question the dedicated mechanism already covers", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573010${Date.now()}` } });
  const since = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const conv = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true, humanControlSince: since } });
  try {
    await prisma.pendingOwnerQuestion.create({
      data: { conversationId: conv.id, wamid: `wamid.photo-${randomUUID()}`, question: "Identificar producto", createdAt: since, kind: "PHOTO_PRODUCT" },
    });
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "[Foto]", createdAt: since },
    });

    await runEscalationReminderJob();

    // The per-question mechanism reminds once (owner + customer = 2). The watchdog must stay silent this
    // run since the conversation's only question is still open and younger than the 24h stage-2 floor.
    assert.equal(sentMessages.length, 2);
    const updatedConv = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(updatedConv.stalledReminderStage, 0, "watchdog leaves stage untouched while the question mechanism owns this escalation");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conv.id } });
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// Real production incident (2026-09-13): the customer got the identical "Seguimos revisando..." message
// TWICE in the same second - a conversation with two separate open questions due for reminder at once
// sent the customer-facing nudge once PER QUESTION. Owner alerts must stay per-question (each names its
// own real question); the customer nudge must be deduped to once per conversation per run.
test("runEscalationReminderJob sends the customer-facing follow-up only ONCE when a conversation has two open questions due at once", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573011${Date.now()}` } });
  const conv = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true } });
  const oldEnough = new Date(Date.now() - 4 * 60 * 60 * 1000);
  try {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "Pregunta uno", createdAt: oldEnough },
    });
    await prisma.pendingOwnerQuestion.create({
      data: { conversationId: conv.id, wamid: `wamid.q1-${randomUUID()}`, question: "Pregunta uno", createdAt: oldEnough },
    });
    await prisma.pendingOwnerQuestion.create({
      data: { conversationId: conv.id, wamid: `wamid.q2-${randomUUID()}`, question: "Pregunta dos", createdAt: oldEnough },
    });

    await runEscalationReminderJob();

    const toOwner = sentMessages.filter((m) => m.to === "573000000000");
    const toCustomer = sentMessages.filter((m) => m.to === customer.phoneNumber);
    assert.equal(toOwner.length, 2, "the owner must still be reminded once per real open question");
    assert.equal(toCustomer.length, 1, "the customer must get the follow-up only once, not once per question");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conv.id } });
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// Real production incident (2026-09-14): the owner took over from the panel, answered the customer and
// asked him a question back ("¿lo quieres hoy o mañana?"). Every panel message calls setHumanControl(true),
// which re-armed humanControlSince - so her own reply scheduled a "seguimos revisando tu consulta" to the
// customer minutes later, contradicting her while the conversation was actually waiting on HIM.
test("runEscalationReminderJob stays silent when the owner already replied and is the one waiting", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573012${Date.now()}` } });
  // humanControlSince deliberately past the reminder threshold: that alone used to be enough to fire.
  const conv = await prisma.conversation.create({
    data: { customerId: customer.id, humanControl: true, humanControlSince: new Date(Date.now() - 4 * 60 * 60 * 1000) },
  });
  try {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "Si todo esta bien", createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000) },
    });
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: "ASSISTANT",
        content: "Hola buen día, ¿me confirmas el pedido? ¿Deseas recibirlo hoy o mañana?",
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });

    await runEscalationReminderJob();

    assert.equal(sentMessages.length, 0, "the business answered last - nothing is stalled, nobody gets pinged");
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(updated.stalledReminderStage, 0);
  } finally {
    restoreFetch();
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// Real incident (2026-09-14): the customer-facing nudge sent past WhatsApp's 24h window got a real
// wamid back (looked sent) and only failed hours later via the async status webhook. The owner alert
// must still go out either way - she needs to know the customer is unreachable through the panel too.
test("runEscalationReminderJob alerts the owner but skips the customer nudge once the 24h window is closed", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573014${Date.now()}` } });
  const conv = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true } });
  try {
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: "CUSTOMER",
        content: "¿Cuanto cuesta el envio?",
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
      },
    });
    await prisma.pendingOwnerQuestion.create({
      data: {
        conversationId: conv.id,
        wamid: `wamid.stale-${randomUUID()}`,
        question: "¿Cuanto cuesta el envio?",
        createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      },
    });

    await runEscalationReminderJob();

    assert.equal(sentMessages.length, 1, "owner alert only - the customer's window is already closed");
    assert.equal(sentMessages[0].to, "573000000000");
    assert.doesNotMatch(sentMessages[0].body, /revisando/i, "the customer text must not have gone out");
  } finally {
    restoreFetch();
    await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId: conv.id } });
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("runEscalationReminderJob alerts the owner but never the customer on a plain manual takeover", async () => {
  // The owner is personally chatting from the panel here - the bot promised the customer nothing, so a
  // canned "seguimos revisando" dropped into that thread would contradict whatever she last wrote.
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573013${Date.now()}` } });
  const since = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const conv = await prisma.conversation.create({ data: { customerId: customer.id, humanControl: true, humanControlSince: since } });
  try {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "¿Entonces me lo despachan hoy?", createdAt: since },
    });

    await runEscalationReminderJob();

    assert.equal(sentMessages.length, 1, "owner alert only");
    assert.equal(sentMessages[0].to, "573000000000");
    assert.doesNotMatch(sentMessages[0].body, /revisando/i);

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(updated.stalledReminderStage, 1, "the watchdog still tracks it, it just does not write to the customer");
  } finally {
    restoreFetch();
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

// Fase 9 del plan maestro (2026-09-15): defecto real - flag_conversation_intent escalo SOLICITA_AGENTE
// porque el cliente escribio "Cerrar conversation" (nunca pidio un asesor), y sin este escape la
// conversacion quedaba muda para siempre porque el dueno nunca la iba a responder. Business.intentEscalationTimeoutHours
// default es 48h (ver schema.prisma), asi que humanControlSince 50h atras ya la vence.
test("runEscalationReminderJob returns control to the bot when a flag_conversation_intent escalation times out, and flags when it was inferred", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573014${Date.now()}` } });
  const since = new Date(Date.now() - 50 * 60 * 60 * 1000);
  const conv = await prisma.conversation.create({
    data: { customerId: customer.id, humanControl: true, intent: "SOLICITA_AGENTE", intentExplicit: false, humanControlSince: since },
  });
  try {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "Cerrar conversation", createdAt: since },
    });

    await runEscalationReminderJob();

    const ownerAlert = sentMessages.find((m) => /devolvimos al bot/i.test(m.body));
    assert.ok(ownerAlert, "must send an alert telling the owner control went back to the bot");
    assert.match(ownerAlert!.body, /dedujo del contexto/i, "must flag that this was the model's own guess, not the customer's words");

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(updated.humanControl, false, "the bot must recover control instead of staying muted forever");
    assert.equal(updated.intent, null);
    assert.equal(updated.intentExplicit, null);

    const incident = await prisma.agentIncident.findFirst({ where: { conversationId: conv.id, kind: "INTENT_ESCALATION_TIMEOUT" } });
    assert.ok(incident, "must leave a queryable trace on the panel");
  } finally {
    restoreFetch();
    await prisma.agentIncident.deleteMany({ where: { conversationId: conv.id } });
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});

test("runEscalationReminderJob does not flag the owner note when the customer explicitly asked for an agent", async () => {
  stubWhatsappFetch();
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573015${Date.now()}` } });
  const since = new Date(Date.now() - 50 * 60 * 60 * 1000);
  const conv = await prisma.conversation.create({
    data: { customerId: customer.id, humanControl: true, intent: "SOLICITA_AGENTE", intentExplicit: true, humanControlSince: since },
  });
  try {
    await prisma.message.create({
      data: { conversationId: conv.id, role: "CUSTOMER", content: "Quiero hablar con un asesor", createdAt: since },
    });

    await runEscalationReminderJob();

    const ownerAlert = sentMessages.find((m) => /devolvimos al bot/i.test(m.body));
    assert.ok(ownerAlert);
    assert.doesNotMatch(ownerAlert!.body, /dedujo del contexto/i, "a real customer request must not be flagged as a guess");
  } finally {
    restoreFetch();
    await prisma.agentIncident.deleteMany({ where: { conversationId: conv.id } });
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });
    await prisma.conversation.deleteMany({ where: { id: conv.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  }
});
