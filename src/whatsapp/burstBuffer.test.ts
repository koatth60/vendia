import { test } from "node:test";
import assert from "node:assert/strict";
import { createBurstBuffer } from "./burstBuffer";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Criterio de aceptacion de la Fase 10 (ONIX-PLAN-MAESTRO.md): 3 mensajes del cliente en 2 s
// producen 1 sola descarga (que en produccion es 1 sola llamada a generateReply, ver
// src/routes/whatsapp.ts). Ventana chica (30 ms) para que la prueba no tenga que esperar los 8 s
// reales de produccion - el mecanismo de debounce es el mismo, solo cambia la duracion.
test("3 mensajes en 2s producen 1 sola rafaga con los 3 items, en orden", async () => {
  const flushes: { key: string; items: number[] }[] = [];
  const buffer = createBurstBuffer<number>(
    async (key, items) => {
      flushes.push({ key, items });
    },
    { windowMs: 30 }
  );

  buffer.add("conv-1", 1);
  await delay(5);
  buffer.add("conv-1", 2);
  await delay(5);
  buffer.add("conv-1", 3);

  assert.equal(flushes.length, 0, "no debe descargar mientras siguen llegando mensajes dentro de la ventana");
  await delay(60);

  assert.equal(flushes.length, 1, "3 mensajes seguidos tienen que producir 1 sola rafaga");
  assert.deepEqual(flushes[0].items, [1, 2, 3]);
});

test("cada mensaje nuevo reinicia la ventana de silencio", async () => {
  const flushes: number[][] = [];
  const buffer = createBurstBuffer<number>(async (_key, items) => void flushes.push(items), { windowMs: 40 });

  buffer.add("conv-1", 1);
  await delay(25);
  assert.equal(flushes.length, 0);
  buffer.add("conv-1", 2); // reinicia el timer antes de que el primero expire
  await delay(25);
  assert.equal(flushes.length, 0, "el segundo mensaje tiene que haber reiniciado la ventana");
  await delay(30);
  assert.equal(flushes.length, 1);
  assert.deepEqual(flushes[0], [1, 2]);
});

test("conversaciones distintas se agrupan y descargan por separado", async () => {
  const flushes: { key: string; items: string[] }[] = [];
  const buffer = createBurstBuffer<string>(
    async (key, items) => {
      flushes.push({ key, items });
    },
    { windowMs: 20 }
  );

  buffer.add("conv-a", "a1");
  buffer.add("conv-b", "b1");
  buffer.add("conv-a", "a2");

  await delay(50);

  assert.equal(flushes.length, 2);
  const byKey = Object.fromEntries(flushes.map((f) => [f.key, f.items]));
  assert.deepEqual(byKey["conv-a"], ["a1", "a2"]);
  assert.deepEqual(byKey["conv-b"], ["b1"]);
});

test("maxWaitMs fuerza la descarga aunque el cliente nunca deje pasar la ventana", async () => {
  const flushes: number[][] = [];
  const buffer = createBurstBuffer<number>(async (_key, items) => void flushes.push(items), {
    windowMs: 30,
    maxWaitMs: 50,
  });

  const start = Date.now();
  buffer.add("conv-1", 1);
  // Reingresa cada 15ms, siempre antes de que la ventana de 30ms expire por si sola.
  for (let i = 2; i <= 6; i++) {
    await delay(15);
    buffer.add("conv-1", i);
  }

  await delay(60);
  const elapsed = Date.now() - start;

  assert.ok(flushes.length >= 1, "el tope maxWaitMs tiene que forzar al menos una descarga");
  assert.ok(elapsed < 200, `no deberia tardar mucho mas que maxWaitMs (tardo ${elapsed}ms)`);
});

test("un flush que revienta no rompe rafagas futuras de la misma clave", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const buffer = createBurstBuffer<number>(
    async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
    { windowMs: 15, onError: (_key, error) => errors.push(error) }
  );

  buffer.add("conv-1", 1);
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);

  buffer.add("conv-1", 2);
  await delay(30);
  assert.equal(calls, 2, "la siguiente rafaga de la misma conversacion tiene que seguir funcionando");
});

test("flushAll descarga de inmediato lo pendiente, sin esperar el resto de la ventana", async () => {
  const flushes: number[][] = [];
  const buffer = createBurstBuffer<number>(async (_key, items) => void flushes.push(items), { windowMs: 5000 });

  buffer.add("conv-1", 1);
  buffer.add("conv-1", 2);
  assert.equal(flushes.length, 0);

  await buffer.flushAll();

  assert.equal(flushes.length, 1, "flushAll tiene que descargar sin esperar los 5s de ventana");
  assert.deepEqual(flushes[0], [1, 2]);
  assert.equal(buffer.pendingCount(), 0);
});

test("flushAll descarga todas las claves pendientes, no solo una", async () => {
  const flushed: string[] = [];
  const buffer = createBurstBuffer<number>(
    async (key) => {
      flushed.push(key);
    },
    { windowMs: 5000 }
  );

  buffer.add("conv-a", 1);
  buffer.add("conv-b", 1);
  buffer.add("conv-c", 1);

  await buffer.flushAll();

  assert.deepEqual(flushed.sort(), ["conv-a", "conv-b", "conv-c"]);
});

test("flushAll espera a que las descargas forzadas terminen antes de resolver", async () => {
  let processed = false;
  const buffer = createBurstBuffer<number>(
    async () => {
      await delay(20);
      processed = true;
    },
    { windowMs: 5000 }
  );

  buffer.add("conv-1", 1);
  await buffer.flushAll();

  assert.equal(processed, true, "flushAll no deberia resolver antes de que termine el flush real");
});

test("flushAll nunca rechaza, aunque el flush reviente - ya quedo reportado via onError", async () => {
  const errors: unknown[] = [];
  const buffer = createBurstBuffer<number>(
    async () => {
      throw new Error("boom");
    },
    { windowMs: 5000, onError: (_key, error) => errors.push(error) }
  );

  buffer.add("conv-1", 1);
  await assert.doesNotReject(() => buffer.flushAll());
  assert.equal(errors.length, 1);
});

test("flushAll con nada pendiente no hace nada", async () => {
  const buffer = createBurstBuffer<number>(async () => {}, { windowMs: 5000 });
  await assert.doesNotReject(() => buffer.flushAll());
});

test("pendingCount refleja rafagas en espera", async () => {
  const buffer = createBurstBuffer<number>(async () => {}, { windowMs: 20 });
  assert.equal(buffer.pendingCount(), 0);
  buffer.add("conv-1", 1);
  buffer.add("conv-2", 1);
  assert.equal(buffer.pendingCount(), 2);
  await delay(40);
  assert.equal(buffer.pendingCount(), 0);
});
