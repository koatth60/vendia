import { prisma } from "../db/client";
import { tokenize, normalizeForMatch } from "../search/text";
import { createFaqEntry } from "./faq";
import { classifyCandidate, RISK_WARNINGS, type CandidateRisk } from "./learnedFaqQuality";

// Same confidence-floor reasoning as findConfidentProductMatch (catalog/products.ts): a single
// incidental shared word isn't "the same topic" - require at least 2 distinct tokens in common before
// treating a new question as a duplicate of something already known/pending. Deliberately compares
// against the other QUESTION only, not its answer: an early version also scored the answer text and it
// false-matched unrelated questions that merely shared generic phrasing in their answers (e.g. two
// completely different warranty questions both getting answered with "6 meses" was enough to cross the
// threshold on the answer side alone). Missing a real duplicate (two questions paraphrased so
// differently they share under 2 words) is a much cheaper mistake than silently merging two different
// topics - a missed dedup just leaves an extra suggestion for the owner to discard manually.
const MIN_SHARED_TOKENS = 2;

function sharedTokenCount(tokens: string[], otherQuestion: string): number {
  const other = normalizeForMatch(otherQuestion);
  return tokens.filter((token) => other.includes(token)).length;
}

// Called after the owner resolves an ask_owner escalation over WhatsApp - that {question, answer} pair
// was already answered for real once, this decides whether it's worth surfacing as a suggested FAQ
// entry instead of discarding it after that single use.
export async function recordAskOwnerResolution(
  businessId: string,
  question: string,
  answer: string,
  conversationId: string | null
): Promise<void> {
  const trimmedAnswer = answer.trim();
  // El texto que se guardaba como "pregunta" era el que el BOT le escribio al dueno al escalar, no el
  // mensaje del cliente. Por eso las entradas quedaban con nombre de cliente, precios y contexto pegados:
  // "De qué ciudad son ustedes? (La clienta Natalia pregunta desde qué ciudad opera el negocio)". El
  // mensaje real era "De que ciudad son ustedes disculpe?". Se prefiere siempre el del cliente.
  const trimmedQuestion = (await findCustomerQuestion(conversationId)) ?? question.trim();
  if (!trimmedQuestion || !trimmedAnswer) return;

  // Filtro de calidad: lo transaccional no se guarda; lo que compromete plata si, pero marcado.
  const verdict = classifyCandidate(trimmedQuestion, trimmedAnswer);
  if (verdict.skip) {
    console.log(`Sugerencia de FAQ descartada (${verdict.reason}): "${trimmedQuestion.slice(0, 60)}"`);
    return;
  }

  const tokens = tokenize(trimmedQuestion);
  if (tokens.length === 0) return;

  const activeFaqEntries = await prisma.faqEntry.findMany({ where: { businessId, active: true } });
  const alreadyCovered = activeFaqEntries.some((entry) => sharedTokenCount(tokens, entry.question) >= MIN_SHARED_TOKENS);
  if (alreadyCovered) return;

  const pendingCandidates = await prisma.learnedFaqCandidate.findMany({ where: { businessId, status: "PENDING" } });
  const scored = pendingCandidates
    .map((candidate) => ({ candidate, score: sharedTokenCount(tokens, candidate.question) }))
    .filter(({ score }) => score >= MIN_SHARED_TOKENS)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const match = scored[0].candidate;
    await prisma.learnedFaqCandidate.update({
      where: { id: match.id },
      data: { occurrences: { increment: 1 }, updatedAt: new Date() },
    });
    return;
  }

  await prisma.learnedFaqCandidate.create({
    data: { businessId, question: trimmedQuestion, answer: trimmedAnswer, conversationId },
  });
}

// El ultimo mensaje del cliente antes de que el bot escalara: esa es la pregunta real.
async function findCustomerQuestion(conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null;
  const last = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER", mediaType: null },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  const text = last?.content?.trim();
  // Los mensajes de sistema que recordMessage guarda entre corchetes (ubicacion, tarjeta de contacto,
  // audio no transcrito) no son preguntas del cliente.
  if (!text || text.startsWith("[")) return null;
  return text;
}

// Cuantas veces tiene que llegar la misma pregunta antes de PROPONERLA en el panel. Una sola aparicion no
// distingue una politica del negocio de una respuesta puntual - asi entro el "puedes consignar la mitad"
// que despues hubo que apagar. El umbral se aplica en la ruta del panel, no aca: esta funcion devuelve lo
// que hay y la politica de que mostrar vive donde se muestra.
//
// OJO con leer mal este contador: cuenta cuantas veces PREGUNTARON los clientes, no cuantas veces lo
// confirmo el dueno. El dueno responde una vez y el contador igual sube si otros clientes preguntan lo
// mismo - confundir las dos cosas fue justo lo que hizo pasar por "confirmado 3 veces" algo dicho una sola.
export const MIN_OCCURRENCES_TO_SUGGEST = 2;

export async function listPendingCandidates(businessId: string) {
  const rows = await prisma.learnedFaqCandidate.findMany({
    where: { businessId, status: "PENDING" },
    orderBy: [{ occurrences: "desc" }, { createdAt: "desc" }],
  });
  // La advertencia se calcula al leer, no se guarda: si el criterio cambia, las sugerencias viejas
  // quedan evaluadas con el criterio nuevo sin migrar nada.
  return rows.map((row) => {
    const risk: CandidateRisk = classifyCandidate(row.question, row.answer).risk;
    return { ...row, risk, warning: risk ? RISK_WARNINGS[risk] : null };
  });
}

// Creates the real FaqEntry (reusing createFaqEntry rather than duplicating the insert) and marks the
// candidate APPROVED. Not wrapped in a transaction: worst case on a crash between the two calls is a
// candidate stuck PENDING after its FaqEntry already exists, which just means re-approving it later
// creates a harmless duplicate FaqEntry - low stakes for an internal suggestion queue, not worth the
// extra complexity of threading a transaction client through createFaqEntry's shared signature.
export async function approveCandidate(businessId: string, id: string, data: { question: string; answer: string }) {
  const candidate = await prisma.learnedFaqCandidate.findFirst({ where: { id, businessId, status: "PENDING" } });
  if (!candidate) throw new Error("Sugerencia no encontrada");

  const question = data.question.trim();
  const answer = data.answer.trim();
  if (!question || !answer) throw new Error("Falta la pregunta o la respuesta");

  const entry = await createFaqEntry(businessId, { question, answer });
  await prisma.learnedFaqCandidate.update({ where: { id }, data: { status: "APPROVED" } });
  return entry;
}

export async function discardCandidate(businessId: string, id: string): Promise<void> {
  const result = await prisma.learnedFaqCandidate.updateMany({
    where: { id, businessId, status: "PENDING" },
    data: { status: "DISCARDED" },
  });
  if (result.count === 0) throw new Error("Sugerencia no encontrada");
}
