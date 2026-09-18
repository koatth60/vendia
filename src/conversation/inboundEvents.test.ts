import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { collectWebhookBatch } from "../routes/whatsapp";
import {
  eventosDelLote,
  guardarEventosEntrantes,
  reclamarEventos,
  marcarProcesado,
  anotarFallo,
  eventosEnCartaMuerta,
  claveDeDeduplicacion,
  MAX_INTENTOS,
  RESERVA_MS,
} from "./inboundEvents";

// E20 / E21 (2026-09-18). LA COLA DE ENTRADA.
//
// El criterio de aceptacion de E20 es textual: "reenviar el mismo wamid dos veces no dispara una segunda
// descarga de medios". El de E21: "matar el proceso con SIGKILL en medio de un turno; al reiniciar, el
// turno se reprocesa". Lo segundo no se puede matar de verdad adentro de una prueba, pero SI se puede
// reproducir el estado exacto en el que queda: un evento reclamado, sin procesar, con la reserva vencida.

/** El cuerpo tal como lo manda Meta. Escrito a mano igual que en whatsapp.batch.test.ts. */
function cuerpoConMensaje(wamid: string, phoneNumberId = "pni-1") {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: wamid, from: "573001112233", type: "image", image: { id: "media-1" } }],
            },
          },
        ],
      },
    ],
  };
}

// Se limpia ANTES Y DESPUES. Solo antes no alcanza: los eventos del ultimo caso quedan en la base para
// siempre, y como son viejos y sin procesar, `/health` los ve -- con razon -- como la cola parada. Paso
// exactamente eso: la prueba de E24 "en condiciones normales el estado es ok" fallo por basura que habia
// dejado ESTE archivo.
async function limpiar() {
  await prisma.inboundEvent.deleteMany({ where: { wamid: { startsWith: "test-" } } });
}

beforeEach(limpiar);
afterEach(limpiar);

test("E20: el mismo wamid dos veces entra UNA sola vez, y la deduplicacion ocurre antes de gastar", async () => {
  const wamid = `test-${randomUUID()}`;
  const cuerpo = cuerpoConMensaje(wamid);

  const primera = await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpo)));
  assert.equal(primera, 1);

  // Meta reintregando el MISMO lote. Antes, esto volvia a pagar descarga de medios, subida a S3, vision
  // y transcripcion -- y contaba un chat facturable de mas -- porque la deduplicacion por wamid recien
  // pasaba en recordMessage, al final de todo eso.
  const segunda = await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpo)));
  assert.equal(segunda, 0, "el reintento no inserta nada, asi que no hay nada que procesar ni que pagar");

  assert.equal(await prisma.inboundEvent.count({ where: { wamid } }), 1);
});

test("E20: los tres estados del mismo mensaje entran los tres, no solo el primero", async () => {
  const wamid = `test-${randomUUID()}`;
  const cuerpoEstado = (estado: string) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pni-1" },
              statuses: [{ id: wamid, status: estado, recipient_id: "573001112233" }],
            },
          },
        ],
      },
    ],
  });

  for (const estado of ["sent", "delivered", "read"]) {
    await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoEstado(estado))));
  }

  // Con el wamid pelado como clave unica solo habria entrado "sent", y el panel diria "enviado" de algo
  // que la clienta ya leyo. Por eso la clave lleva el estado adentro.
  assert.equal(await prisma.inboundEvent.count({ where: { wamid, kind: "STATUS" } }), 3);
  assert.equal(claveDeDeduplicacion("STATUS", wamid, "read"), `st:${wamid}:read`);
  assert.notEqual(claveDeDeduplicacion("STATUS", wamid, "sent"), claveDeDeduplicacion("STATUS", wamid, "read"));
});

test("E20: un elemento sin id no ensucia la cola", async () => {
  const cuerpo = {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "pni-1" }, messages: [{ type: "text" }] } }] }],
  };
  assert.deepEqual(eventosDelLote(collectWebhookBatch(cuerpo)), []);
});

test("E21: reclamar toma la fila, la reserva, y un segundo reclamo no la ve", async () => {
  const wamid = `test-${randomUUID()}`;
  await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoConMensaje(wamid))));

  const primeros = await reclamarEventos(10);
  const mio = primeros.find((e) => e.wamid === wamid);
  assert.ok(mio, "el evento recien encolado tiene que estar pendiente");
  assert.equal(mio.attempts, 1, "reclamar cuenta el intento: si el proceso muere ahora, ya se sabe que se intento");

  // Esto es lo que impide que dos worker manden dos respuestas a la misma clienta. Sin la reserva, el
  // segundo proceso tomaria la misma fila y el bot contestaria dos veces.
  const segundos = await reclamarEventos(10);
  assert.equal(segundos.some((e) => e.wamid === wamid), false, "mientras esta reservado, nadie mas lo toma");
});

