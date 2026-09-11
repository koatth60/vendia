import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runEscalationReminderJob } from "./escalationReminder";

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
      whatsappPhoneNumberId: "test-phone-id",
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
    const pending = await prisma.pendingOwnerQuestion.create({
      data: {
        conversationId,
        wamid: `wamid.old-${randomUUID()}`,
        question: "¿Tienen envio a Medellin?",
        createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h ago, past the 3h threshold
      },
    });

    await runEscalationReminderJob();

    assert.equal(sentMessages.length, 1, "owner must get exactly one reminder");
    assert.match(sentMessages[0].body, /Medellin/);

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
