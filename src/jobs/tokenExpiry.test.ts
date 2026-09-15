import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { runTokenExpiryJob } from "./tokenExpiry";

let originalFetch: typeof fetch;
let sentMessages: { to: string; body: string }[];

function stubWhatsappFetch() {
  originalFetch = globalThis.fetch;
  sentMessages = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = body.to ?? body.recipient;
    if (body.type === "text") sentMessages.push({ to, body: body.text?.body ?? "" });
    else if (body.type === "template") sentMessages.push({ to, body: body.template?.components?.[0]?.parameters?.[0]?.text ?? "" });
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const createdBusinessIds: string[] = [];
async function createBusiness(data: Partial<Parameters<typeof prisma.business.create>[0]["data"]>) {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      contactPhone: "573000000000",
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
      ...data,
    },
  });
  createdBusinessIds.push(business.id);
  return business;
}

after(async () => {
  await prisma.business.deleteMany({ where: { id: { in: createdBusinessIds } } });
});

test("runTokenExpiryJob warns the owner once when the token expires within 7 days, then never again", async () => {
  stubWhatsappFetch();
  try {
    const business = await createBusiness({ whatsappTokenExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });

    await runTokenExpiryJob();

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].body, /vence en 3/);

    const updated = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    assert.ok(updated.whatsappTokenExpiryNotifiedAt, "whatsappTokenExpiryNotifiedAt must be set so this expiry is never reminded again");

    sentMessages = [];
    await runTokenExpiryJob();
    assert.equal(sentMessages.length, 0, "must not send a second warning for the same expiry");
  } finally {
    restoreFetch();
  }
});

test("runTokenExpiryJob leaves a token that expires beyond the warning window alone", async () => {
  stubWhatsappFetch();
  try {
    await createBusiness({ whatsappTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });

    await runTokenExpiryJob();
    assert.equal(sentMessages.length, 0, "an expiry more than 7 days out must not warn yet");
  } finally {
    restoreFetch();
  }
});

test("runTokenExpiryJob does not warn a business without a stored expiry", async () => {
  stubWhatsappFetch();
  try {
    await createBusiness({ whatsappTokenExpiresAt: null });

    await runTokenExpiryJob();
    assert.equal(sentMessages.length, 0, "no expiry stored means nothing to warn about (manual token, never set)");
  } finally {
    restoreFetch();
  }
});
