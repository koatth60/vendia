import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { conArriendo, arriendosSalteados, reiniciarContadoresDeArriendo } from "./arriendo";

// E23 (2026-09-18). El arriendo de un job: dos procesos worker no corren la misma pasada.
//
// Lo que estas pruebas comprueban de verdad es el criterio de aceptacion de la ficha: "dos worker
// levantados, un cliente recibe exactamente una respuesta y un dueno exactamente una confirmacion". La
// confirmacion al dueno sale de saleConfirmationChaser, que es un job -- asi que "exactamente una"
// depende de que solo uno de los dos procesos corra la pasada.

const nombres: string[] = [];

function nombreDeJob(): string {
  const nombre = `prueba-${randomUUID()}`;
  nombres.push(nombre);
  return nombre;
}

async function limpiar() {
  if (nombres.length > 0) await prisma.jobLease.deleteMany({ where: { name: { in: nombres } } });
  nombres.length = 0;
  reiniciarContadoresDeArriendo();
}

beforeEach(limpiar);
afterEach(limpiar);

test("dos pasadas a la vez: corre una sola, y la otra se saltea", async () => {
  const nombre = nombreDeJob();
  let corriendo = 0;
  let corridas = 0;

  const tarea = conArriendo(nombre, 60_000, async () => {
    corriendo += 1;
    assert.equal(corriendo, 1, "dos pasadas del mismo job a la vez es el mensaje duplicado que esto viene a impedir");
    await new Promise((resolve) => setTimeout(resolve, 50));
    corridas += 1;
    corriendo -= 1;
  });

  await Promise.all([tarea(), tarea()]);

  assert.equal(corridas, 1);
  assert.equal(arriendosSalteados().find((a) => a.nombre === nombre)?.salteadas, 1);
});

test("cuando termina, el arriendo queda libre para la pasada siguiente", async () => {
  const nombre = nombreDeJob();
  let corridas = 0;
  const tarea = conArriendo(nombre, 60_000, async () => {
    corridas += 1;
  });

  await tarea();
  await tarea();

  assert.equal(corridas, 2, "un job que corre cada segundo no puede quedar bloqueado por su propia pasada anterior");
  const fila = await prisma.jobLease.findUniqueOrThrow({ where: { name: nombre } });
  assert.equal(fila.lockedUntil, null);
  assert.ok(fila.lastRunAt, "la pasada que termina bien deja fecha: un job que no aparece aca se esta muriendo a la mitad");
});

test("una pasada que revienta suelta el arriendo igual", async () => {
  const nombre = nombreDeJob();
  const tarea = conArriendo(nombre, 60_000, async () => {
    throw new Error("se cayo a la mitad");
  });

  await assert.rejects(tarea(), /se cayo a la mitad/);

  const fila = await prisma.jobLease.findUniqueOrThrow({ where: { name: nombre } });
  assert.equal(fila.lockedUntil, null, "si el fallo dejara el arriendo tomado, el job quedaria muerto hasta que venza");
});

test("el arriendo de un proceso muerto vence y otro lo toma", async () => {
  const nombre = nombreDeJob();
  // El estado exacto en el que un SIGKILL deja la fila: tomada por alguien que ya no existe.
  await prisma.jobLease.create({
    data: { name: nombre, lockedUntil: new Date(Date.now() - 1000), holder: "un-proceso-muerto:999" },
  });

  let corridas = 0;
  await conArriendo(nombre, 60_000, async () => {
    corridas += 1;
  })();

  assert.equal(corridas, 1, "sin vencimiento, un proceso muerto dejaria el job parado para siempre");
});

test("mientras uno lo tiene tomado, el otro no entra aunque la tarea sea instantanea", async () => {
  const nombre = nombreDeJob();
  await prisma.jobLease.create({
    data: { name: nombre, lockedUntil: new Date(Date.now() + 60_000), holder: "otro-worker:123" },
  });

  let corridas = 0;
  const resultado = await conArriendo(nombre, 60_000, async () => {
    corridas += 1;
    return "corrio";
  })();

  assert.equal(corridas, 0);
  assert.equal(resultado, undefined, "quien se saltea devuelve undefined: el llamador tiene que poder distinguirlo");
});
