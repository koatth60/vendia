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
  await prisma.agentIncident.deleteMany({ where: { businessId } });
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

// Incidente real (2026-09-14): una clienta mando la captura de un live con un combo en la caja. DeepSeek
// vio bien la imagen, pero en una de cada tres corridas invento "una bateria portatil o power bank" con
// total seguridad - y ese negocio vende una "Bateria portatil power bank 12000 mah", asi que la
// descripcion equivocada enganchaba fuerte con el producto equivocado. Una descripcion segura y
// equivocada no se distingue por texto ni por coincidencia con el catalogo, asi que TODA foto de
// producto pasa por el modelo fuerte, no solo las que DeepSeek marca como poco claras.
test("analyzeCustomerImage escalates every product photo, even one whose description matches the catalog", { skip: !hasAnthropic }, async () => {
  const product = await prisma.product.create({
    data: { businessId, name: "Bateria portatil power bank 12000 mah", description: "x", price: 60000, currency: "COP", stock: 3 },
  });
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO: parece ser una bateria portatil o power bank blanco" } }],
    usage: { completion_tokens: 5 },
  });
  let anthropicCalls = 0;
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => {
    anthropicCalls++;
    return {
      content: [{ type: "text", text: "PRODUCTO: combo con smartwatch, estuche de audifonos y correa metalica" }],
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  };

  try {
    const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
    assert.equal(anthropicCalls, 1, "matching the catalog is not evidence the description is right");
    assert.equal(
      result,
      "PRODUCTO: combo con smartwatch, estuche de audifonos y correa metalica",
      "when the stronger model can also identify it, its answer wins"
    );
  } finally {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }
});

// La llave de Anthropic estuvo mal configurada (sin workspace) desde que se construyo la escalacion
// hasta el 2026-09-14: cada llamada fallaba, el catch devolvia null y la conversacion seguia normal, asi
// que nadie se entero por semanas. "0 escalaciones" se veia igual que "nunca hizo falta escalar".
test("analyzeCustomerImage records an incident when the Anthropic call fails, instead of failing silently", { skip: !hasAnthropic }, async () => {
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO: reloj negro" } }],
    usage: { completion_tokens: 5 },
  });
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => {
    throw new Error("This API key is not scoped to a workspace");
  };

  const conversationId = randomUUID();
  const result = await analyzeCustomerImage(businessId, conversationId, "https://example.com/img.jpg", "");
  assert.equal(result, "PRODUCTO: reloj negro", "a failed escalation must never break the customer's reply");

  const incident = await prisma.agentIncident.findFirst({
    where: { businessId, conversationId, kind: "EXTERNAL_API_FAILURE" },
  });
  assert.ok(incident, "the failure must leave a queryable trace, not just a console.error");
  assert.match(incident.detail, /workspace/, "the incident must say what actually broke");
});

test("analyzeCustomerImage keeps DeepSeek's description when the escalated model cannot identify it either", { skip: !hasAnthropic }, async () => {
  // @ts-expect-error stubbing for the test
  deepseek.chat.completions.create = async () => ({
    choices: [{ message: { content: "PRODUCTO: reloj inteligente negro con correa de silicona" } }],
    usage: { completion_tokens: 5 },
  });
  // @ts-expect-error stubbing for the test
  anthropic!.messages.create = async () => ({
    content: [{ type: "text", text: "PRODUCTO_POCO_CLARO: la mano tapa el producto" }],
    usage: { input_tokens: 100, output_tokens: 10 },
  });

  const result = await analyzeCustomerImage(businessId, randomUUID(), "https://example.com/img.jpg", "");
  assert.equal(
    result,
    "PRODUCTO: reloj inteligente negro con correa de silicona",
    "escalating must never lose information - fall back to what DeepSeek did manage to see"
  );
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
