import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnClock,
  dayMarkerText,
  formatTurnClockForModel,
  localDayKey,
  localDayLabel,
  localDaysBetween,
  localTime,
  localWeekday,
  markHistoryByDay,
} from "./clock";

// El turno lleva reloj. Todo este archivo es puro: no toca base, no llama a DeepSeek.
//
// Los instantes elegidos no son inventados: son los del incidente real que motivo el archivo
// (conversacion cmu4wsaqb00blq92k2jgfjsgy, MAGByLizN, zona America/Bogota).
const BOGOTA = "America/Bogota";
const ES_CO = "es-CO";

/** La duena escribio "manana mismo se te despacha": 16 sep 21:28 en Bogota. */
const DUENA_16_SEP = new Date("2026-09-17T02:28:00.013Z");
/** El bot contesto "Manana se realiza el despacho": 17 sep 10:33 en Bogota. Era HOY. */
const BOT_17_SEP = new Date("2026-09-17T15:33:43.325Z");

test("el instante del incidente se lee en la zona del negocio, no en UTC", () => {
  // En UTC los dos mensajes caen el 17. En Bogota son de dias distintos, que es el punto entero.
  assert.equal(localDayKey(DUENA_16_SEP, BOGOTA), "2026-09-16");
  assert.equal(localDayKey(BOT_17_SEP, BOGOTA), "2026-09-17");
  assert.equal(localDayKey(DUENA_16_SEP, "UTC"), "2026-09-17");
});

test("la hora local sale en 24 horas y la medianoche es 00, no 24", () => {
  assert.equal(localTime(BOT_17_SEP, BOGOTA), "10:33");
  assert.equal(localTime(DUENA_16_SEP, BOGOTA), "21:28");
  assert.equal(localTime(new Date("2026-09-17T05:00:00.000Z"), BOGOTA), "00:00");
});

test("el dia de la semana y el dia en palabras salen en el idioma del negocio", () => {
  assert.equal(localWeekday(BOT_17_SEP, BOGOTA, ES_CO), "jueves");
  assert.match(localDayLabel(DUENA_16_SEP, BOGOTA, ES_CO), /mi[eé]rcoles,? 16 de septiembre de 2026/);
});

test("los dias entre dos instantes se cuentan por dia calendario local, no por 24 horas", () => {
  // 14 horas y 5 minutos de diferencia real. En UTC la division da 0. La respuesta correcta es 1:
  // para el cliente, la duena hablo AYER. Es el borde exacto donde se rompe "manana".
  assert.equal(localDaysBetween(DUENA_16_SEP, BOT_17_SEP, BOGOTA), 1);
  assert.equal(Math.floor((BOT_17_SEP.getTime() - DUENA_16_SEP.getTime()) / (24 * 60 * 60 * 1000)), 0);
});

test("dos instantes del mismo dia local dan cero dias", () => {
  const manana = new Date("2026-09-17T14:00:00.000Z");
  const tarde = new Date("2026-09-17T22:00:00.000Z");
  assert.equal(localDaysBetween(manana, tarde, BOGOTA), 0);
});

test("el bloque del reloj es dato: lleva fecha, dia, hora y zona, y ninguna instruccion", () => {
  const clock = buildTurnClock(BOT_17_SEP, BOGOTA, ES_CO);
  assert.deepEqual(clock, {
    fecha: "2026-09-17",
    diaDeLaSemana: "jueves",
    hora: "10:33",
    zona: "America/Bogota",
  });

  const texto = formatTurnClockForModel(clock);
  assert.match(texto, /"fecha":"2026-09-17"/);
  // Sin verbos de instruccion: es un dato, la conversacion sigue siendo del agente.
  assert.doesNotMatch(texto, /\b(nunca|siempre|no le digas|recuerda|debes)\b/i);
});

test("una zona o un locale invalido degrada a UTC en vez de tirar el turno", () => {
  assert.doesNotThrow(() => buildTurnClock(BOT_17_SEP, "Marte/Olympus", "xx-YY"));
  const clock = buildTurnClock(BOT_17_SEP, "Marte/Olympus", "xx-YY");
  assert.equal(clock.fecha, "2026-09-17");
  // La zona se reporta tal como esta cargada, aunque el formateo haya caido a UTC: quien lea el
  // bloque tiene que poder ver que el negocio tiene una zona que el runtime no reconoce.
  assert.equal(clock.zona, "Marte/Olympus");
});

test("una conversacion de un solo dia no paga ni un marcador", () => {
  const messages = [
    { createdAt: new Date("2026-09-17T14:00:00.000Z"), content: "hola" },
    { createdAt: new Date("2026-09-17T15:33:43.325Z"), content: "ya hiciste el envio?" },
  ];
  const marked = markHistoryByDay(messages, { now: BOT_17_SEP, timezone: BOGOTA, locale: ES_CO });
  assert.deepEqual(marked.map((m) => m.marker), [null, null]);
});

test("cuando el historial cruza de dia, cada tramo arranca con su marcador y el de hoy dice HOY", () => {
  const messages = [
    { createdAt: new Date("2026-09-17T02:24:05.833Z"), content: "pedido" }, // 16 sep 21:24 Bogota
    { createdAt: DUENA_16_SEP, content: "manana mismo se te despacha" }, // 16 sep 21:28
    { createdAt: new Date("2026-09-17T15:33:33.660Z"), content: "ya hiciste el envio?" }, // 17 sep 10:33
    { createdAt: BOT_17_SEP, content: "respuesta" }, // 17 sep 10:33
  ];
  const marked = markHistoryByDay(messages, { now: BOT_17_SEP, timezone: BOGOTA, locale: ES_CO });

  assert.match(marked[0].marker ?? "", /mi[eé]rcoles,? 16 de septiembre de 2026/);
  assert.doesNotMatch(marked[0].marker ?? "", /HOY/);
  assert.equal(marked[1].marker, null);
  assert.match(marked[2].marker ?? "", /HOY, jueves,? 17 de septiembre de 2026/);
  assert.equal(marked[3].marker, null);
  // Los mensajes salen intactos y en el mismo orden: el marcador es un mensaje aparte, nunca un
  // prefijo pegado al texto (ver el incidente de imitacion de corchetes en agent.ts).
  assert.deepEqual(marked.map((m) => m.message), messages);
});

test("el marcador no tiene forma de corchete, que es lo que el modelo imita", () => {
  const texto = dayMarkerText("jueves 17 de septiembre de 2026", false);
  assert.doesNotMatch(texto, /[[\]]/);
});
