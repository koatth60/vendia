import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { recordAskOwnerResolution, listPendingCandidates, approveCandidate, discardCandidate } from "./learnedFaq";

let businessId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
});

after(async () => {
  await prisma.learnedFaqCandidate.deleteMany({ where: { businessId } });
  await prisma.faqEntry.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("recordAskOwnerResolution creates a fresh candidate when nothing matches", async () => {
  await recordAskOwnerResolution(businessId, "Tienen envio a Cali?", "Si, llega en 3 dias.", null);
  const candidates = await listPendingCandidates(businessId);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].question, "Tienen envio a Cali?");
  assert.equal(candidates[0].answer, "Si, llega en 3 dias.");
  assert.equal(candidates[0].occurrences, 1);
});

test("recordAskOwnerResolution skips creating a candidate that strongly matches an existing active FAQ entry", async () => {
  await prisma.faqEntry.create({
    data: { businessId, question: "Cuanto cuesta el envio a Medellin", answer: "El envio a Medellin cuesta $15.000", active: true },
  });

  await recordAskOwnerResolution(businessId, "Cuanto vale el envio a Medellin?", "Vale $15.000", null);

  const candidates = await listPendingCandidates(businessId);
  assert.equal(
    candidates.filter((c) => c.question.toLowerCase().includes("medellin")).length,
    0,
    "should not suggest a candidate for something already covered by an active FAQ entry"
  );
});

test("recordAskOwnerResolution bumps occurrences instead of creating a duplicate for a matching pending candidate", async () => {
  await recordAskOwnerResolution(businessId, "Hacen envios a Cali los fines de semana?", "Si, dentro de 5 dias.", null);
  const firstPass = await listPendingCandidates(businessId);
  const target = firstPass.find((c) => c.question.includes("fines de semana"));
  assert.ok(target);
  assert.equal(target!.occurrences, 1);

  // Shares "envios", "cali", "fines", "semana" with the question above - clearly the same topic even
  // though it's phrased differently.
  await recordAskOwnerResolution(businessId, "Los envios a Cali llegan tambien los fines de semana?", "Claro que si.", null);

  const afterSecond = await listPendingCandidates(businessId);
  const stillTarget = afterSecond.find((c) => c.id === target!.id);
  assert.ok(stillTarget, "the original candidate row must still exist, not be replaced");
  assert.equal(stillTarget!.occurrences, 2);
  assert.equal(
    afterSecond.filter((c) => c.question.toLowerCase().includes("fines de semana")).length,
    1,
    "must not create a second row for the same topic"
  );
});

test("recordAskOwnerResolution does NOT treat a single shared incidental word as a match", async () => {
  await prisma.faqEntry.create({
    data: { businessId, question: "Tienen garantia los relojes?", answer: "Si, 6 meses de garantia.", active: true },
  });

  // Shares only the word "garantia" with the FAQ entry above (and the answer's "6 meses" is
  // deliberately irrelevant to the match) - not the same topic, must still create its own candidate.
  await recordAskOwnerResolution(businessId, "La garantia de los audifonos es de cuanto tiempo?", "3 meses.", null);

  const candidates = await listPendingCandidates(businessId);
  assert.equal(candidates.filter((c) => c.question.includes("audifonos")).length, 1, "a genuinely different topic must not be suppressed");
});

test("approveCandidate creates a real FaqEntry and removes the candidate from the pending list", async () => {
  await recordAskOwnerResolution(businessId, "Manejan pago contraentrega en Bogota?", "Si, disponible en Bogota.", null);
  const pending = await listPendingCandidates(businessId);
  const candidate = pending.find((c) => c.question.includes("contraentrega"));
  assert.ok(candidate);

  const entry = await approveCandidate(businessId, candidate!.id, {
    question: "¿Manejan contraentrega en Bogotá?",
    answer: "Sí, disponible en Bogotá.",
  });
  assert.equal(entry.question, "¿Manejan contraentrega en Bogotá?");

  const faqEntries = await prisma.faqEntry.findMany({ where: { businessId } });
  assert.ok(faqEntries.some((f) => f.id === entry.id));

  const afterApprove = await listPendingCandidates(businessId);
  assert.equal(afterApprove.some((c) => c.id === candidate!.id), false, "approved candidate must leave the pending list");
});

test("approveCandidate rejects an unknown or already-resolved candidate id", async () => {
  await assert.rejects(() => approveCandidate(businessId, "does-not-exist", { question: "x", answer: "y" }));
});

test("discardCandidate marks it resolved without creating a FaqEntry", async () => {
  await recordAskOwnerResolution(businessId, "Aceptan Daviplata?", "No por ahora.", null);
  const pending = await listPendingCandidates(businessId);
  const candidate = pending.find((c) => c.question.includes("Daviplata"));
  assert.ok(candidate);

  const faqCountBefore = await prisma.faqEntry.count({ where: { businessId } });
  await discardCandidate(businessId, candidate!.id);
  const faqCountAfter = await prisma.faqEntry.count({ where: { businessId } });
  assert.equal(faqCountAfter, faqCountBefore, "discarding must not create a FaqEntry");

  const afterDiscard = await listPendingCandidates(businessId);
  assert.equal(afterDiscard.some((c) => c.id === candidate!.id), false);
});

test("listPendingCandidates orders by occurrences (most-requested first)", async () => {
  const business2 = await prisma.business.create({
    data: { name: `Test ${randomUUID()}`, email: `test-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    await recordAskOwnerResolution(business2.id, "Tienen tienda fisica?", "No, solo online.", null);
    await recordAskOwnerResolution(business2.id, "Hacen envios a Estados Unidos?", "No por ahora.", null);
    // Bump the second one twice more (each shares "hacen"/"envios"/"estados"/"unidos" with the
    // original, well above the 2-token threshold) so it ends up with the highest occurrences.
    // La respuesta no puede ser un "No." pelado: desde el filtro de calidad (2026-09-15) una respuesta
    // que no dice nada por si sola ya no se guarda como sugerencia, porque era justo lo que llenaba las
    // FAQ de entradas que solo se entendian leyendo la conversacion original.
    await recordAskOwnerResolution(business2.id, "Ustedes hacen envios a Estados Unidos tambien?", "No, todavia no llegamos alla.", null);
    await recordAskOwnerResolution(business2.id, "Confirman que hacen envios a Estados Unidos?", "Todavia no.", null);

    const candidates = await listPendingCandidates(business2.id);
    assert.equal(candidates[0].question, "Hacen envios a Estados Unidos?");
    assert.equal(candidates[0].occurrences, 3);
  } finally {
    await prisma.learnedFaqCandidate.deleteMany({ where: { businessId: business2.id } });
    await prisma.business.deleteMany({ where: { id: business2.id } });
  }
});
