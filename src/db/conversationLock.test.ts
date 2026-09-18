import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { env } from "../config/env";
import { createConversationLocker } from "./conversationLock";

// E07: la garantia que E07 promete es "dos procesos contra la misma conversacion producen
// exactamente una respuesta". Un locker con su PROPIO pool es, para Postgres, exactamente lo mismo
// que otro proceso: otra sesion, otro `Map` en memoria, ningun estado compartido salvo la base. Por
// eso las pruebas de abajo crean dos lockers en vez de llamar dos veces al mismo: llamar dos veces
// al mismo solo probaria la cadena de promesas que ya existia antes de E07.

const procesoA = createConversationLocker();
const procesoB = createConversationLocker();

after(async () => {
  await Promise.all([procesoA.close(), procesoB.close()]);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Un id distinto por prueba: el lock es global a la base y las pruebas no se pisan entre si.
function idDeConversacion(nombre: string): string {
  return `e07-${nombre}-${process.pid}-${Date.now()}`;
}

test("dos procesos distintos no pueden estar dentro de la misma conversacion a la vez", async () => {
  const conversationId = idDeConversacion("misma");
  const orden: string[] = [];
  let adentroDeA = false;
  let seSolaparon = false;

  let soltarA: () => void = () => {};
  const aTomoElLock = new Promise<void>((resolve) => {
    const primero = procesoA.run(conversationId, async () => {
      adentroDeA = true;
      orden.push("A-entra");
      resolve();
      await new Promise<void>((fin) => {
        soltarA = fin;
      });
      orden.push("A-sale");
      adentroDeA = false;
    });
    void primero.catch(() => {});
  });

  await aTomoElLock;

  const segundo = procesoB.run(conversationId, async () => {
    if (adentroDeA) seSolaparon = true;
    orden.push("B-entra");
    orden.push("B-sale");
  });

  // Tiempo de sobra para que B entre si el lock no estuviera funcionando.
  await delay(150);
  assert.deepEqual(orden, ["A-entra"], "B entro en la conversacion mientras A la tenia tomada");

  soltarA();
  await segundo;

  assert.equal(seSolaparon, false);
  assert.deepEqual(orden, ["A-entra", "A-sale", "B-entra", "B-sale"]);
});

test("dos procesos en conversaciones distintas corren en paralelo", async () => {
  const conversacionA = idDeConversacion("paralelo-a");
  const conversacionB = idDeConversacion("paralelo-b");
  let adentroDeA = false;
  let bEntroMientrasA = false;

  const primero = procesoA.run(conversacionA, async () => {
    adentroDeA = true;
    await delay(120);
    adentroDeA = false;
  });
  // Un respiro para que A ya este adentro cuando B lo intente.
  await delay(30);
  const segundo = procesoB.run(conversacionB, async () => {
    bEntroMientrasA = adentroDeA;
  });

  await Promise.all([primero, segundo]);
  // Un lock con el alcance mal puesto (por negocio, o global) convertiria el bot en una fila unica:
  // cada cliente esperando el turno de todos los demas.
  assert.equal(bEntroMientrasA, true, "las conversaciones distintas quedaron serializadas entre si");
});

test("una seccion que revienta suelta la conversacion y propaga el error", async () => {
  const conversationId = idDeConversacion("revienta");

  await assert.rejects(
    procesoA.run(conversationId, async () => {
      throw new Error("fallo simulado de DeepSeek/envio");
    }),
    /fallo simulado/
  );

  // El otro proceso tiene que poder entrar inmediatamente despues. Si el lock hubiera quedado
  // puesto, esto se colgaria hasta el lock_timeout.
  let entro = false;
  await procesoB.run(conversationId, async () => {
    entro = true;
  });
  assert.equal(entro, true);
});

test("si el proceso que tenia la conversacion muere, el lock se suelta solo", async () => {
  const conversationId = idDeConversacion("muere");

  // Una conexion suelta, tomando el lock igual que lo toma el locker. Cerrarla de golpe es lo que le
  // pasa a un proceso al que matan: nadie corre el unlock.
  const procesoQueMuere = new Client({ connectionString: env.databaseUrl });
  await procesoQueMuere.connect();
  await procesoQueMuere.query("SELECT pg_advisory_lock($1, hashtext($2))", [0x4f4e4958, conversationId]);
  await procesoQueMuere.end();

  let entro = false;
  await procesoA.run(conversationId, async () => {
    entro = true;
  });
  // Esta es la propiedad por la que no hace falta ni Redis ni un lock con vencimiento: Postgres suelta
  // los locks de sesion cuando la sesion se cae, sin que nadie tenga que limpiarlos.
  assert.equal(entro, true);
});
