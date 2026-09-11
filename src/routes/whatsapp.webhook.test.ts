import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { whatsappRouter } from "./whatsapp";

// Regression coverage for previously-silent message types (location/sticker/document/contacts) being
// dropped with zero trace. Runs the real webhook route end to end (including a real DeepSeek call for
// the bot's reply, same tradeoff as agent.escalation.test.ts) - only the outgoing WhatsApp Graph API
// calls are stubbed.

let server: Server;
let baseUrl: string;
let businessId: string;
let customerPhone: string;
let originalFetch: typeof fetch;
let outgoing: { type: string; body: unknown }[];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(whatsappRouter);
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const business = await prisma.business.create({
    data: {
      name: `Test ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      active: true,
      whatsappPhoneNumberId: `test-phone-${randomUUID()}`,
      whatsappAccessToken: "test-token",
    },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.business.deleteMany({ where: { id: businessId } });
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

beforeEach(() => {
  customerPhone = `57300${Date.now()}${Math.floor(Math.random() * 1000)}`;
  originalFetch = globalThis.fetch;
  outgoing = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("graph.facebook.com")) {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        outgoing.push({ type: body.type, body });
        return { ok: true, json: async () => ({ messages: [{ id: `wamid.test-${randomUUID()}` }] }) } as Response;
      }
      // downloadMedia's metadata GET (src/whatsapp/client.ts) - returns where the actual bytes live.
      return { ok: true, json: async () => ({ url: "https://fake-cdn.example.com/media.mp4", mime_type: "video/mp4" }) } as Response;
    }
    if (String(url).includes("fake-cdn.example.com")) {
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("fake video bytes").buffer } as Response;
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId, phoneNumber: customerPhone } } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId, phoneNumber: customerPhone } } });
  await prisma.customer.deleteMany({ where: { businessId, phoneNumber: customerPhone } });
});

async function postWebhook(message: Record<string, unknown>) {
  const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: business.whatsappPhoneNumberId },
              messages: [{ from: customerPhone, id: `wamid.in-${randomUUID()}`, ...message }],
            },
          },
        ],
      },
    ],
  };
  const res = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
}

// The webhook handler sends its HTTP 200 immediately and keeps processing (recordMessage ->
// generateReply -> reply) AFTER that response is already flushed - a test that asserts right after
// `fetch()` resolves is racing that background work. Poll for the ASSISTANT reply row instead, which is
// the last thing the handler writes, as the "processing finished" signal.
async function waitForAssistantReply(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await prisma.message.findFirst({
      where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "ASSISTANT" },
    });
    if (reply) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for the bot's reply to be recorded");
}

test("webhook: a location message is recorded (not silently dropped) and gets a bot reply", async () => {
  await postWebhook({ type: "location", location: { latitude: 4.65, longitude: -74.05, name: "Casa", address: "Calle 1 # 2-3" } });
  await waitForAssistantReply();

  const message = await prisma.message.findFirst({
    where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "CUSTOMER" },
  });
  assert.ok(message, "the location message must be recorded, not silently dropped");
  assert.match(message!.content, /ubicacion/i);

  const replySent = outgoing.some((o) => o.type === "text");
  assert.ok(replySent, "the bot should have replied instead of staying silent for an unsupported-before type");
});

test("webhook: a sticker message is recorded and does not crash the pipeline", async () => {
  await postWebhook({ type: "sticker", sticker: { id: "sticker123" } });
  await waitForAssistantReply();

  const message = await prisma.message.findFirst({
    where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "CUSTOMER" },
  });
  assert.ok(message);
  assert.match(message!.content, /sticker/i);
});

test("webhook: a document message is recorded with a note to resend as a photo", async () => {
  await postWebhook({ type: "document", document: { id: "doc123", filename: "comprobante.pdf" } });
  await waitForAssistantReply();

  const message = await prisma.message.findFirst({
    where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "CUSTOMER" },
  });
  assert.ok(message);
  assert.match(message!.content, /documento/i);
  assert.match(message!.content, /comprobante\.pdf/);
});

test("webhook: a contacts card message is recorded, not silently dropped", async () => {
  await postWebhook({ type: "contacts", contacts: [{ name: { formatted_name: "Juan" } }] });
  await waitForAssistantReply();

  const message = await prisma.message.findFirst({
    where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "CUSTOMER" },
  });
  assert.ok(message);
  assert.match(message!.content, /contacto/i);
});

test("webhook: a video message is recorded as VIDEO media and the pipeline keeps going even when frame extraction fails", async () => {
  // No real ffmpeg/video fixture here (see src/media/videoFrame.test.ts for the real extraction
  // coverage, which skips without ffmpeg on this machine) - this proves the video branch doesn't
  // crash the webhook and still lets the bot reply when the analysis step fails, same resilience
  // already relied on for the image branch's try/catch.
  await postWebhook({ type: "video", video: { id: "video123" } });
  await waitForAssistantReply();

  const message = await prisma.message.findFirst({
    where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "CUSTOMER" },
  });
  assert.ok(message, "the video message must be recorded, not silently dropped");
  assert.equal(message!.mediaType, "VIDEO");

  const replySent = outgoing.some((o) => o.type === "text");
  assert.ok(replySent, "the bot should still reply after a video message even if analysis fails");
});

test("webhook: a reaction (emoji reply) is intentionally NOT recorded as a customer turn", async () => {
  await postWebhook({ type: "reaction", reaction: { emoji: "👍", message_id: "wamid.something" } });
  // No ASSISTANT reply will ever come for a reaction - give the (intentionally silent) pipeline a beat
  // to prove it stays silent, instead of a full poll-to-timeout.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const message = await prisma.message.findFirst({
    where: { conversation: { customer: { businessId, phoneNumber: customerPhone } }, role: "CUSTOMER" },
  });
  assert.equal(message, null, "a reaction should stay silent by design, not generate bot chatter");
});
