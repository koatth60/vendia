import { prisma } from "../db/client";
import { getPresignedMediaUrl, deleteMedia as deleteMediaFromS3 } from "../media/s3";
import { tokenize, normalizeForMatch } from "../search/text";
import { canonicalColors, canonicalizeCategoryWord } from "./attributeTaxonomy";

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

// Variants carry their own media array (see ProductVariant in schema.prisma) - re-signs those S3 URLs
// too, same as withFreshMediaUrls does for the product-level media array.
async function withFreshVariantMediaUrls<T extends { variants: { media: { s3Key: string; url: string }[] }[] }>(
  products: T[]
): Promise<T[]> {
  for (const product of products) {
    for (const variant of product.variants) {
      for (const media of variant.media) {
        media.url = await getPresignedMediaUrl(media.s3Key);
      }
    }
  }
  return products;
}

// `media: true` here would relate purely on productId and return EVERY photo the product has,
// including ones that belong to a specific variant (ProductMedia.variantId is just an extra column,
// not part of the relation match) - every caller of product.media (send_product_media's fallback,
// formatProduct, the admin panel's gallery, detect-colors) treats it as "the general/fallback photos
// only", so it has to actually be scoped that way, or a variant's own photo silently gets treated as
// general too (double-counted in the admin gallery, and worse, offered as the fallback for an
// UNRELATED color that has no photo of its own - reported directly as duplicated photos in the admin
// panel, 2026-09-13).
const PRODUCT_INCLUDE = { media: { where: { variantId: null } }, variants: { include: { media: true } } } as const;

export async function listActiveProducts(businessId: string) {
  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    include: PRODUCT_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  await withFreshVariantMediaUrls(products);
  return withFreshMediaUrls(products);
}

export async function listAllProducts(businessId: string) {
  const products = await prisma.product.findMany({
    where: { businessId },
    include: PRODUCT_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  await withFreshVariantMediaUrls(products);
  return withFreshMediaUrls(products);
}

export async function getProductById(businessId: string, id: string) {
  const product = await prisma.product.findFirst({
    where: { id, businessId },
    include: PRODUCT_INCLUDE,
  });
  if (!product) return null;
  const [withVariantMedia] = await withFreshVariantMediaUrls([product]);
  const [withMedia] = await withFreshMediaUrls([withVariantMedia]);
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
    include: PRODUCT_INCLUDE,
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

  await withFreshVariantMediaUrls(matches);
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
    include: PRODUCT_INCLUDE,
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

  const [withVariantMedia] = await withFreshVariantMediaUrls([top.product]);
  const [withMedia] = await withFreshMediaUrls([withVariantMedia]);
  return { product: withMedia, ambiguous: false };
}

export interface AttributeMatch {
  productId: string;
  productName: string;
  category: string | null;
  // Set when this match is one specific color/size option of a multi-variant product (see
  // ProductVariant in schema.prisma) - null means the whole product matched (the simple single-
  // color/size case, or a category-only query with no color given).
  variantId: string | null;
  variantLabel: string | null;
  price: string;
  currency: string;
  stock: number;
  mediaCount: number;
}

function formatVariantLabel(color: string | null | undefined, size: string | null | undefined): string | null {
  const parts = [color, size].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(" / ") : null;
}

// The deterministic replacement for "reloj negro also matches headphones and every other color" (real
// production bug, 2026-09-12): unlike searchProducts' scored keyword soup, this FILTERS - a color given
// must actually match (via canonicalColors, so "negro"/"oscuro" are the same bucket - see
// attributeTaxonomy.ts for why), a category given must actually match. A product with variants
// contributes one result PER matching variant (so "reloj negro" on a product with red/black/blue variants
// returns only the black one, with only that color's own photos), never the whole product blindly.
export async function findProductsByAttributes(
  businessId: string,
  attrs: { category?: string; color?: string; freeText?: string }
): Promise<{ matches: AttributeMatch[]; categoriesFound: string[] }> {
  const targetColors = new Set([...canonicalColors(attrs.color ?? ""), ...canonicalColors(attrs.freeText ?? "")]);
  const targetCategory = attrs.category ? canonicalizeCategoryWord(attrs.category) : null;

  // Neither a real color nor a real category to filter by - falling through would return the entire
  // catalog, which is just listActiveProducts under a different name and invites the same "blast
  // everything" failure this tool exists to prevent. Refuse instead of guessing.
  if (targetColors.size === 0 && !targetCategory) {
    return { matches: [], categoriesFound: [] };
  }

  const products = await prisma.product.findMany({
    where: { businessId, active: true },
    include: PRODUCT_INCLUDE,
  });

  const matches: AttributeMatch[] = [];

  for (const product of products) {
    if (targetCategory) {
      // A business's real category is free text, often compound ("Tecnología / Relojes Inteligentes
      // (Smartwatches)") - comparing the whole string against a single target word ("reloj") after
      // singularizing never matched anything real (confirmed 2026-09-13: this silently returned zero
      // matches for every category-scoped color search on this exact shape, which is why "reloj negro"
      // kept falling back to search_products' full-catalog dump instead of the real filtered list).
      // Match if the target word is one of the category string's own words instead.
      const categoryWords = product.category ? tokenize(product.category).map(canonicalizeCategoryWord) : [];
      if (!categoryWords.includes(targetCategory)) continue;
    }

    if (product.variants.length > 0) {
      for (const variant of product.variants) {
        if (!variant.active) continue;
        if (targetColors.size > 0) {
          const variantColors = variant.color ? canonicalColors(variant.color) : [];
          if (!variantColors.some((c) => targetColors.has(c))) continue;
        }
        const media = variant.media.length > 0 ? variant.media : product.media;
        matches.push({
          productId: product.id,
          productName: product.name,
          category: product.category,
          variantId: variant.id,
          variantLabel: formatVariantLabel(variant.color, variant.size),
          price: product.price.toString(),
          currency: product.currency,
          stock: variant.stock,
          mediaCount: media.length,
        });
      }
      continue;
    }

    if (targetColors.size > 0) {
      const productColors = canonicalColors(`${product.color ?? ""} ${product.name} ${product.description}`);
      if (!productColors.some((c) => targetColors.has(c))) continue;
    }
    matches.push({
      productId: product.id,
      productName: product.name,
      category: product.category,
      variantId: null,
      variantLabel: formatVariantLabel(product.color, product.size),
      price: product.price.toString(),
      currency: product.currency,
      stock: product.stock,
      mediaCount: product.media.length,
    });
  }

  const categoriesFound = [...new Set(matches.map((m) => m.category).filter((c): c is string => Boolean(c)))];
  return { matches, categoriesFound };
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
    color?: string;
    size?: string;
    // Lets the admin panel build a product's color/size variants in the same form before the product
    // exists yet, instead of forcing a save-then-edit-the-card round trip just because a
    // ProductVariant row needs a real productId to attach to (Prisma's nested create handles that in
    // one insert - the owner never has to see or wait for two separate steps).
    variants?: { color?: string; size?: string; stock: number }[];
  }
) {
  const { variants, ...productData } = data;
  return prisma.product.create({
    data: {
      ...productData,
      businessId,
      ...(variants && variants.length > 0 ? { variants: { create: variants } } : {}),
    },
    include: PRODUCT_INCLUDE,
  });
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
    color: string | null;
    size: string | null;
    active: boolean;
  }>
) {
  const product = await prisma.product.findFirst({ where: { id, businessId } });
  if (!product) throw new Error("Producto no encontrado");
  return prisma.product.update({ where: { id }, data });
}

