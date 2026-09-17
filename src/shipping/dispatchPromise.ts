import { localDayKey, localTime, localDayLabel } from "../ai/clock";

// CUANDO SE DESPACHA Y CUANDO LLEGA LO CALCULA EL SERVIDOR (2026-09-17, etapa E05 de ONIX-PLAN.md).
//
// LA DECISION QUE LE QUITA AL MODELO: en que fecha sale el pedido y en que ventana llega.
//
// EL DEFECTO QUE CIERRA. MAGByLizN tiene sus reglas de entrega escritas como prosa RELATIVA AL RELOJ
// dentro de customInstructions:
//
//   "Bogota / Soacha: si compra antes de las 11:00 AM puede llegar el mismo dia; si es despues, llega
//    al dia siguiente (11:00 AM - 9:00 PM)."
//   "Otras ciudades (Interrapidisimo): toma de 2 a 3 dias habiles."
//   "Los domingos no se pueden hacer envios de ningun tipo. Solo de lunes a sabado."
//
// Con el reloj del turno (E01) el modelo ya sabe que hora es, pero seguia teniendo que EVALUAR esas
// tres reglas a mano, en cada turno, y acertar. El 2026-09-17 no acerto: a las 10:33 del jueves le
// dijo a Ariadna "Manana se realiza el despacho" cuando el despacho era ese mismo dia, y la duena
// tuvo que corregirlo doce minutos despues. Un calculo del servidor no se equivoca.
//
// Todo el archivo es puro: recibe el instante, la zona y la regla del negocio, y devuelve fechas. Se
// prueba sin base y sin red. La regla sale de ShippingRate, que es donde el negocio ya separa
// "Bogota/Soacha" de "Nacional": la misma fila que resuelve el costo resuelve el plazo.

/** Lo que el negocio cargo para una zona. Todo opcional: sin nada cargado no se promete nada. */
export interface DispatchRule {
  /** "HH:MM" en hora local del negocio. Antes de esta hora el pedido alcanza el despacho del dia. */
  cutoffTime: string | null;
  /** true = comprando antes del corte, sale HOY. false = sale el siguiente dia habil de despacho. */
  sameDayBeforeCutoff: boolean;
  /** Dias habiles de transito, minimo y maximo, DESPUES del despacho. */
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  /** Dias de la semana en que no se despacha. 0 = domingo, 6 = sabado. */
  noDispatchWeekdays: number[];
}

export interface DispatchPromise {
  /** "YYYY-MM-DD" en la zona del negocio. */
  fechaDeDespacho: string;
  /** El mismo dia en palabras: "viernes, 18 de septiembre de 2026". */
  diaDeDespacho: string;
  /** true cuando el despacho es HOY. Es el dato que el 2026-09-17 el modelo contesto al reves. */
  seDespachaHoy: boolean;
  /** Ventana de entrega, "YYYY-MM-DD". null cuando el negocio no cargo dias de transito. */
  entregaDesde: string | null;
  entregaHasta: string | null;
  /** Por que esa fecha y no otra. Dato, no instruccion: el agente decide si lo cuenta. */
  motivo: string;
}

/** Una regla vacia: lo que tiene un negocio que no cargo nada. No promete ninguna fecha. */
export const SIN_REGLA: DispatchRule = {
  cutoffTime: null,
  sameDayBeforeCutoff: false,
  deliveryDaysMin: null,
  deliveryDaysMax: null,
  noDispatchWeekdays: [],
};

export function ruleIsEmpty(rule: DispatchRule): boolean {
  return (
    rule.cutoffTime === null &&
    rule.deliveryDaysMin === null &&
    rule.deliveryDaysMax === null &&
    rule.noDispatchWeekdays.length === 0
  );
}

