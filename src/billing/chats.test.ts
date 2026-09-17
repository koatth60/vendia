import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  recordBillableChat,
  getChatUsage,
  checkChatOverage,
  periodStartOf,
  getChatCap,
  CHAT_WINDOW_HOURS,
  EXTRA_CHAT_PRICE_COP,
} from "./chats";

let businessId: string;
let customerId: string;
let otherCustomerId: string;

const HOUR = 60 * 60 * 1000;

before(async () => {
  const business = await prisma.business.create({
    data: {
      name: `Test Business ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
      passwordHash: "x",
      planTier: "BASICO", // tope = 500 chats, ver PLAN_CHAT_CAPS
    },
  });
  businessId = business.id;

  const customer = await prisma.customer.create({
    data: { businessId, phoneNumber: `573000${Date.now()}` },
  });
  customerId = customer.id;

  const other = await prisma.customer.create({
    data: { businessId, phoneNumber: `573001${Date.now()}` },
  });
  otherCustomerId = other.id;
});

beforeEach(async () => {
  await prisma.billableChat.deleteMany({ where: { businessId } });
  await prisma.business.update({ where: { id: businessId }, data: { capNotifiedAt: null } });
});

after(async () => {
  await prisma.billableChat.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("varios mensajes seguidos del mismo cliente son UN solo chat", async () => {
  const now = new Date();
  const first = await recordBillableChat({ businessId, customerId, at: now });
  const second = await recordBillableChat({ businessId, customerId, at: new Date(now.getTime() + 60_000) });
  const third = await recordBillableChat({ businessId, customerId, at: new Date(now.getTime() + 3 * HOUR) });

  assert.equal(first.opened, true);
  assert.equal(second.opened, false);
  assert.equal(third.opened, false);
  assert.equal(second.chatId, first.chatId);
  assert.equal(third.chatId, first.chatId);

  const usage = await getChatUsage(businessId, now);
  assert.equal(usage.chatsUsed, 1, "tres mensajes de la misma interaccion no son tres chats");

  const row = await prisma.billableChat.findUniqueOrThrow({ where: { id: first.chatId } });
  assert.equal(row.messageCount, 3);
});

test("el chat sigue abierto justo antes de las 48 horas y se cierra pasadas", async () => {
  const now = new Date();
  const opened = await recordBillableChat({ businessId, customerId, at: now });

  const justInside = await recordBillableChat({
    businessId,
    customerId,
    at: new Date(now.getTime() + CHAT_WINDOW_HOURS * HOUR - 60_000),
  });
  assert.equal(justInside.opened, false, "un minuto antes del limite sigue siendo el mismo chat");
  assert.equal(justInside.chatId, opened.chatId);

  // La ventana se mide contra el ULTIMO mensaje, no contra el primero: el de recien movio el reloj.
  const justOutside = await recordBillableChat({
    businessId,
    customerId,
    at: new Date(now.getTime() + 2 * CHAT_WINDOW_HOURS * HOUR),
  });
  assert.equal(justOutside.opened, true, "pasadas 48h sin actividad, el cliente que vuelve abre un chat nuevo");
  assert.notEqual(justOutside.chatId, opened.chatId);

  const usage = await getChatUsage(businessId, now);
  assert.equal(usage.chatsUsed, 2);
});

test("cada cliente lleva su propia ventana", async () => {
  const now = new Date();
  const a = await recordBillableChat({ businessId, customerId, at: now });
  const b = await recordBillableChat({ businessId, customerId: otherCustomerId, at: now });

  assert.equal(a.opened, true);
  assert.equal(b.opened, true, "el chat abierto de otro cliente no absorbe este mensaje");

  const usage = await getChatUsage(businessId, now);
  assert.equal(usage.chatsUsed, 2);
});

test("un webhook que llega tarde no mueve el reloj hacia atras", async () => {
  const now = new Date();
  const opened = await recordBillableChat({ businessId, customerId, at: now });
  await recordBillableChat({ businessId, customerId, at: new Date(now.getTime() - 5 * HOUR) });

  const row = await prisma.billableChat.findUniqueOrThrow({ where: { id: opened.chatId } });
  assert.equal(row.lastMessageAt.getTime(), now.getTime());
});

test("el chat se cuenta en el mes en que ABRIO, aunque siga en el siguiente", async () => {
  // Ultimo dia de un mes, y un mensaje del dia siguiente que cae dentro de la ventana.
  const lastDay = new Date(2026, 8, 30, 20, 0, 0);
  const nextMonth = new Date(2026, 9, 1, 8, 0, 0);

  const opened = await recordBillableChat({ businessId, customerId, at: lastDay });
  const continued = await recordBillableChat({ businessId, customerId, at: nextMonth });
  assert.equal(continued.chatId, opened.chatId);

  const september = await getChatUsage(businessId, lastDay);
  const october = await getChatUsage(businessId, nextMonth);
  assert.equal(september.chatsUsed, 1);
  assert.equal(october.chatsUsed, 0, "no se cobra dos veces la misma interaccion en dos meses");

  const row = await prisma.billableChat.findUniqueOrThrow({ where: { id: opened.chatId } });
  assert.equal(row.periodStart.getTime(), periodStartOf(lastDay).getTime());
});

test("pasar el tope no apaga el bot: factura los chats extra y avisa una sola vez", async () => {
  const now = new Date();
  const cap = getChatCap("BASICO");
  const periodStart = periodStartOf(now);

  // Se siembran cap + 3 chats directamente: abrir 503 por recordBillableChat seria 503 pares de
  // consultas para probar una cuenta.
  await prisma.billableChat.createMany({
    data: Array.from({ length: cap + 3 }, () => ({
      businessId,
      customerId,
      startedAt: now,
      lastMessageAt: now,
      periodStart,
    })),
  });

  const usage = await getChatUsage(businessId, now);
  assert.equal(usage.chatsUsed, cap + 3);
  assert.equal(usage.extraChats, 3);
  assert.equal(usage.extraChargeCop, 3 * EXTRA_CHAT_PRICE_COP);

  const first = await checkChatOverage(businessId);
  assert.equal(first.overLimit, true);
  assert.equal(first.justCrossed, true);

  const second = await checkChatOverage(businessId);
  assert.equal(second.overLimit, true);
  assert.equal(second.justCrossed, false, "al dueno se le avisa una vez por periodo, no en cada mensaje");
});

test("justo en el tope todavia no hay nada que facturar", async () => {
  const now = new Date();
  const cap = getChatCap("BASICO");

  await prisma.billableChat.createMany({
    data: Array.from({ length: cap }, () => ({
      businessId,
      customerId,
      startedAt: now,
      lastMessageAt: now,
      periodStart: periodStartOf(now),
    })),
  });

  const status = await checkChatOverage(businessId);
  assert.equal(status.overLimit, false);
  assert.equal(status.extraChats, 0);
  assert.equal(status.extraChargeCop, 0);
  assert.equal(status.usagePercent, 100);
});
