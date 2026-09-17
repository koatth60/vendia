import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import {
  enqueuePendingBurst,
  claimPendingBurst,
  drainDuePendingBursts,
  flushPendingBurstsNow,
  countPendingBursts,
  releaseAbandonedClaims,
  deletePendingBurst,
  BURST_WINDOW_MS,
  BURST_MAX_WAIT_MS,
  CLAIM_STALE_MS,
} from "./pendingBursts";

// E08: la rafaga de mensajes deja de vivir en la memoria del proceso. Lo que estas pruebas cubren es
// exactamente lo que la ficha pide: tres mensajes en dos segundos producen UNA sola generacion de
// respuesta, y siguen produciendola despues de un reinicio en el medio -- que es lo que antes se
// perdia entero, porque el reloj de la rafaga era un setTimeout adentro del proceso que murio.

let businessId: string;
let customerId: string;
let conversationId: string;

before(async () => {
  const business = await prisma.business.create({
    data: { name: `Rafaga ${randomUUID()}`, email: `rafaga-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  businessId = business.id;
  const customer = await prisma.customer.create({ data: { businessId, phoneNumber: `573008${Date.now()}` } });
  customerId = customer.id;
  const conversation = await prisma.conversation.create({ data: { customerId } });
  conversationId = conversation.id;
});

beforeEach(async () => {
  await prisma.pendingBurst.deleteMany({ where: { conversationId } });
});

after(async () => {
  await prisma.pendingBurst.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
});

function mensaje(texto: string) {
  return {
    conversationId,
    businessId,
    customerId,
    customerPhone: "573001112233",
    rawText: texto,
    customerSentAt: new Date(),
  };
}

async function vencerLaRafaga(): Promise<void> {
  await prisma.pendingBurst.updateMany({ where: { conversationId }, data: { flushAt: new Date(Date.now() - 1000) } });
}

test("tres mensajes seguidos quedan en UNA sola rafaga, con un solo flushAt", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  await enqueuePendingBurst(mensaje("tienen relojes"));
  await enqueuePendingBurst(mensaje("negros"));

  const filas = await prisma.pendingBurst.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
  assert.equal(filas.length, 3);
  // Un flushAt por rafaga, no uno por mensaje: si cada fila llevara el suyo, la rafaga se drenaria de
  // a pedazos y el cliente recibiria las tres respuestas que agrupar vino a evitar.
  const distintos = new Set(filas.map((fila) => fila.flushAt.getTime()));
  assert.equal(distintos.size, 1, "la rafaga quedo con mas de un flushAt");
  // Y la ventana se corre con el ultimo mensaje, que es lo que significa "ventana de silencio".
  assert.ok(filas[0].flushAt.getTime() > filas[0].createdAt.getTime() + BURST_WINDOW_MS - 1500);
});

test("un cliente que escribe sin parar no espera indefinidamente: manda el tope desde el primer mensaje", async () => {
  await enqueuePendingBurst(mensaje("uno"));
  // Se envejece el primer mensaje mas alla del tope, como si el cliente llevara rato escribiendo sin
  // dejar nunca pasar la ventana entera.
  const viejo = new Date(Date.now() - BURST_MAX_WAIT_MS - 5000);
  await prisma.pendingBurst.updateMany({ where: { conversationId }, data: { createdAt: viejo } });

  await enqueuePendingBurst(mensaje("dos"));

  const filas = await prisma.pendingBurst.findMany({ where: { conversationId } });
  for (const fila of filas) {
    assert.ok(
      fila.flushAt.getTime() <= viejo.getTime() + BURST_MAX_WAIT_MS,
      "la ventana se siguio corriendo por encima del tope: el cliente se quedaria esperando"
    );
  }
});

test("la rafaga no se drena antes de que venza su ventana", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  const turnos: string[] = [];
  const arrancados = await drainDuePendingBursts(async (id) => {
    turnos.push(id);
  });
  await Promise.all(arrancados);
  assert.deepEqual(turnos, []);
  assert.equal(await countPendingBursts(), 1);
});

test("tres mensajes en dos segundos producen UNA sola generacion de respuesta", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  await enqueuePendingBurst(mensaje("tienen relojes"));
  await enqueuePendingBurst(mensaje("negros"));
  await vencerLaRafaga();

  const generaciones: string[][] = [];
  const arrancados = await drainDuePendingBursts(async (_id, filas) => {
    generaciones.push(filas.map((fila) => fila.rawText));
  });
  await Promise.all(arrancados);

  assert.equal(generaciones.length, 1, "se genero mas de una respuesta para la misma rafaga");
  assert.deepEqual(generaciones[0], ["hola", "tienen relojes", "negros"]);
  // Drenada es borrada: si las filas quedaran, la proxima pasada volveria a contestar lo mismo.
  assert.equal(await countPendingBursts(), 0);
});

test("con un reinicio en el medio, la rafaga sobrevive y se sigue contestando UNA sola vez", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  await enqueuePendingBurst(mensaje("tienen relojes"));
  await enqueuePendingBurst(mensaje("negros"));

  // EL REINICIO. Antes de E08 esto era todo lo que hacia falta para perder la rafaga entera: el
  // proceso que tenia el setTimeout se muere y nadie mas sabe que esos tres mensajes existen. Aca no
  // se simula nada raro -- simplemente nadie drena, y despues drena otro proceso.
  await flushPendingBurstsNow();

  const generaciones: string[][] = [];
  const arrancados = await drainDuePendingBursts(async (_id, filas) => {
    generaciones.push(filas.map((fila) => fila.rawText));
  });
  await Promise.all(arrancados);

  assert.equal(generaciones.length, 1);
  assert.deepEqual(generaciones[0], ["hola", "tienen relojes", "negros"], "se perdio parte de la rafaga en el reinicio");
});

test("dos procesos drenando a la vez: uno reclama la rafaga y el otro no ve nada", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  await enqueuePendingBurst(mensaje("tienen relojes"));
  await vencerLaRafaga();

  // Las dos llamadas salen juntas, como dos procesos que despiertan su job en el mismo segundo.
  const [primero, segundo] = await Promise.all([claimPendingBurst(conversationId), claimPendingBurst(conversationId)]);

  const conRafaga = [primero, segundo].filter((filas) => filas.length > 0);
  assert.equal(conRafaga.length, 1, "los dos procesos se llevaron una rafaga: el cliente recibiria dos respuestas");
  assert.equal(conRafaga[0].length, 2, "el que gano se llevo la rafaga a medias");

  await deletePendingBurst(conRafaga[0]);
});

test("una rafaga reclamada por un proceso que se murio se suelta sola y se vuelve a contestar", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  await vencerLaRafaga();
  const reclamadas = await claimPendingBurst(conversationId);
  assert.equal(reclamadas.length, 1);

  // Nadie la contesto ni la borro: el proceso se murio con el reclamo puesto. Mientras el reclamo sea
  // reciente, nadie la toca -- no hay forma de saber si el otro proceso sigue contestandola.
  const sinSoltar = await drainDuePendingBursts(async () => {});
  await Promise.all(sinSoltar);
  assert.equal(await prisma.pendingBurst.count({ where: { conversationId } }), 1);

  // Envejecido el reclamo, se suelta y se vuelve a tomar.
  await prisma.pendingBurst.updateMany({
    where: { conversationId },
    data: { claimedAt: new Date(Date.now() - CLAIM_STALE_MS - 1000) },
  });
  const soltadas = await releaseAbandonedClaims();
  assert.ok(soltadas >= 1);

  const generaciones: string[] = [];
  const arrancados = await drainDuePendingBursts(async (id) => {
    generaciones.push(id);
  });
  await Promise.all(arrancados);
  assert.deepEqual(generaciones, [conversationId]);
});

test("un turno que revienta borra igual su rafaga, en vez de reintentarla sola", async () => {
  await enqueuePendingBurst(mensaje("hola"));
  await vencerLaRafaga();

  const errores: string[] = [];
  const arrancados = await drainDuePendingBursts(
    async () => {
      throw new Error("DeepSeek caido");
    },
    (id) => errores.push(id)
  );
  await Promise.all(arrancados);

  assert.deepEqual(errores, [conversationId], "el error del turno no se reporto");
  // Reintentar solo despues de un envio a medias es como se le manda dos veces lo mismo a un cliente:
  // la rafaga se borra y el fallo queda registrado, igual que antes de E08.
  assert.equal(await countPendingBursts(), 0);
});

test("dos conversaciones distintas se contestan en paralelo, no una detras de la otra", async () => {
  const otraConversacion = await prisma.conversation.create({ data: { customerId } });
  try {
    await enqueuePendingBurst(mensaje("lenta"));
    await enqueuePendingBurst({ ...mensaje("rapida"), conversationId: otraConversacion.id });
    await prisma.pendingBurst.updateMany({
      where: { conversationId: { in: [conversationId, otraConversacion.id] } },
      data: { flushAt: new Date(Date.now() - 1000) },
    });

    const orden: string[] = [];
    let soltarLaLenta: () => void = () => {};
    const laLentaEmpezo = new Promise<void>((resolve) => {
      const arrancados = drainDuePendingBursts(async (id) => {
        if (id === conversationId) {
          orden.push("lenta-empieza");
          resolve();
          await new Promise<void>((fin) => {
            soltarLaLenta = fin;
          });
          orden.push("lenta-termina");
        } else {
          orden.push("rapida");
        }
      });
      void arrancados.then((turnos) => Promise.all(turnos)).catch(() => {});
    });

    await laLentaEmpezo;
    // Un drenaje que esperara cada turno dejaria a la rapida detras de la lenta: un cliente esperando
    // a que termine el turno de otro negocio es exactamente lo que la version con timers no hacia.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(orden.includes("rapida"), "la segunda conversacion quedo esperando a que terminara la primera");
    assert.ok(!orden.includes("lenta-termina"));
    soltarLaLenta();
  } finally {
    await prisma.pendingBurst.deleteMany({ where: { conversationId: otraConversacion.id } });
    await prisma.conversation.delete({ where: { id: otraConversacion.id } });
  }
});
