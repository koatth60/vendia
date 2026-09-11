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

  // Tie-break by id so results are deterministic across calls - without it, two products scoring
  // equally kept whatever order Postgres happened to return them in for that particular query, which
  // is not guaranteed stable. That let the same customer text resolve to a different top match on a
  // later turn (e.g. the text-based re-search inside send_product_media landing on a different product
  // than the one the model had just described).
  const matches = products
    .map((product) => ({ product, score: relevanceScore(tokens, product) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id))
    .map(({ product }) => product);

  return withFreshMediaUrls(matches);
}

// Below this score, the only evidence for a match is a single incidental word shared with the
// description (weight 1) - not enough to safely act on (send real photos, record a real order line).
// A hit on the product's name or category (weight 2-3) is required to trust a single-best-guess pick.
const MIN_CONFIDENT_SCORE = 2;

export interface ProductMatchResult<T> {
  product: T | null;
  ambiguous: boolean;
  candidates?: string[];
}

// Used by code paths that commit to ONE product picked by fuzzy text (sending real WhatsApp media,
// resolving an order line) instead of showing the customer/model a list to judge by meaning
// (search_products stays loose on purpose for that). Refuses to guess when the evidence is too weak
// (MIN_CONFIDENT_SCORE) or tied between two+ products - both cases previously fell through to
// `matches[0]`, which could silently pick an unrelated product on a single shared generic word (e.g.
// "correa"/"negro" appearing in both a headphones and a smartwatch description).
export async function findConfidentProductMatch(
  businessId: string,
  query: string
): Promise<ProductMatchResult<Awaited<ReturnType<typeof getProductById>>>> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { product: null, ambiguous: false };

  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    include: { media: true },
  });

  const scored = products
    .map((product) => ({ product, score: relevanceScore(tokens, product) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));

  if (scored.length === 0) return { product: null, ambiguous: false };

  const [top, ...rest] = scored;
  if (top.score < MIN_CONFIDENT_SCORE) return { product: null, ambiguous: false };

  const tied = rest.filter((s) => s.score === top.score);
  if (tied.length > 0) {
    return { product: null, ambiguous: true, candidates: [top, ...tied].map((s) => s.product.name) };
  }

  const [withMedia] = await withFreshMediaUrls([top.product]);
  return { product: withMedia, ambiguous: false };
}

// Texto corto para darle contexto de negocio al prompt de vision (src/ai/vision.ts) - sin esto el
// modelo clasifica la imagen a ciegas, sin saber que buscar. Query liviana (sin media) porque se
// llama en cada mensaje con imagen/video, no solo cuando hace falta.
const MAX_CATALOG_HINT_ITEMS = 40;

export async function getCatalogHintText(businessId: string): Promise<string> {
  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    select: { name: true, category: true },
    take: MAX_CATALOG_HINT_ITEMS,
  });
  if (products.length === 0) return "";
  return products.map((p) => (p.category ? `${p.name} (categoria: ${p.category})` : p.name)).join(", ");
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
