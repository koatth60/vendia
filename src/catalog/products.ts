import { prisma } from "../db/client";
import { getPresignedMediaUrl, deleteMedia as deleteMediaFromS3 } from "../media/s3";

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

const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o",
  "que", "con", "para", "por", "en", "del", "al", "es", "son", "hay",
  "tienen", "tiene", "tienes", "algo", "algun", "alguna", "quiero", "busco",
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && (word.length > 2 || /^\d+$/.test(word)) && !STOPWORDS.has(word));
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
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

export async function searchProducts(businessId: string, query: string) {
  const tokens = tokenize(query);

  if (tokens.length === 0) {
    return listActiveProducts(businessId);
  }

  const orConditions = tokens.flatMap((token) => [
    { name: { contains: token, mode: "insensitive" as const } },
    { description: { contains: token, mode: "insensitive" as const } },
    { category: { contains: token, mode: "insensitive" as const } },
  ]);

  const products = await prisma.product.findMany({
    where: { businessId, active: true, OR: orConditions },
    include: { media: true },
  });

  products.sort((a, b) => relevanceScore(tokens, b) - relevanceScore(tokens, a));

  return withFreshMediaUrls(products);
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
