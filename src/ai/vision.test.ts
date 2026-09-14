import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { analyzeCustomerImage } from "./vision";
import { anthropic } from "./visionEscalation";

// Regression coverage for the retry-on-transient-error fix: a thrown error used to permanently fall
// back to "no pude ver la imagen" for that message, exactly like an unrecoverable error, with zero
// automatic recovery attempt.

let businessId: string;
let originalCreate: typeof deepseek.chat.completions.create;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.aiUsageLog.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

beforeEach(() => {
  originalCreate = deepseek.chat.completions.create.bind(deepseek.chat.completions);
});

afterEach(() => {
  deepseek.chat.completions.create = originalCreate;
});

test("analyzeCustomerImage retries once after a thrown error and returns the analysis on success", async () => {
  let calls = 0;
  // @ts-expect-error stubbing for the test, real signature is wider than we need here
  deepseek.chat.completions.create = async () => {
    calls++;
    if (calls === 1) throw new Error("simulated transient DeepSeek vision failure");
    return { choices: [{ message: { content: "PRODUCTO: reloj negro" } }], usage: { completion_tokens: 5 } };
  };

  const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
  assert.equal(result, "PRODUCTO: reloj negro");
  assert.equal(calls, 2, "expected exactly one retry after the first failure");
});

test("analyzeCustomerImage gives up with the technical-error message after two consecutive failures", async () => {
  let calls = 0;
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => {
    calls++;
    throw new Error("simulated persistent DeepSeek vision failure");
  };

  const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
  assert.match(result, /error tecnico/i);
  assert.equal(calls, 2, "expected exactly two attempts total, not an unbounded retry loop");
});

test("analyzeCustomerImage passes the catalogHint into the vision prompt sent to DeepSeek", async () => {
  let sentText = "";
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async (params: any) => {
    sentText = params.messages[0].content.find((c: any) => c.type === "text").text;
    return { choices: [{ message: { content: "PRODUCTO: reloj negro" } }], usage: { completion_tokens: 5 } };
  };

  await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "", "audifonos, relojes inteligentes");
  assert.match(sentText, /audifonos, relojes inteligentes/);
});

// Escalacion a Anthropic: solo corre de verdad si hay ANTHROPIC_API_KEY configurada en el entorno de
// test (anthropic !== null) - sin la key, la funcion ya devuelve null por diseno y no hay nada que
// monkeypatchear (ver src/ai/visionEscalation.ts).
const hasAnthropic = anthropic !== null;

let originalFetch: typeof fetch;
let originalAnthropicCreate: any;

beforeEach(() => {
  if (!hasAnthropic) return;
  originalFetch = globalThis.fetch;
  originalAnthropicCreate = anthropic!.messages.create.bind(anthropic!.messages);
  globalThis.fetch = (async () => ({
    ok: true,
    headers: new Headers({ "content-type": "image/jpeg" }),
    arrayBuffer: async () => new ArrayBuffer(4),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasAnthropic) return;
  globalThis.fetch = originalFetch;
  anthropic!.messages.create = originalAnthropicCreate;
});

test("analyzeCustomerImage escalates to Anthropic when DeepSeek can't tell, and uses the escalated answer when it's clear", { skip: !hasAnthropic }, async () => {
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO_POCO_CLARO: muy borrosa" } }],
    usage: { completion_tokens: 5 },
  });
  let anthropicCalls = 0;
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => {
    anthropicCalls++;
    return {
      content: [{ type: "text", text: "PRODUCTO: audifono inalambrico negro" }],
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  };

  const conversationId = randomUUID();
  const result = await analyzeCustomerImage(businessId, conversationId, "https://example.com/img.jpg", "");
  assert.equal(result, "PRODUCTO: audifono inalambrico negro");
  assert.equal(anthropicCalls, 1);

  const log = await prisma.aiUsageLog.findFirst({ where: { businessId, conversationId, kind: "VISION_ESCALATION" } });
  assert.ok(log, "expected the Anthropic escalation call to be logged separately for cost tracking");
});

test("analyzeCustomerImage does NOT escalate when DeepSeek's description already matches the catalog", { skip: !hasAnthropic }, async () => {
  const product = await prisma.product.create({
    data: { businessId, name: "Reloj inteligente negro", description: "x", price: 145000, currency: "COP", stock: 3 },
  });
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO: reloj inteligente negro" } }],
    usage: { completion_tokens: 5 },
  });
  let anthropicCalls = 0;
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => {
    anthropicCalls++;
    return { content: [{ type: "text", text: "PRODUCTO: no deberia llegar aca" }], usage: { input_tokens: 1, output_tokens: 1 } };
  };

  try {
    const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
    assert.equal(result, "PRODUCTO: reloj inteligente negro");
    assert.equal(anthropicCalls, 0, "a description the catalog can already find must never spend the Anthropic call");
  } finally {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

// Incidente real (2026-09-14): una clienta mando la captura de un live con el producto en la caja.
// DeepSeek la vio bien y la describio, pero en terminos tan genericos que el catalogo no encontro nada,
// y el bot termino pidiendole a ella el nombre/referencia. Como el resultado no empezaba con
// PRODUCTO_POCO_CLARO, la escalacion nunca se intentaba: solo cubria fotos borrosas.
test("analyzeCustomerImage escalates a clear description that the catalog cannot match, and takes the better one", { skip: !hasAnthropic }, async () => {
  const product = await prisma.product.create({
    data: { businessId, name: "Smartwatch Serie 12", description: "x", price: 145000, currency: "COP", stock: 3 },
  });
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO: una caja blanca abierta con un dispositivo adentro" } }],
    usage: { completion_tokens: 5 },
  });
  let anthropicCalls = 0;
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => {
    anthropicCalls++;
    return {
      content: [{ type: "text", text: "PRODUCTO: smartwatch serie 12, caja blanca con la referencia impresa" }],
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  };

  try {
    const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
    assert.equal(result, "PRODUCTO: smartwatch serie 12, caja blanca con la referencia impresa");
    assert.equal(anthropicCalls, 1);
  } finally {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

test("analyzeCustomerImage keeps DeepSeek's description when the escalated one is just as unusable", { skip: !hasAnthropic }, async () => {
  const product = await prisma.product.create({
    data: { businessId, name: "Smartwatch Serie 12", description: "x", price: 145000, currency: "COP", stock: 3 },
  });
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO: una caja blanca abierta con un dispositivo adentro" } }],
    usage: { completion_tokens: 5 },
  });
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => ({
    content: [{ type: "text", text: "PRODUCTO: una caja de carton clara sobre una mesa" }],
    usage: { input_tokens: 100, output_tokens: 10 },
  });

  try {
    const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
    assert.equal(
      result,
      "PRODUCTO: una caja blanca abierta con un dispositivo adentro",
      "a second description the catalog also cannot match is not an improvement - keep DeepSeek's"
    );
  } finally {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

test("analyzeCustomerImage keeps DeepSeek's original unclear result when Anthropic also can't tell", { skip: !hasAnthropic }, async () => {
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO_POCO_CLARO: muy oscura" } }],
    usage: { completion_tokens: 5 },
  });
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => ({
    content: [{ type: "text", text: "PRODUCTO_POCO_CLARO: sigue sin verse bien" }],
    usage: { input_tokens: 100, output_tokens: 10 },
  });

  const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
  assert.equal(result, "PRODUCTO_POCO_CLARO: muy oscura", "must fall back to DeepSeek's own unclear result, not silently swap it");
});
