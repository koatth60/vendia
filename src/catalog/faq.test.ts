import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { listActiveFaqEntries, createFaqEntry, updateFaqEntry } from "./faq";

let businessId: string;
let activeEntryId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;

  const active = await createFaqEntry(businessId, {
    question: "Cual es la politica de envíos?",
    answer: "Enviamos a toda Colombia.",
  });
  activeEntryId = active.id;

  const inactive = await createFaqEntry(businessId, {
    question: "Promocion vieja",
    answer: "Ya no aplica.",
  });
  await updateFaqEntry(businessId, inactive.id, { active: false });
});

after(async () => {
  await prisma.faqEntry.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("listActiveFaqEntries returns the full active list regardless of how the customer phrases things", async () => {
  // The agent tool no longer pre-filters by keyword match (that missed paraphrased questions,
  // and used to mangle accents like "envios" vs stored "envíos") - it hands the whole active
  // list to the model, which reads it for meaning instead.
  const results = await listActiveFaqEntries(businessId);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, activeEntryId);
});

test("listActiveFaqEntries excludes inactive entries", async () => {
  const results = await listActiveFaqEntries(businessId);
  assert.ok(!results.some((r) => r.question === "Promocion vieja"));
});