export async function deleteProduct(businessId: string, id: string) {
  const product = await prisma.product.findFirst({
    where: { id, businessId },
    include: PRODUCT_INCLUDE,
  });
  if (!product) throw new Error("Producto no encontrado");
  const variantMediaKeys = product.variants.flatMap((v) => v.media.map((m) => m.s3Key));
  await Promise.all([...product.media, ...variantMediaKeys.map((s3Key) => ({ s3Key }))].map((m) => deleteMediaFromS3(m.s3Key)));
  return prisma.product.delete({ where: { id } });
}

export async function addProductMedia(
  businessId: string,
  productId: string,
  media: { type: "IMAGE" | "VIDEO"; url: string; s3Key: string },
  variantId?: string
) {
  const product = await prisma.product.findFirst({ where: { id: productId, businessId } });
  if (!product) throw new Error("Producto no encontrado");
  if (variantId) {
    const variant = await prisma.productVariant.findFirst({ where: { id: variantId, productId } });
    if (!variant) throw new Error("Variante no encontrada");
  }
  return prisma.productMedia.create({
    data: { ...media, productId, variantId },
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

// Moves an ALREADY-UPLOADED photo/video between "general" (variantId null, the fallback every
// variant without its own media uses) and one specific variant, or between two variants - a re-point
// of the existing S3 object's owner row, never a re-upload. Added because the admin panel used to force
// re-uploading the same file into a variant's own slot even when the exact photo already existed as a
// general product photo, duplicating both the upload effort and the S3 storage for zero reason.
export async function assignProductMedia(businessId: string, mediaId: string, variantId: string | null) {
  const media = await prisma.productMedia.findFirst({
    where: { id: mediaId, product: { businessId } },
  });
  if (!media) throw new Error("Media no encontrada");
  if (variantId) {
    const variant = await prisma.productVariant.findFirst({ where: { id: variantId, productId: media.productId } });
    if (!variant) throw new Error("Variante no encontrada");
  }
  return prisma.productMedia.update({ where: { id: mediaId }, data: { variantId } });
}

// Variants are the opt-in layer for a product sold in several colors/sizes under one name (see
// ProductVariant in schema.prisma) - a product with none behaves exactly as it did before this existed.
export async function createProductVariant(
  businessId: string,
  productId: string,
  data: { color?: string; size?: string; stock: number }
) {
  const product = await prisma.product.findFirst({ where: { id: productId, businessId } });
  if (!product) throw new Error("Producto no encontrado");
  return prisma.productVariant.create({ data: { ...data, productId } });
}

export async function updateProductVariant(
  businessId: string,
  variantId: string,
  data: Partial<{ color: string | null; size: string | null; stock: number; active: boolean }>
) {
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, product: { businessId } } });
  if (!variant) throw new Error("Variante no encontrada");
  return prisma.productVariant.update({ where: { id: variantId }, data });
}

export async function deleteProductVariant(businessId: string, variantId: string) {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, product: { businessId } },
    include: { media: true },
  });
  if (!variant) throw new Error("Variante no encontrada");
  await Promise.all(variant.media.map((m) => deleteMediaFromS3(m.s3Key)));
  return prisma.productVariant.delete({ where: { id: variantId } });
}