/** "HH:MM" a minutos desde medianoche. Devuelve null si no tiene esa forma. */
function minutesOfDay(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Suma dias a una clave "YYYY-MM-DD" sin tocar zonas horarias: la clave YA es local. */
function addDays(dayKey: string, days: number): string {
  const t = Date.parse(`${dayKey}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Dia de la semana de una clave local. 0 = domingo. */
function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

/** El primer dia, desde `dayKey` inclusive, en que este negocio sí despacha. */
function nextDispatchDay(dayKey: string, noDispatch: number[]): string {
  let day = dayKey;
  // Tope de 7 vueltas: un negocio que marca los siete dias como sin despacho no existe, y si
  // existiera, un bucle infinito seria peor que devolver el dia pedido.
  for (let i = 0; i < 7; i++) {
    if (!noDispatch.includes(weekdayOf(day))) return day;
    day = addDays(day, 1);
  }
  return dayKey;
}

/** Suma dias HABILES (sin domingo) a una clave local, para la ventana de entrega de la transportadora. */
function addBusinessDays(dayKey: string, days: number): string {
  let day = dayKey;
  let left = days;
  while (left > 0) {
    day = addDays(day, 1);
    if (weekdayOf(day) !== 0) left--;
  }
  return day;
}

/**
 * Cuando sale este pedido y cuando llega, calculado para ESTE instante y ESTA zona.
 *
 * Devuelve null cuando el negocio no cargo ninguna regla para la zona: sin dato no se promete nada,
 * que es exactamente el comportamiento de hoy. Una venta no se frena ni se adorna por una regla que
 * el negocio no escribio.
 */
export function computeDispatchPromise(
  now: Date,
  timezone: string,
  locale: string,
  rule: DispatchRule
): DispatchPromise | null {
  if (ruleIsEmpty(rule)) return null;

  const hoy = localDayKey(now, timezone);
  const cutoff = minutesOfDay(rule.cutoffTime);
  const ahora = minutesOfDay(localTime(now, timezone));

  const hoyEsDiaDeDespacho = !rule.noDispatchWeekdays.includes(weekdayOf(hoy));
  const alcanzaElCorte = cutoff !== null && ahora !== null && ahora < cutoff;

  let fechaDeDespacho: string;
  let motivo: string;

  if (hoyEsDiaDeDespacho && rule.sameDayBeforeCutoff && alcanzaElCorte) {
    fechaDeDespacho = hoy;
    motivo = `Se despacha hoy porque todavia no son las ${rule.cutoffTime}.`;
  } else if (hoyEsDiaDeDespacho && cutoff === null) {
    // Sin hora de corte cargada, el criterio es el dia y no la hora.
    fechaDeDespacho = hoy;
    motivo = "Se despacha hoy: hoy es dia de despacho.";
  } else {
    const desde = hoyEsDiaDeDespacho && cutoff !== null ? addDays(hoy, 1) : hoy;
    fechaDeDespacho = nextDispatchDay(desde, rule.noDispatchWeekdays);
    motivo =
      !hoyEsDiaDeDespacho
        ? "Hoy no se despacha, asi que sale el proximo dia de despacho."
        : `Ya pasaron las ${rule.cutoffTime}, asi que sale el proximo dia de despacho.`;
  }

  const entregaDesde = rule.deliveryDaysMin !== null ? addBusinessDays(fechaDeDespacho, rule.deliveryDaysMin) : null;
  const entregaHasta = rule.deliveryDaysMax !== null ? addBusinessDays(fechaDeDespacho, rule.deliveryDaysMax) : null;

  return {
    fechaDeDespacho,
    diaDeDespacho: localDayLabel(new Date(`${fechaDeDespacho}T12:00:00Z`), "UTC", locale),
    seDespachaHoy: fechaDeDespacho === hoy,
    entregaDesde,
    entregaHasta,
    motivo,
  };
}

/**
 * El bloque `system`. DATO, sin ninguna instruccion sobre que contarle al cliente ni como.
 *
 * Lleva el nombre de la zona para que el agente pueda decir "para Bogota" en vez de "para tu ciudad",
 * y `seDespachaHoy` explicito porque es justo lo que el modelo contesto al reves.
 */
export function formatDispatchPromiseForModel(zona: string, promesa: DispatchPromise): string {
  return (
    `DESPACHO Y ENTREGA DE ESTE PEDIDO, calculado por el sistema para la zona "${zona}" con la fecha y ` +
    `hora de ahora:\n\n` +
    JSON.stringify(promesa)
  );
}
