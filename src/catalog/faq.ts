import { prisma } from "../db/client";
import { tokenize, normalizeForMatch } from "../search/text";

export async function listFaqEntries(businessId: string) {
  return prisma.faqEntry.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
}

function relevanceScore(tokens: string[], entry: { question: string; answer: string }): number {
  const question = normalizeForMatch(entry.question);
  const answer = normalizeForMatch(entry.answer);

  let score = 0;
  for (const token of tokens) {
    if (question.includes(token)) score += 3;
    if (answer.includes(token)) score += 1;
  }
  return score;
}

export async function searchFaq(businessId: string, query: string) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // FAQ lists are small per business, so score in memory against accent-normalized text
  // instead of a SQL `contains` filter (which would miss e.g. "envios" vs stored "envíos").
  const entries = await prisma.faqEntry.findMany({ where: { businessId, active: true } });

  return entries
    .map((entry) => ({ entry, score: relevanceScore(tokens, entry) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
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
