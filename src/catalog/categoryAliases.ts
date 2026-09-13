import { prisma } from "../db/client";
import { normalizeForMatch } from "../search/text";

export async function listCategoryAliases(businessId: string) {
  return prisma.categoryAlias.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
}

export async function createCategoryAlias(businessId: string, data: { canonical: string; synonym: string }) {
  const normalizedSynonym = normalizeForMatch(data.synonym.trim());
  // Upsert instead of create: re-adding the same synonym (typo fix, or just repeating it) updates the
  // canonical word instead of failing on the businessId+normalizedSynonym unique constraint.
  return prisma.categoryAlias.upsert({
    where: { businessId_normalizedSynonym: { businessId, normalizedSynonym } },
    create: { businessId, canonical: data.canonical.trim(), synonym: data.synonym.trim(), normalizedSynonym },
    update: { canonical: data.canonical.trim(), synonym: data.synonym.trim() },
  });
}

export async function deleteCategoryAlias(businessId: string, id: string) {
  const alias = await prisma.categoryAlias.findFirst({ where: { id, businessId } });
  if (!alias) throw new Error("Sinonimo de categoria no encontrado");
  return prisma.categoryAlias.delete({ where: { id } });
}
