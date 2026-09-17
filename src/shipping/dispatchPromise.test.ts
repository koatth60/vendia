import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDispatchPromise, ruleIsEmpty, SIN_REGLA, type DispatchRule } from "./dispatchPromise";

// Cuando se despacha lo calcula el servidor. Todo puro: no toca base, no llama a DeepSeek.
//
// La regla de abajo es la de MAGByLizN para Bogota/Soacha, tal como esta escrita hoy en prosa dentro
// de sus customInstructions: corte a las 11:00, antes del corte sale el mismo dia, y los domingos no
// se despacha.
const BOGOTA_ZONA: DispatchRule = {
  cutoffTime: "11:00",
  sameDayBeforeCutoff: true,
  deliveryDaysMin: 0,
  deliveryDaysMax: 0,
  noDispatchWeekdays: [0],
};

// "Otras ciudades (Interrapidisimo): 2 a 3 dias habiles", sin corte por hora.
const NACIONAL: DispatchRule = {
  cutoffTime: null,
  sameDayBeforeCutoff: false,
  deliveryDaysMin: 2,
  deliveryDaysMax: 3,
  noDispatchWeekdays: [0],
};

const TZ = "America/Bogota";
const LOC = "es-CO";

test("el caso de Ariadna: a las 10:33 del jueves el despacho es HOY, no manana", () => {
  // 2026-09-17T15:33Z = jueves 17, 10:33 en Bogota. El bot dijo "Manana se realiza el despacho" y la
  // duena lo corrigio doce minutos despues con "hoy se despacha". Este es el numero que lo decide.
  const p = computeDispatchPromise(new Date("2026-09-17T15:33:43.325Z"), TZ, LOC, BOGOTA_ZONA);
  assert.ok(p);
  assert.equal(p.seDespachaHoy, true);
  assert.equal(p.fechaDeDespacho, "2026-09-17");
  assert.match(p.diaDeDespacho, /jueves/);
});

test("pasado el corte de las 11:00, sale el dia siguiente", () => {
  // Jueves 17, 14:00 en Bogota.
  const p = computeDispatchPromise(new Date("2026-09-17T19:00:00.000Z"), TZ, LOC, BOGOTA_ZONA);
  assert.ok(p);
  assert.equal(p.seDespachaHoy, false);
  assert.equal(p.fechaDeDespacho, "2026-09-18");
  assert.match(p.motivo, /Ya pasaron las 11:00/);
});

test("el sabado despues del corte NO salta al domingo: salta al lunes", () => {
  // Sabado 19 de septiembre de 2026, 14:00 en Bogota. El domingo esta marcado sin despacho.
  const p = computeDispatchPromise(new Date("2026-09-19T19:00:00.000Z"), TZ, LOC, BOGOTA_ZONA);
  assert.ok(p);
  assert.equal(p.fechaDeDespacho, "2026-09-21");
  assert.match(p.diaDeDespacho, /lunes/);
});

test("un domingo no se despacha, y la promesa es el lunes", () => {
  // Domingo 20 de septiembre de 2026, 09:00 en Bogota - antes del corte, pero es domingo.
  const p = computeDispatchPromise(new Date("2026-09-20T14:00:00.000Z"), TZ, LOC, BOGOTA_ZONA);
  assert.ok(p);
  assert.equal(p.seDespachaHoy, false);
  assert.equal(p.fechaDeDespacho, "2026-09-21");
  assert.match(p.motivo, /Hoy no se despacha/);
});

test("sin hora de corte, el criterio es el dia: se despacha hoy", () => {
  // Jueves 17, 19:00 en Bogota. La zona nacional no tiene corte por hora.
  const p = computeDispatchPromise(new Date("2026-09-18T00:00:00.000Z"), TZ, LOC, NACIONAL);
  assert.ok(p);
  assert.equal(p.fechaDeDespacho, "2026-09-17");
  assert.equal(p.seDespachaHoy, true);
});

test("los dias de transito se cuentan en dias habiles y saltan el domingo", () => {
  // Viernes 18, 14:00 en Bogota: pasado el corte, el despacho es el sabado 19. Desde ahi, 2 y 3 dias
  // habiles son martes 22 y miercoles 23, porque el domingo 20 no cuenta.
  const p = computeDispatchPromise(new Date("2026-09-18T19:00:00.000Z"), TZ, LOC, { ...NACIONAL, cutoffTime: "11:00" });
  assert.ok(p);
  assert.equal(p.fechaDeDespacho, "2026-09-19");
  assert.equal(p.entregaDesde, "2026-09-22");
  assert.equal(p.entregaHasta, "2026-09-23");
});

test("un negocio que no cargo nada no promete ninguna fecha", () => {
  assert.equal(ruleIsEmpty(SIN_REGLA), true);
  assert.equal(computeDispatchPromise(new Date(), TZ, LOC, SIN_REGLA), null);
});

test("una hora de corte mal escrita no tira: se trata como si no hubiera corte", () => {
  const rota: DispatchRule = { ...BOGOTA_ZONA, cutoffTime: "veintipico" };
  const p = computeDispatchPromise(new Date("2026-09-17T19:00:00.000Z"), TZ, LOC, rota);
  assert.ok(p);
  assert.equal(p.seDespachaHoy, true, "sin corte legible, el criterio vuelve a ser el dia");
});

test("el bloque es dato: seDespachaHoy es explicito, que es lo que el modelo contesto al reves", () => {
  const p = computeDispatchPromise(new Date("2026-09-17T15:33:43.325Z"), TZ, LOC, BOGOTA_ZONA)!;
  assert.equal(typeof p.seDespachaHoy, "boolean");
  assert.equal(typeof p.motivo, "string");
  // El motivo explica la fecha; no le dice al agente que escribir.
  assert.doesNotMatch(p.motivo, /\b(dile|decile|responde|nunca|siempre)\b/i);
});
