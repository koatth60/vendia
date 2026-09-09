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
