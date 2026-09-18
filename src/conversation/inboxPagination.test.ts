import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  listCustomerThreadsForBusiness,
  decodeInboxCursor,
  getCustomerThreadForBusiness,
  getOlderMessagesOfConversation,
  INBOX_PAGE_SIZE,
} from "./service";

// E45 (2026-09-18). LA BANDEJA Y EL HILO PAGINAN POR CURSOR.
//
// Con el volumen de producción de hoy nada de esto se nota: 97 conversaciones, 2.966 mensajes, y el
// chat más largo tiene 139. Lo que se prueba acá es que deje de crecer sin techo — el criterio de la
// ficha es literal: "con 500 conversaciones sembradas, la primera carga trae una página".

let businessId: string;
let clienteCharlaLargaId: string;
let conversacionLargaId: string;

const SEMBRADAS = 500;
const MENSAJES_DEL_CHAT_LARGO = 210;

before(async () => {
  businessId = (
    await prisma.business.create({ data: { name: `B ${randomUUID()}`, email: `b-${randomUUID()}@example.com`, passwordHash: "x" } })
  ).id;

  // 500 clientes con una conversación cada uno. createMany en dos tandas: es sembrado, no un caso de uso.
  const base = Date.now();
  await prisma.customer.createMany({
    data: Array.from({ length: SEMBRADAS }, (_, i) => ({
      id: `e45-cli-${businessId}-${i}`,
      businessId,
      phoneNumber: `57300${String(base + i).slice(-9)}`,
    })),
  });
  await prisma.conversation.createMany({
    data: Array.from({ length: SEMBRADAS }, (_, i) => ({
      id: `e45-conv-${businessId}-${i}`,
      customerId: `e45-cli-${businessId}-${i}`,
      updatedAt: new Date(base - i * 1000),
    })),
  });

  // Y un chat largo de verdad, para el otro nivel de paginación.
  clienteCharlaLargaId = `e45-cli-${businessId}-0`;
  conversacionLargaId = `e45-conv-${businessId}-0`;
  await prisma.message.createMany({
    data: Array.from({ length: MENSAJES_DEL_CHAT_LARGO }, (_, i) => ({
      conversationId: conversacionLargaId,
      role: i % 2 === 0 ? ("CUSTOMER" as const) : ("ASSISTANT" as const),
      content: `mensaje ${i}`,
      createdAt: new Date(base - (MENSAJES_DEL_CHAT_LARGO - i) * 1000),
    })),
  });
});

after(async () => {
  await prisma.message.deleteMany({ where: { conversation: { customer: { businessId } } } });
  await prisma.conversation.deleteMany({ where: { customer: { businessId } } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.deleteMany({ where: { id: businessId } });
});

test("con 500 conversaciones sembradas, la primera carga trae UNA página", async () => {
  const pagina = await listCustomerThreadsForBusiness(businessId);
  assert.equal(pagina.items.length, INBOX_PAGE_SIZE);
  assert.ok(pagina.nextCursor, "tiene que decir desde dónde sigue");
  assert.equal(pagina.total, SEMBRADAS, "el total cuenta todo, aunque se manden quince");
});

test("la página siguiente sigue donde quedó la anterior, sin repetir ni saltear", async () => {
  const primera = await listCustomerThreadsForBusiness(businessId);
  const segunda = await listCustomerThreadsForBusiness(businessId, { cursor: decodeInboxCursor(primera.nextCursor!) });

  const idsPrimera = primera.items.map((c) => c.customerId);
  const idsSegunda = segunda.items.map((c) => c.customerId);
  assert.equal(segunda.items.length, INBOX_PAGE_SIZE);
  assert.equal(idsPrimera.filter((id) => idsSegunda.includes(id)).length, 0, "una fila no puede salir en dos páginas");

  // Y el orden es el de actividad, descendente, a través del corte entre páginas.
  const todos = [...primera.items, ...segunda.items].map((c) => new Date(c.updatedAt).getTime());
  assert.deepEqual(todos, [...todos].sort((a, b) => b - a));
});

// La razón de que sea por llave y no por OFFSET: mientras alguien scrollea, entran mensajes nuevos.
test("un mensaje nuevo mientras se scrollea no duplica ni esconde una fila", async () => {
  const primera = await listCustomerThreadsForBusiness(businessId);

  // El cliente más viejo de todos sube al tope: con OFFSET, la segunda página se correría una fila y
  // alguien quedaría sin mostrarse nunca.
  await prisma.conversation.update({
    where: { id: `e45-conv-${businessId}-${SEMBRADAS - 1}` },
    data: { updatedAt: new Date() },
  });

  const segunda = await listCustomerThreadsForBusiness(businessId, { cursor: decodeInboxCursor(primera.nextCursor!) });
  const repetidos = segunda.items.filter((c) => primera.items.some((p) => p.customerId === c.customerId));
  assert.equal(repetidos.length, 0);
  assert.equal(
    segunda.items.some((c) => c.customerId === `e45-cli-${businessId}-${SEMBRADAS - 1}`),
    false,
    "la fila que subió al tope no puede reaparecer en la página siguiente",
  );
});

test("un chat largo no se lee entero: trae la última página y dice que hay más", async () => {
  const hilo = await getCustomerThreadForBusiness(businessId, clienteCharlaLargaId);
  assert.ok(hilo);
  assert.ok(hilo!.messages.length < MENSAJES_DEL_CHAT_LARGO, "abrir un chat no puede leer su historia entera");
  assert.equal(hilo!.hasOlderMessages, true);
  assert.ok(hilo!.oldestMessageId);

  // Lo que se ve es el FINAL de la conversación, que es lo que la dueña necesita al abrirla.
  assert.equal(hilo!.messages[hilo!.messages.length - 1].content, `mensaje ${MENSAJES_DEL_CHAT_LARGO - 1}`);
});

test("la página anterior de mensajes sigue hacia atrás sin repetir el que ya se vio", async () => {
  const hilo = await getCustomerThreadForBusiness(businessId, clienteCharlaLargaId);
  const anteriores = await getOlderMessagesOfConversation(businessId, conversacionLargaId, hilo!.oldestMessageId!);

  assert.ok(anteriores);
  assert.ok(anteriores!.messages.length > 0);
  const yaVistos = new Set(hilo!.messages.map((m) => m.id));
  assert.equal(anteriores!.messages.filter((m) => yaVistos.has(m.id)).length, 0);

  // Y vienen en orden, del más viejo al más nuevo, pegando justo antes de lo que ya estaba.
  const tiempos = anteriores!.messages.map((m) => new Date(m.createdAt).getTime());
  assert.deepEqual(tiempos, [...tiempos].sort((a, b) => a - b));
});

test("un ancla que ya no existe devuelve vacío, no la primera página", async () => {
  // Si devolviera "lo más nuevo", el panel duplicaría en pantalla lo que ya está mostrando.
  const resultado = await getOlderMessagesOfConversation(businessId, conversacionLargaId, "un-mensaje-que-no-existe");
  assert.deepEqual(resultado, { messages: [], hasOlderMessages: false, oldestMessageId: null });
});

test("no se leen los mensajes de una conversación de otro negocio", async () => {
  const otro = await prisma.business.create({
    data: { name: `O ${randomUUID()}`, email: `o-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  try {
    const resultado = await getOlderMessagesOfConversation(otro.id, conversacionLargaId, "cualquiera");
    assert.equal(resultado, null);
  } finally {
    await prisma.business.deleteMany({ where: { id: otro.id } });
  }
});
