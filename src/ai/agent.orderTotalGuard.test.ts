import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { guardAgainstOrderTotalMismatch } from "./agent";
import type { ToolContext } from "./tools";

// Fase F of the 2026-09-13 audit (B5): a hard backstop exists for a hallucinated payment number and a
// detection-only one for shipping cost, but nothing checked the order TOTAL the bot tells the customer,
// even though show_order_summary already computes exactly one real, unambiguous total per call. A wrong
// total here means a customer confirming payment for the wrong amount - same money-risk class as the
// payment guard.

let businessId: string;
let context: ToolContext;
let originalFetch: typeof fetch;
let sentToOwner: string[];

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      contactPhone: "573000000005",
      contactName: "Owner",
    },
  });
  businessId = business.id;
  context = {
    businessId,
    conversationId: "n/a",
    customerId: "n/a",
    credentials: { phoneNumberId: "test-id", accessToken: "test-token" },
    recipientPhone: "573001112233",
  };
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sentToOwner = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.type === "template") sentToOwner.push(body.template?.components?.[0]?.parameters?.[0]?.text ?? "");
    if (body.type === "text") sentToOwner.push(body.text?.body ?? "");
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("alerts the owner when the reply states a total different from show_order_summary's real total", async () => {
  const text = "Perfecto, tu pedido queda con un total de $180.000. Confirmame para cerrar.";
  await guardAgainstOrderTotalMismatch(context, text, 150000);
  assert.equal(sentToOwner.length, 1, "must alert the owner about the mismatched total");
  assert.match(sentToOwner[0], /150000|150\.000/);
});

test("does nothing when the reply correctly quotes the real total", async () => {
  const text = "Perfecto, tu pedido queda con un total de $150.000. Confirmame para cerrar.";
  await guardAgainstOrderTotalMismatch(context, text, 150000);
  assert.equal(sentToOwner.length, 0);
});

test("does nothing when show_order_summary never ran this turn (no real total to compare against)", async () => {
  const text = "Perfecto, tu pedido queda con un total de $999.999. Confirmame para cerrar.";
  await guardAgainstOrderTotalMismatch(context, text, null);
  assert.equal(sentToOwner.length, 0);
});

test("does nothing when the reply never mentions a total at all", async () => {
  const text = "Claro, tenemos ese producto en negro y en blanco, ¿cual prefieres?";
  await guardAgainstOrderTotalMismatch(context, text, 150000);
  assert.equal(sentToOwner.length, 0);
});
