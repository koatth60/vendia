import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { getPhotoIdStreak, bumpPhotoIdStreak, resetPhotoIdStreak, getMediaSent, recordMediaSent } from "../orders/saleState";

// Fase 5 del plan maestro (2026-09-15), causa raiz C2: countUnresolvedPhotoIdStreak/PHOTO_ID_CLARIFY_PATTERN
// (agent.ts) escaneaban el historial buscando la frase del modelo "no logro identificar..." - se
// borraron enteros junto con el resto del backstop de medios. La racha ahora es estado real
// (SaleState.photoIdStreak), subido/resetado por generateReply (ver customerSentMediaThisTurn y
// shouldForcePhotoEscalation en agent.ts) segun si el turno realmente resolvio la foto (un envio real o
// una escalacion a ask_owner_about_photo), nunca leyendo texto.

let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Test PhotoIdStreak ${randomUUID()}`, email: `test-photoid-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, phoneNumber: `573003${Date.now()}` } });
  const conversation = await prisma.conversation.create({ data: { customerId: customer.id } });
  conversationId = conversation.id;
});

after(async () => {
  await prisma.saleState.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
});

test("photoIdStreak starts at 0 for a conversation with no SaleState row yet", async () => {
  assert.equal(await getPhotoIdStreak(conversationId), 0);
});

test("bumpPhotoIdStreak increments across calls, resetPhotoIdStreak brings it back to 0", async () => {
  await bumpPhotoIdStreak(conversationId);
  assert.equal(await getPhotoIdStreak(conversationId), 1);
  await bumpPhotoIdStreak(conversationId);
  assert.equal(await getPhotoIdStreak(conversationId), 2);
  await resetPhotoIdStreak(conversationId);
  assert.equal(await getPhotoIdStreak(conversationId), 0);
});

test("recordMediaSent dedupes and getMediaSent reads it back in order", async () => {
  await recordMediaSent(conversationId, "Smartwatch V20 Caballero");
  await recordMediaSent(conversationId, "Smartwatch gen 9");
  await recordMediaSent(conversationId, "Smartwatch V20 Caballero");
  assert.deepEqual(await getMediaSent(conversationId), ["Smartwatch V20 Caballero", "Smartwatch gen 9"]);
});
