// Fase 2 del plan de estabilizacion (2026-09-15). El autoaprendizaje venia guardando cualquier par
// {pregunta, respuesta} que el dueno resolviera por WhatsApp, sin mirar si servia como FAQ. Resultado
// real: de 12 entradas aprendidas, casi todas quedaron mal - una concesion puntual ("¿puedo consignar la
// mitad?" -> "Si claro no hay problema") quedo como politica para todos los clientes, otra respondia
// "Estamos en Bogotá Linda" con el apodo de una clienta adentro, y otras directamente no eran preguntas
// ("Municipio del Zulía Norte De Santander").
//
// La leccion de limpiarlas a mano, y el criterio de aca: NO alcanza con descartar lo que esta mal
// redactado. De esas 12, cuatro tenian conocimiento verdadero y util (que relojes contestan mensajes, si
// mandan la guia, si se pueden enviar emojis) y solo estaban mal escritas. Descartar por redaccion tiraba
// conocimiento bueno. Entonces: se descarta lo TRANSACCIONAL (habla de un pedido concreto, no del
// negocio) y se MARCA lo que compromete plata para que el dueno decida, en vez de decidir por el.

export type CandidateRisk = "dinero" | "datos_personales" | null;

export interface CandidateVerdict {
  skip: boolean;
  reason?: string;
  risk: CandidateRisk;
}

// Habla de UN pedido concreto, no de como funciona el negocio. Nunca sirve como pregunta frecuente:
// "Me puedes enviar la guíapor fa", "¿ya está pagado mi pedido?".
// La ultima alternativa cubre el pedido directo de un documento concreto ("me puedes enviar la guia por
// fa"), que es distinto de la pregunta de politica sobre lo mismo ("¿me envian la guia del envio?"). La
// diferencia esta en que uno pide algo AHORA y el otro pregunta como funciona - por eso el marcador es el
// verbo en primera persona pidiendo, no la palabra "guia" sola.
const TRANSACTIONAL_PATTERN =
  /\b(mi|mis|tu|su)\s+(pedido|compra|guia|guía|orden|env[ií]o|paquete|comprobante|transferencia)\b|\bya (est[aá]|quedo|qued[oó]) (pagad|confirmad|despachad|enviad)|\bme\s+(puedes\s+|podr[ií]as\s+)?(envi|manda|pasa)\w*\s.{0,20}\b(gu[ií]a|comprobante|factura)/i;

// Compromete plata: descuentos, rebajas, formas de pago fuera de lo estandar. Puede ser politica real
// (el descuento de $10.000 por llevar dos productos lo era) o una concesion de una sola venta. No se
// puede distinguir automaticamente, asi que se marca y decide el dueno.
const MONEY_PATTERN =
  /\b(descuento|dcto|rebaja|promoci[oó]n|gratis|regalad|consignar|abonar|cuotas?|mitad|separar|apartar)\b|\$\s?\d/i;

// Un numero largo suelto en la respuesta suele ser una cedula, un celular o un numero de cuenta: datos
// de una persona concreta que no deberian quedar guardados en una FAQ que se le lee a cualquiera.
const PERSONAL_DATA_PATTERN = /\b\d{7,}\b/;

// Respuestas que no dicen nada por si solas. "Si" como respuesta completa obliga a leer la pregunta
// original para entender algo, y la pregunta original casi nunca esta bien escrita.
const CONTENTLESS_ANSWER_PATTERN = /^(s[ií]|no|ok|listo|claro|correcto|exacto|dale)[\s.!]*$/i;

export function classifyCandidate(question: string, answer: string): CandidateVerdict {
  const q = question.trim();
  const a = answer.trim();

  if (CONTENTLESS_ANSWER_PATTERN.test(a)) {
    return { skip: true, reason: "la respuesta no dice nada por si sola", risk: null };
  }
  if (TRANSACTIONAL_PATTERN.test(q) || TRANSACTIONAL_PATTERN.test(a)) {
    return { skip: true, reason: "habla de un pedido concreto, no del negocio", risk: null };
  }
  // Sin minimo de palabras a proposito: una respuesta util puede ser corta de verdad ("3 meses",
  // "No por ahora", "llega en 3 dias"). Un primer intento exigia 3 palabras con contenido y rechazaba
  // justo esas. Lo que descarta el ruido real es CONTENTLESS_ANSWER_PATTERN de arriba.
  if (PERSONAL_DATA_PATTERN.test(a)) return { skip: false, risk: "datos_personales" };
  if (MONEY_PATTERN.test(q) || MONEY_PATTERN.test(a)) return { skip: false, risk: "dinero" };
  return { skip: false, risk: null };
}

export const RISK_WARNINGS: Record<Exclude<CandidateRisk, null>, string> = {
  dinero:
    "Compromete plata. Revisa si es una politica real del negocio o una concesion de esa venta en particular - si la apruebas, el bot se la va a ofrecer a todos.",
  datos_personales:
    "La respuesta trae un numero largo (cedula, celular o cuenta). Quítalo antes de aprobar: esta FAQ se le lee a cualquier cliente.",
};
