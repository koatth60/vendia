import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { hashPassword } from "../auth/service";
import {
  buscarTurnosPerdidos,
  runReconciliacionJob,
  MINUTOS_SIN_RESPUESTA,
  HORAS_PARA_CONTESTAR,
} from "./reconciliacion";

// E22 (2026-09-18). El criterio de aceptacion de la etapa: "una conversacion con un mensaje sin respuesta
// aparece en la metrica y se reencola".
//
// Cada exclusion tiene su propia prueba a proposito. No son casos borde: cada una evita un mensaje de mas
// a una clienta real, y la forma de romper esta etapa es relajar una sin darse cuenta.

let businessId: string;
let customerId: string;
let conversationId: string;

const haceMinutos = (m: number) => new Date(Date.now() - m * 60 * 1000);

async function mensajeDeCliente(cuandoMinutos: number, opciones: { wamid?: string } = {}) {
  return prisma.message.create({
    data: {
      conversationId,
      role: "CUSTOMER",
      content: "hola, sigo esperando",
      createdAt: haceMinutos(cuandoMinutos),
      whatsappMessageId: opciones.wamid ?? `wamid-${randomUUID()}`,
    },
  });
}

async function mios() {
  return buscarTurnosPerdidos(200, businessId);
}

beforeEach(async () => {
  const negocio = await prisma.business.create({
    data: {
      name: "Recon",
      email: `recon-${randomUUID()}@ejemplo.com`,
      passwordHash: await hashPassword("x"),
      active: true,
      whatsappPhoneNumberId: `pni-${randomUUID()}`,
    },
  });
  businessId = negocio.id;
  const cliente = await prisma.customer.create({ data: { businessId, phoneNumber: `57${Date.now()}` } });
  customerId = cliente.id;
  const conversacion = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversacion.id;
});

afterEach(async () => {
  // LAS RAFAGAS SE BORRAN EXPLICITAMENTE, y no alcanza con confiar en el borrado en cascada del negocio.
  //
  // `drainDuePendingBursts` no filtra por negocio: drena TODAS las rafagas vencidas de la base. O sea
  // que una rafaga que este archivo deje colgada rompe la prueba de OTRO archivo ("la rafaga no se drena
  // antes de que venza su ventana"), y lo hace de la peor forma: la suite completa falla y el archivo
  // solo pasa. Paso exactamente eso al escribir esta etapa.
  //
  // El borrado del negocio ademas estaba silenciado con .catch(): si fallaba, no limpiaba nada y nadie
  // se enteraba. Ahora la limpieza no depende de que la cascada haga lo que uno cree que hace.
  await prisma.pendingBurst.deleteMany({ where: { conversationId } });
  await prisma.business.delete({ where: { id: businessId } }).catch(() => undefined);
});

test("E22: la ultima palabra es de la clienta y lleva rato: aparece, y se reencola", async () => {
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5);

  const encontrados = await mios();
  assert.equal(encontrados.length, 1, "esto es lo que hoy no detecta nada: una AUSENCIA de respuesta");
  assert.equal(encontrados[0].accion, "REENCOLADO");

  await runReconciliacionJob(businessId);

  const rafaga = await prisma.pendingBurst.findFirst({ where: { conversationId } });
  assert.ok(rafaga, "el turno se pide de nuevo: la rafaga es lo que produce la respuesta");
  assert.match(rafaga.rawText, /sigo esperando/);

  // Y no lo vuelve a tomar en la pasada siguiente, porque ahora SI hay una rafaga encolada. Sin esta
  // exclusion, cada cinco minutos se encolaria otra y la clienta recibiria la respuesta varias veces.
  assert.deepEqual(await mios(), []);
});

test("E22: recien llegado no se toca", async () => {
  await mensajeDeCliente(1);
  assert.deepEqual(await mios(), [], "un mensaje de hace un minuto todavia esta en camino, no perdido");
});

