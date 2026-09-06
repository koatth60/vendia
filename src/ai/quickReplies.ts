const GREETING_PATTERNS = [
  /^hola+!?$/,
  /^buenas?(\s(dias|tardes|noches))?!?$/,
  /^hey!?$/,
  /^hi!?$/,
  /^buen\s?dia!?$/,
];

const GREETING_REPLY =
  "¡Hola! Bienvenido/a. Cuéntame qué producto te interesa o qué necesitas y te ayudo con precios, fotos y disponibilidad.";

export function getQuickReply(text: string): string | null {
  const normalized = text.trim().toLowerCase();

  if (normalized.length <= 20 && GREETING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return GREETING_REPLY;
  }

  return null;
}
