import { test } from "node:test";
import assert from "node:assert/strict";
import { hayQueRespaldar, HORAS_ENTRE_RESPALDOS, BACKUP_CHECK_INTERVAL_MS } from "./backup";

// RESPALDOS (2026-09-18).
//
// scripts/backupDb.ts existia desde antes y hacia lo correcto, pero NO LO LLAMABA NADIE: cero
// referencias en todo el repositorio - ni cron, ni job, ni script de npm. Eso es peor que no tenerlo,
// porque da la sensacion de que hay respaldos.
//
// Se prueba la DECISION, que es la unica parte con logica. El volcado es pg_dump y la subida es el SDK
// de S3: probarlos aca seria probar codigo ajeno. La ida y vuelta de verdad (pg_dump -> pg_restore
// sobre una base vacia) se verifico a mano el 2026-09-18 y quedo anotada en docs/RESPALDOS.md.

const horas = (n: number) => n * 60 * 60 * 1000;
const ahora = new Date("2026-09-18T12:00:00Z");

test("sin ningun respaldo previo, siempre hay que respaldar", () => {
  assert.equal(hayQueRespaldar(null, ahora), true);
});

test("un respaldo reciente no se repite", () => {
  assert.equal(hayQueRespaldar(new Date(ahora.getTime() - horas(2)), ahora), false);
  assert.equal(hayQueRespaldar(new Date(ahora.getTime() - horas(19)), ahora), false);
});

test("pasadas las 20 horas, toca de nuevo", () => {
  assert.equal(hayQueRespaldar(new Date(ahora.getTime() - horas(20)), ahora), true);
  assert.equal(hayQueRespaldar(new Date(ahora.getTime() - horas(21)), ahora), true);
  assert.equal(hayQueRespaldar(new Date(ahora.getTime() - horas(72)), ahora), true);
});

test("el corte es 20h y no 24h, para que no se corra un poco cada dia", () => {
  assert.equal(HORAS_ENTRE_RESPALDOS, 20);
});

test("se revisa cada hora, asi el respaldo no depende de que el proceso viva 24h seguidas", () => {
  // Trece despliegues en un dia ya pasaron (2026-09-17). Con un intervalo diario, cada reinicio
  // empujaba el respaldo un dia entero mas adelante y podia no hacerse nunca.
  assert.equal(BACKUP_CHECK_INTERVAL_MS, horas(1));
});