test("E21: el turno que quedo a medias por un proceso muerto se reprocesa al vencer la reserva", async () => {
  const wamid = `test-${randomUUID()}`;
  await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoConMensaje(wamid))));
  await reclamarEventos(10);

  // Este es el estado en el que un SIGKILL deja la fila: reclamada, sin processedAt, con la reserva
  // corriendo. Nadie la va a marcar procesada porque el proceso que la tomo ya no existe.
  const aMedias = await prisma.inboundEvent.findFirstOrThrow({ where: { wamid } });
  assert.equal(aMedias.processedAt, null);
  assert.ok(aMedias.lockedUntil);

  // Se adelanta el reloj venciendo la reserva a mano, que es lo mismo que esperar los cinco minutos.
  await prisma.inboundEvent.update({
    where: { id: aMedias.id },
    data: { lockedUntil: new Date(Date.now() - RESERVA_MS) },
  });

  const reintento = await reclamarEventos(10);
  assert.ok(
    reintento.some((e) => e.wamid === wamid),
    "al vencer la reserva el evento vuelve a estar disponible: el turno no se perdio",
  );
});

test("E21: un evento que falla vuelve con mas espera, y a los cinco intentos queda en carta muerta con su payload", async () => {
  const wamid = `test-${randomUUID()}`;
  await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoConMensaje(wamid))));
  const fila = await prisma.inboundEvent.findFirstOrThrow({ where: { wamid } });

  const antes = Date.now();
  const resultado = await anotarFallo(fila.id, 1, new Error("S3 caido"));
  assert.equal(resultado, "REINTENTA");
  const tras1 = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: fila.id } });
  assert.ok(tras1.nextAttemptAt.getTime() > antes, "el reintento se corre para adelante, no es inmediato");
  assert.equal(tras1.lockedUntil, null, "soltar la reserva al fallar: si no, se queda trabado hasta que venza");
  assert.equal(tras1.failedAt, null);

  const muerto = await anotarFallo(fila.id, MAX_INTENTOS, new Error("S3 sigue caido"));
  assert.equal(muerto, "MUERTO");

  const tras5 = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: fila.id } });
  assert.ok(tras5.failedAt);
  assert.match(tras5.lastError ?? "", /S3 sigue caido/);
  // La carta muerta NO borra la fila. Un evento que murio por un defecto nuestro se puede reprocesar
  // cuando se arregle -- esa es la diferencia entre un mensaje perdido y un mensaje pendiente.
  assert.ok(tras5.payload, "el payload entero queda para poder reprocesarlo");

  const muertos = await eventosEnCartaMuerta("pni-1");
  assert.ok(muertos.some((m) => m.wamid === wamid), "visible en vez de perdido en silencio");
  // Acotado al numero del negocio: sin esto, la ruta del panel le mostraria a una duena los mensajes
  // fallidos de otro inquilino.
  assert.equal((await eventosEnCartaMuerta("pni-de-otro")).some((m) => m.wamid === wamid), false);
  assert.deepEqual(await eventosEnCartaMuerta(""), [], "sin numero conectado no se devuelve 'todos'");

  // Y no vuelve a salir en el reclamo: uno muerto reintentandose para siempre seria un bucle.
  assert.equal((await reclamarEventos(50)).some((e) => e.wamid === wamid), false);
});

test("E21: marcar procesado lo saca de la cola para siempre", async () => {
  const wamid = `test-${randomUUID()}`;
  await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoConMensaje(wamid))));
  const fila = await prisma.inboundEvent.findFirstOrThrow({ where: { wamid } });

  await marcarProcesado(fila.id);

  const tras = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: fila.id } });
  assert.ok(tras.processedAt);
  assert.equal(tras.lockedUntil, null);
  assert.equal((await reclamarEventos(50)).some((e) => e.wamid === wamid), false);
});

test("E21: el orden de la cola es el orden en que escribio la clienta", async () => {
  const uno = `test-${randomUUID()}`;
  const dos = `test-${randomUUID()}`;
  await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoConMensaje(uno))));
  // receivedAt con un milisegundo de diferencia: en la vida real son dos webhooks seguidos.
  await prisma.inboundEvent.updateMany({ where: { wamid: uno }, data: { receivedAt: new Date(Date.now() - 5000) } });
  await guardarEventosEntrantes(eventosDelLote(collectWebhookBatch(cuerpoConMensaje(dos))));

  const reclamados = (await reclamarEventos(50)).filter((e) => e.wamid === uno || e.wamid === dos);
  assert.deepEqual(
    reclamados.map((e) => e.wamid),
    [uno, dos],
    "'quiero el reloj' antes que 'el azul', no al reves: si se invierten, el pedido queda armado mal",
  );
});
