import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrderedShutdown, type OrderedShutdownDeps } from "./shutdown";

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function baseDeps(overrides: Partial<OrderedShutdownDeps> = {}): OrderedShutdownDeps {
  return {
    closeServer: () => {},
    getActiveTurnCount: () => 0,
    getPendingBurstCount: () => 0,
    flushPendingBursts: async () => {},
    sleep: realSleep,
    now: () => Date.now(),
    log: () => {},
    logError: () => {},
    exit: () => {},
    graceMs: 2000,
    pollMs: 5,
    ...overrides,
  };
}

// Criterio de aceptacion pedido: con un mensaje en el buffer de rafaga, disparar el apagado y
// verificar que ese mensaje SI se procesa (no se descarta, no se pierde en silencio).
test("un mensaje esperando su ventana de rafaga se procesa durante el apagado, no se pierde", async () => {
  let activeTurns = 0;
  let flushCalled = false;
  let processed = false;

  const deps = baseDeps({
    getPendingBurstCount: () => (flushCalled ? 0 : 1),
    flushPendingBursts: async () => {
      flushCalled = true;
      // Simula lo que hace withConversationLock de verdad: activeTurnCount sube de inmediato, de
      // forma sincronica, apenas arranca el turno diferido.
      activeTurns++;
      await realSleep(20); // simula generateReply + el envio
      processed = true;
      activeTurns--;
    },
    getActiveTurnCount: () => activeTurns,
  });

  const shutdown = createOrderedShutdown(deps);
  await shutdown("SIGTERM");

  assert.equal(flushCalled, true, "el apagado tiene que forzar la descarga del buffer de rafaga");
  assert.equal(processed, true, "el mensaje en el buffer tiene que haberse procesado, no descartado en silencio");
  assert.equal(activeTurns, 0, "el apagado tiene que esperar a que el turno diferido termine antes de salir");
});

test("el apagado cierra el servidor y vacia la rafaga ANTES de esperar los turnos en vuelo", async () => {
  const order: string[] = [];
  const deps = baseDeps({
    closeServer: () => order.push("closeServer"),
    getPendingBurstCount: () => {
      order.push("getPendingBurstCount");
      return 1;
    },
    flushPendingBursts: async () => {
      order.push("flushPendingBursts");
    },
    getActiveTurnCount: () => {
      order.push("getActiveTurnCount");
      return 0;
    },
  });

  await createOrderedShutdown(deps)("SIGTERM");

  assert.equal(order[0], "closeServer");
  assert.ok(order.indexOf("flushPendingBursts") < order.indexOf("getActiveTurnCount"), "la rafaga se vacia antes de esperar los locks");
});

test("sin nada pendiente, no anuncia ninguna descarga forzada", async () => {
  const logs: string[] = [];
  const deps = baseDeps({ log: (msg) => logs.push(msg) });

  await createOrderedShutdown(deps)("SIGTERM");

  assert.ok(!logs.some((line) => line.includes("Forzando la descarga")));
});

test("con rafagas pendientes, anuncia cuantas antes de vaciarlas", async () => {
  const logs: string[] = [];
  const deps = baseDeps({
    getPendingBurstCount: () => 3,
    log: (msg) => logs.push(msg),
  });

  await createOrderedShutdown(deps)("SIGTERM");

  assert.ok(logs.some((line) => line.includes("3") && line.includes("rafaga")));
});

// Segunda mitad del pedido: si algo no alcanza a procesarse dentro del margen, tiene que quedar
// registrado explicitamente, nunca en silencio.
test("si un turno no termina dentro del tope, queda registrado explicitamente por logError", async () => {
  const errors: string[] = [];
  let exitCode: number | null = null;
  const deps = baseDeps({
    getActiveTurnCount: () => 1, // nunca baja a 0 dentro del tope
    logError: (msg) => errors.push(msg),
    exit: (code) => {
      exitCode = code;
    },
    graceMs: 30,
    pollMs: 5,
  });

  await createOrderedShutdown(deps)("SIGTERM");

  assert.equal(exitCode, 0, "el apagado igual termina, no se cuelga para siempre");
  assert.ok(
    errors.some((line) => line.includes("1") && line.includes("turno")),
    `esperaba un registro explicito del turno sin terminar, se registraron: ${JSON.stringify(errors)}`
  );
});

test("cuando todos los turnos terminan a tiempo, se registra el cierre limpio (no en silencio tampoco)", async () => {
  const logs: string[] = [];
  const deps = baseDeps({ getActiveTurnCount: () => 0, log: (msg) => logs.push(msg) });

  await createOrderedShutdown(deps)("SIGTERM");

  assert.ok(logs.some((line) => line.includes("apagado limpio")));
});

test("un segundo apagado mientras el primero sigue en curso no hace nada (no reingresa)", async () => {
  let flushCalls = 0;
  const deps = baseDeps({
    getActiveTurnCount: () => 1,
    flushPendingBursts: async () => {
      flushCalls++;
    },
    graceMs: 30,
    pollMs: 5,
  });

  const shutdown = createOrderedShutdown(deps);
  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT"); // deberia ser un no-op inmediato

  await Promise.all([first, second]);
  assert.equal(flushCalls, 1);
});
