import { prisma } from "../db/client";

export async function listFaqEntries(businessId: string) {
  return prisma.faqEntry.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
}

// FAQ lists are small per business, so the agent tool hands the model the whole active list
// instead of pre-filtering by keyword match - that pre-filter used to miss paraphrased customer
// questions (a keyword scorer can't tell "envio gratis" is a variant of "cuanto cuesta el envio").
export async function listActiveFaqEntries(businessId: string) {
  return prisma.faqEntry.findMany({ where: { businessId, active: true }, orderBy: { createdAt: "asc" } });
}

export async function createFaqEntry(businessId: string, data: { question: string; answer: string }) {
  return prisma.faqEntry.create({ data: { ...data, businessId } });
}

export async function updateFaqEntry(
  businessId: string,
  id: string,
  data: Partial<{ question: string; answer: string; active: boolean }>
) {
  const entry = await prisma.faqEntry.findFirst({ where: { id, businessId } });
  if (!entry) throw new Error("Pregunta frecuente no encontrada");
  return prisma.faqEntry.update({ where: { id }, data });
}

export async function deleteFaqEntry(businessId: string, id: string) {
  const entry = await prisma.faqEntry.findFirst({ where: { id, businessId } });
  if (!entry) throw new Error("Pregunta frecuente no encontrada");
  return prisma.faqEntry.delete({ where: { id } });
}

// LAS PREGUNTAS FRECUENTES ENTRAN AL TURNO COMO DATO (2026-09-17, etapa E09b de ONIX-PLAN.md).
//
// LA DECISION QUE LE QUITA AL MODELO: si va a mirar lo que el negocio ya respondio.
//
// EL DEFECTO QUE CIERRA, medido sobre 14 dias de produccion: get_faq se llamo 0 veces en 179 turnos.
// MAGByLizN tiene 16 preguntas frecuentes activas, y 12 salieron del ciclo de aprendizaje - el
// subsistema que mejor funciona del producto y el diferenciador que ningun competidor tiene. El bot
// nunca las leia.
//
// El caso, conversacion cmtxl4534001d8f2k8kie1cdg (2026-09-17 18:59). El cliente pregunta "Donde se
// ubican". El turno corre con una sola iteracion y CERO herramientas. El bot contesta "Esa informacion
// no esta disponible por el momento. Voy a consultar con el equipo". En la base, en ese mismo momento:
//
//   "De que ciudad son ustedes? Tienen tienda fisica?"
//   -> "Somos una tienda 100% virtual ubicada en Bogota. Hacemos envios a todo el pais..."
//
// Un hecho detras de una herramienta que el modelo tiene que acordarse de llamar no es un hecho: es una
// posibilidad. Se invierte, igual que se hizo con el catalogo, los datos del cliente y la fecha de
// despacho - lo pone el servidor, en todos los turnos, y el modelo no puede ignorar lo que tiene
// delante.
//
// EL COSTO, medido antes de decidir: las 16 entradas de este negocio son 2.170 caracteres, ~600 tokens.
// El bloque es identico turno a turno, asi que entra en cache (la tasa de acierto de este negocio es
// 88%). Contra eso, UNA sola llamada a get_faq gasta una iteracion completa del loop, que cuesta mas.
// Por eso la herramienta se borra en vez de convivir con el bloque: dos caminos al mismo dato solo
// pueden aportar una contradiccion.
//
// Cuando la lista crezca (mas de ~80 entradas) el bloque deja de caber y ahi si hace falta recuperar
// por relevancia. Ese es el limite anotado en la etapa E59 del plan, junto al contador de uso que dice
// cuales conservar.

/** Cuantas entradas entran al turno. Tope duro: una FAQ que crecio sin control no puede inflar el prompt. */
export const FAQ_BLOCK_MAX_ENTRIES = 80;

export interface FaqFact {
  pregunta: string;
  respuesta: string;
}

/**
 * El bloque `system` con las preguntas frecuentes. DATO, sin ninguna instruccion sobre que contestar.
 *
 * Devuelve null cuando el negocio no cargo ninguna: un negocio sin FAQ no paga un solo token, y el
 * modelo no recibe una lista vacia que tendria que interpretar.
 *
 * Funcion pura: se prueba sin base.
 */
export function formatFaqForModel(entries: FaqFact[]): string | null {
  if (entries.length === 0) return null;
  const incluidas = entries.slice(0, FAQ_BLOCK_MAX_ENTRIES);
  return (
    `PREGUNTAS FRECUENTES DE ESTE NEGOCIO, tal como las dejo escritas el dueno. Son la respuesta real a ` +
    `estos temas:\n\n` +
    JSON.stringify(incluidas)
  );
}

/** Las preguntas frecuentes activas, con la forma que entra al turno. */
export async function getFaqFacts(businessId: string): Promise<FaqFact[]> {
  const entries = await listActiveFaqEntries(businessId);
  return entries.map((e) => ({ pregunta: e.question, respuesta: e.answer }));
}
