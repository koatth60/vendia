import { prisma } from "../db/client";
import { getPresignedMediaUrl, deleteMedia as deleteMediaFromS3 } from "../media/s3";
import { tokenize, normalizeForMatch } from "../search/text";

async function withFreshMediaUrls<T extends { media: { s3Key: string; url: string }[] }>(
  products: T[]
): Promise<T[]> {
  for (const product of products) {
    for (const media of product.media) {
      media.url = await getPresignedMediaUrl(media.s3Key);
    }
  }
  return products;
}

export async function listActiveProducts(businessId: string) {
  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    include: { media: true },
    orderBy: { createdAt: "desc" },
  });
  return withFreshMediaUrls(products);
}

export async function listAllProducts(businessId: string) {
  const products = await prisma.product.findMany({
    where: { businessId },
    include: { media: true },
    orderBy: { createdAt: "desc" },
  });
  return withFreshMediaUrls(products);
}

export async function getProductById(businessId: string, id: string) {
  const product = await prisma.product.findFirst({
    where: { id, businessId },
    include: { media: true },
  });
  if (!product) return null;
  const [withMedia] = await withFreshMediaUrls([product]);
  return withMedia;
}

function relevanceScore(tokens: string[], product: { name: string; description: string; category: string | null }): number {
  const name = normalizeForMatch(product.name);
  const description = normalizeForMatch(product.description);
  const category = normalizeForMatch(product.category ?? "");

  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 3;
    if (category.includes(token)) score += 2;
    if (description.includes(token)) score += 1;
  }
  return score;
}

// Scores in memory against accent-normalized text instead of a SQL `contains` filter (which would
// miss e.g. "smartwatch deportivo" vs stored "deportivo" written with an accented word elsewhere, or
// "envios" vs "envíos" - same class of bug fixed in catalog/faq.ts). Catalogs are small enough per
// business for this to be cheap.
export async function searchProducts(businessId: string, query: string) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return listActiveProducts(businessId);

  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    include: { media: true },
  });

  const matches = products
    .map((product) => ({ product, score: relevanceScore(tokens, product) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ product }) => product);

  return withFreshMediaUrls(matches);
}

export async function createProduct(
  businessId: string,
  data: {
    name: string;
    description: string;
    price: number;
    currency?: string;
    stock: number;
    category?: string;
  }
) {
  return prisma.product.create({ data: { ...data, businessId } });
}

export async function updateProduct(
  businessId: string,
  id: string,
  data: Partial<{
    name: string;
    description: string;
    price: number;
    currency: string;
    stock: number;
    category: string | null;
    active: boolean;
  }>
) {
  const product = await prisma.product.findFirst({ where: { id, businessId } });
  if (!product) throw new Error("Producto no encontrado");
  return prisma.product.update({ where: { id }, data });
}

export async function deleteProduct(businessId: string, id: string) {
  const product = await prisma.product.findFirst({ where: { id, businessId }, include: { media: true } });
  if (!product) throw new Error("Producto no encontrado");
  await Promise.all(product.media.map((m) => deleteMediaFromS3(m.s3Key)));
  return prisma.product.delete({ where: { id } });
}

export async function addProductMedia(
  businessId: string,
  productId: string,
  media: { type: "IMAGE" | "VIDEO"; url: string; s3Key: string }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, businessId } });
  if (!product) throw new Error("Producto no encontrado");
  return prisma.productMedia.create({
    data: { ...media, productId },
  });
}

export async function deleteProductMedia(businessId: string, mediaId: string) {
  const media = await prisma.productMedia.findFirst({
    where: { id: mediaId, product: { businessId } },
  });
  if (!media) throw new Error("Media no encontrada");
  await prisma.productMedia.delete({ where: { id: mediaId } });
  await deleteMediaFromS3(media.s3Key);
  return media;
}
