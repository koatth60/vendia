import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { deepseek } from "./client";
import { analyzeCustomerImage } from "./vision";

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
