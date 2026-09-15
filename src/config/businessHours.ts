// Fase 11 del plan maestro (2026-09-15): el horario de atencion del negocio, en la base y no en la prosa
// de customInstructions, para que el bot pueda contestar "¿a que hora abren?" con un dato real.
//
// Se guarda como Json en Business.businessHours con esta forma exacta:
//   { "mon": ["09:00","18:00"], "tue": [...], ..., "sun": null }
// null (o el dia ausente) = cerrado ese dia. La columna entera en null = el negocio no cargo horario, y
// entonces nada cambia: ninguna linea nueva entra al prompt.

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export type DayHours = [string, string] | null;
export type BusinessHours = Partial<Record<DayKey, DayHours>>;

const DAY_LABELS: Record<DayKey, string> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

function isTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [h, m] = value.split(":");
  const hours = Number(h);
  const minutes = Number(m);
  return h?.length === 2 && m?.length === 2 && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

// Lo que llega de la base es Json: puede ser cualquier cosa (una version vieja del panel, un dato cargado
// a mano). Se valida entero aca y lo que no calza se descarta en silencio, igual que un horario sin
// cargar - nunca se propaga a medias al prompt.
export function parseBusinessHours(raw: unknown): BusinessHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const parsed: BusinessHours = {};
  let anyDay = false;
  for (const day of DAY_KEYS) {
    const value = source[day];
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value) || value.length !== 2 || !isTime(value[0]) || !isTime(value[1])) continue;
    parsed[day] = [value[0], value[1]];
    anyDay = true;
  }
  return anyDay ? parsed : null;
}

// Agrupa dias seguidos con el mismo horario ("lunes a viernes de 09:00 a 18:00, sábado de 09:00 a 13:00")
// en vez de listar siete lineas - es texto que entra al prompt en cada mensaje de ese negocio.
export function formatBusinessHours(hours: BusinessHours): string {
  const runs: { from: DayKey; to: DayKey; open: string; close: string }[] = [];
  for (const day of DAY_KEYS) {
    const value = hours[day];
    if (!value) continue;
    const last = runs[runs.length - 1];
    const previousIndex = DAY_KEYS.indexOf(day) - 1;
    const isConsecutive = last && previousIndex >= 0 && last.to === DAY_KEYS[previousIndex];
    if (last && isConsecutive && last.open === value[0] && last.close === value[1]) {
      last.to = day;
      continue;
    }
    runs.push({ from: day, to: day, open: value[0], close: value[1] });
  }
  return runs
    .map((run) => {
      const days = run.from === run.to ? DAY_LABELS[run.from] : `${DAY_LABELS[run.from]} a ${DAY_LABELS[run.to]}`;
      return `${days} de ${run.open} a ${run.close}`;
    })
    .join(", ");
}

// Los dias cerrados, para poder decir explicitamente "domingos no atendemos" en vez de dejar que el
// modelo lo deduzca de una lista de dias abiertos.
export function closedDays(hours: BusinessHours): string[] {
  return DAY_KEYS.filter((day) => !hours[day]).map((day) => DAY_LABELS[day]);
}