test("E22: si el bot ya contesto, no hay nada perdido", async () => {
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5);
  await prisma.message.create({
    data: { conversationId, role: "ASSISTANT", content: "te cuento", createdAt: haceMinutos(MINUTOS_SIN_RESPUESTA + 4) },
  });
  assert.deepEqual(await mios(), []);
});

test("E22: tres mensajes de la clienta y UNA respuesta al final estan bien atendidos", async () => {
  await mensajeDeCliente(40);
  await mensajeDeCliente(39);
  await mensajeDeCliente(38);
  await prisma.message.create({
    data: { conversationId, role: "ASSISTANT", content: "ahi va todo", createdAt: haceMinutos(37) },
  });

  // Lo que importa es que la ULTIMA palabra no sea de ella. Contar "mensajes sin respuesta despues"
  // marcaria estos tres y el bot contestaria de nuevo algo que ya contesto.
  assert.deepEqual(await mios(), []);
});

test("E22: con la duena atendiendo a mano, el bot no se mete", async () => {
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5);
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanControl: true } });
  assert.deepEqual(await mios(), [], "humanControl es una persona escribiendo: meter al bot ahi es peor que el silencio");
});

test("E22: un negocio apagado no manda nada", async () => {
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5);
  await prisma.business.update({ where: { id: businessId }, data: { active: false } });
  assert.deepEqual(await mios(), []);
});

test("E22: si el turno ya esta encolado como rafaga, no se encola dos veces", async () => {
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5);
  await prisma.pendingBurst.create({
    data: {
      conversationId,
      businessId,
      customerId,
      customerPhone: "573001112233",
      rawText: "sigo esperando",
      customerSentAt: haceMinutos(MINUTOS_SIN_RESPUESTA + 5),
      flushAt: new Date(Date.now() + 5000),
    },
  });
  assert.deepEqual(await mios(), []);
});

test("E22: si la cola de entrada todavia lo esta reintentando, se la deja trabajar", async () => {
  const wamid = `wamid-${randomUUID()}`;
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5, { wamid });
  await prisma.inboundEvent.create({
    data: { dedupeKey: `msg:${wamid}`, kind: "MESSAGE", wamid, phoneNumberId: "pni-x", payload: {} },
  });

  assert.deepEqual(await mios(), [], "el evento pendiente de ESE mensaje todavia tiene reintentos por delante");

  // Y la exclusion es por wamid, no por negocio: un evento pendiente de OTRA conversacion no puede
  // apagar la reconciliacion de esta. Con la version por negocio, un negocio con trafico no se habria
  // reconciliado nunca.
  await prisma.inboundEvent.updateMany({ where: { wamid }, data: { wamid: `otro-${randomUUID()}` } });
  assert.equal((await mios()).length, 1);
});

test("E22: un evento que ya se proceso no protege a nadie", async () => {
  const wamid = `wamid-${randomUUID()}`;
  await mensajeDeCliente(MINUTOS_SIN_RESPUESTA + 5, { wamid });
  await prisma.inboundEvent.create({
    data: {
      dedupeKey: `msg:${wamid}`,
      kind: "MESSAGE",
      wamid,
      payload: {},
      processedAt: new Date(),
    },
  });
  // Procesado y sin respuesta es EXACTAMENTE el caso que esta etapa busca: la cola hizo su trabajo y
  // el turno igual no salio.
  assert.equal((await mios()).length, 1);
});

test("E22: lo demasiado viejo se anota pero NO se contesta", async () => {
  await mensajeDeCliente(HORAS_PARA_CONTESTAR * 60 + 30);

  const encontrados = await mios();
  assert.equal(encontrados.length, 1, "aparece en la metrica: es justo lo que hay que poder ver");
  assert.equal(encontrados[0].accion, "SOLO_ANOTADO");

  const resumen = await runReconciliacionJob(businessId);
  assert.ok(resumen.soloAnotados >= 1);

  // Contestarle a alguien que escribio anoche como si acabara de escribir es peor que no contestarle:
  // la conversacion ya siguio por otro lado y el bot aparece hablando solo.
  assert.equal(await prisma.pendingBurst.count({ where: { conversationId } }), 0);
});
