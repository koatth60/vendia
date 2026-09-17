// EL TURNO LLEVA RELOJ (2026-09-17).
//
// LA DECISION QUE LE QUITA AL MODELO: que dia y que hora es.
//
// Hasta hoy el turno no llevaba ni una sola marca de tiempo. Ni fecha, ni hora, ni dia de la semana,
// ni zona horaria, ni timestamps en los mensajes del historial. El modelo deducia "cuando estamos"
// de lo que leia en el chat, que es exactamente una lectura de prosa: el guard de clase D que el
// plan prohibe, solo que ejercido por el modelo en vez de por una expresion regular.
//
// EL DEFECTO QUE CIERRA, medido en produccion (conversacion cmu4wsaqb00blq92k2jgfjsgy):
//
//   16 sep 21:28 (Bogota)  Duena:  "si sra manana mismo se te despacha te esta llegando el viernes"
//   17 sep 10:33 (Bogota)  Bot:    "todavia aparece como pendiente de despacho. Manana se realiza
//                                   el despacho y tan pronto salga te comparto la foto de la guia"
//   17 sep 10:45 (Bogota)  Duena:  "no te preocupes que hoy se despacha"
//
// Ese turno del bot SI llamo get_order_status y SI recibio el estado real de la base (PENDING, sin
// despachar). No fallo el dato: fallo la fecha. El "manana" de la duena era del dia anterior y el
// modelo lo leyo como si fuera de hace un minuto, porque nada en el turno decia que habia pasado un
// dia. Con la garantia de abajo ese error deja de ser posible por construccion: el instante actual y
// el dia de cada tramo del historial son datos del servidor, no una deduccion.
//
// Es la misma forma que ya tienen postSaleFactsForModel y getCustomerCommerceState: DATO
// estructurado, sin una sola instruccion alrededor. Que decir y como decirlo sigue siendo del agente.
// Y no agrega una linea a src/ai/prompts/systemPrompt.ts - el bloque se arma en el turno, no en el
// prompt base.
//
// Todo el archivo es puro: recibe el instante, la zona y el locale, y devuelve texto. Se prueba sin
// base de datos y sin red.

/** Zona a la que se cae si la del negocio no la reconoce el runtime. Nunca tira. */
const FALLBACK_TIMEZONE = "UTC";
/** Locale al que se cae si el del negocio no lo reconoce el runtime. */
const FALLBACK_LOCALE = "es";

