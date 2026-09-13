import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../db/client";
import { deepseek } from "../ai/client";
import { adminRouter } from "./admin";

// Covers POST /api/improve-instructions - extended 2026-09-13 (ONIX-RELIABILITY-PLAN.md Track B) to also
// aim at shortening customInstructions, not just grammar, and to scale max_tokens with input length so a
// long real customInstructions doesn't get truncated mid-rewrite. Real HTTP through the router, fake
// session injected directly; the DeepSeek call itself is stubbed (see CLAUDE.md - never make a real paid
// call from a *.test.ts file).

let server: Server;
let baseUrl: string;
let businessId: string;
let originalCreate: typeof deepseek.chat.completions.create;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { businessId?: string; role?: string } }).session = { businessId, role: "OWNER" };
    next();
  });
  app.use(adminRouter);
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  await prisma.aiUsageLog.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

let lastCreateParams: Record<string, unknown> | null = null;

beforeEach(() => {
  lastCreateParams = null;
});

afterEach(() => {
  deepseek.chat.completions.create = originalCreate;
});

function stubDeepseek(replyText: string | null) {
  // @ts-expect-error stubbing for the test, real signature is wider than we need here
  deepseek.chat.completions.create = async (params: any) => {
    lastCreateParams = params;
    return {
      choices: [{ message: { content: replyText } }],
      usage: { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 5, completion_tokens: 20 },
    };
  };
}

test("rejects an empty text without calling DeepSeek", async () => {
  stubDeepseek("no deberia llegar aca");
  const res = await fetch(`${baseUrl}/api/improve-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(res.status, 400);
  assert.equal(lastCreateParams, null);
});

test("returns the rewritten text and logs AI usage on success", async () => {
  stubDeepseek("Instrucciones reescritas mas cortas.");
  const res = await fetch(`${baseUrl}/api/improve-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Si preguntan por mayoristas responde que escriban a ventas." }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { improved: string };
  assert.equal(body.improved, "Instrucciones reescritas mas cortas.");

  const logs = await prisma.aiUsageLog.findMany({ where: { businessId } });
  assert.equal(logs.length, 1);
});

test("scales max_tokens up for a long input instead of using a fixed low ceiling", async () => {
  stubDeepseek("ok");
  const longText = "x".repeat(9000); // ~ same order of magnitude as the longest real customInstructions seen
  await fetch(`${baseUrl}/api/improve-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: longText }),
  });
  assert.ok(lastCreateParams, "DeepSeek should have been called");
  const maxTokens = (lastCreateParams as any).max_tokens;
  assert.ok(maxTokens > 600, `expected max_tokens to scale above the old fixed 600, got ${maxTokens}`);
});

test("returns 502 when DeepSeek returns no content", async () => {
  stubDeepseek(null);
  const res = await fetch(`${baseUrl}/api/improve-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "algo para reescribir" }),
  });
  assert.equal(res.status, 502);
});