function formatter(locale: string, timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // Una zona o un locale invalido en Business hace que Intl tire RangeError. Un turno no se puede caer
  // por eso: el reloj es contexto, no el pedido. Se degrada a UTC/es y el turno sigue.
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone });
  } catch {
    try {
      return new Intl.DateTimeFormat(FALLBACK_LOCALE, { ...options, timeZone: timezone });
    } catch {
      return new Intl.DateTimeFormat(FALLBACK_LOCALE, { ...options, timeZone: FALLBACK_TIMEZONE });
    }
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/**
 * El dia calendario de ese instante EN LA ZONA DEL NEGOCIO, como "YYYY-MM-DD".
 *
 * Es la unidad con la que se compara "ayer" contra "hoy" en todo el sistema. Se arma con
 * formatToParts y no con un locale que ya devuelva ese orden, para no depender de como formatea
 * fechas la version de ICU que tenga el runtime.
 */
export function localDayKey(instant: Date, timezone: string): string {
  const parts = formatter("en-US", timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

/** La hora local en 24 horas, "HH:MM". hourCycle h23 y no hour12:false: con hour12 la medianoche sale "24". */
export function localTime(instant: Date, timezone: string): string {
  const parts = formatter("en-US", timezone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  return `${part(parts, "hour")}:${part(parts, "minute")}`;
}

/** El dia de la semana en el idioma del negocio: "jueves". */
export function localWeekday(instant: Date, timezone: string, locale: string): string {
  return formatter(locale, timezone, { weekday: "long" }).format(instant);
}

/** El dia entero en palabras del negocio: "jueves 17 de septiembre de 2026". */
export function localDayLabel(instant: Date, timezone: string, locale: string): string {
  return formatter(locale, timezone, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(instant);
}

/**
 * Cuantos DIAS CALENDARIO pasaron entre dos instantes, en la zona del negocio.
 *
 * No es una resta de milisegundos dividida por 24 horas. Un pedido de las 19:36 del martes en Bogota
 * es 00:36 del miercoles en UTC: a las 10:33 del miercoles la resta en UTC da 0 dias y la respuesta
 * correcta es 1. Justo el borde que importa, porque es el borde donde el cliente escribe "al dia
 * siguiente".
 */
export function localDaysBetween(from: Date, to: Date, timezone: string): number {
  const desde = Date.parse(`${localDayKey(from, timezone)}T00:00:00Z`);
  const hasta = Date.parse(`${localDayKey(to, timezone)}T00:00:00Z`);
  return Math.round((hasta - desde) / (24 * 60 * 60 * 1000));
}

export interface TurnClock {
  /** El dia de hoy en la zona del negocio, "YYYY-MM-DD". */
  fecha: string;
  diaDeLaSemana: string;
  /** "HH:MM", 24 horas. */
  hora: string;
  /** La zona horaria del negocio, tal como esta cargada. */
  zona: string;
}

export function buildTurnClock(now: Date, timezone: string, locale: string): TurnClock {
  return {
    fecha: localDayKey(now, timezone),
    diaDeLaSemana: localWeekday(now, timezone, locale),
    hora: localTime(now, timezone),
    zona: timezone,
  };
}

/**
 * El bloque `system` del reloj. Dato, sin ninguna instruccion sobre que hacer con el.
 *
 * Sale en TODOS los turnos y para todos los negocios: el disparador es "existe un turno", que no es
 * una lectura de prosa ni una bandera que alguien tenga que acordarse de prender.
 */
export function formatTurnClockForModel(clock: TurnClock): string {
  return `AHORA MISMO, en la zona horaria de este negocio: ${JSON.stringify(clock)}`;
}

/**
 * El marcador de dia que va ANTES de cada tramo del historial.
 *
 * Va como mensaje `system` y no como prefijo del mensaje del historial a proposito. El repositorio ya
 * tiene el incidente medido (2026-09-13, ver extractMediaHistory en agent.ts): cualquier cosa con
 * forma de corchete metida en un mensaje de rol ASSISTANT el modelo la imita en su propia respuesta.
 * Un mensaje `system` no es algo que el modelo devuelva como texto suyo.
 */
export function dayMarkerText(dayLabel: string, esHoy: boolean): string {
  return esHoy
    ? `Los mensajes que siguen son de HOY, ${dayLabel}.`
    : `Los mensajes que siguen son del ${dayLabel}.`;
}

export interface MarkedMessage<T> {
  /** Texto del marcador de dia que va antes de este mensaje, o null si no arranca un dia nuevo. */
  marker: string | null;
  message: T;
}

/**
 * El historial, con un marcador de dia antes del primer mensaje de cada dia calendario.
 *
 * Si toda la conversacion visible ocurrio en UN solo dia no devuelve ningun marcador: el bloque del
 * reloj ya dice que dia es y el marcador no agregaria nada. La mayoria de las conversaciones son de
 * un solo dia, asi que el costo en tokens de esta pieza es cero en el caso comun y de un puñado de
 * tokens justo cuando hace falta.
 */
export function markHistoryByDay<T extends { createdAt: Date }>(
  messages: T[],
  options: { now: Date; timezone: string; locale: string }
): MarkedMessage<T>[] {
  const { now, timezone, locale } = options;
  const keys = messages.map((m) => localDayKey(m.createdAt, timezone));
  const spansSeveralDays = new Set(keys).size > 1;
  if (!spansSeveralDays) return messages.map((message) => ({ marker: null, message }));

  const hoy = localDayKey(now, timezone);
  let previousKey: string | null = null;
  return messages.map((message, i) => {
    const key = keys[i];
    if (key === previousKey) return { marker: null, message };
    previousKey = key;
    return { marker: dayMarkerText(localDayLabel(message.createdAt, timezone, locale), key === hoy), message };
  });
}
