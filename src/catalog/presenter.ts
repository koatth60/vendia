import { formatPrice } from "../config/money";
import type { ProductScope, ScopeMedia, ScopeProduct, ScopeVariant } from "./scope";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 2).
//
// Funciones PURAS: sin base de datos, sin red, sin modelo. Entran los productos ya acotados por
// resolveProductScope y sale la lista ordenada de mensajes que el servidor va a enviar tal cual. El
// modelo no escribe ni un nombre ni un precio de estos bloques: solo la frase que los introduce.

/** Fotos/videos que viajan pegados a un bloque, ya resueltos por el alcance. */
export interface CatalogBlockMedia {
  productId: string;
  /** Etiqueta con la que se graba cada envio (`[Foto de X]`), variante incluida cuando la hay. */
  productName: string;
  items: ScopeMedia[];
}

/** Un bloque = un mensaje de WhatsApp. Sale literal: nadie lo reescribe despues. */
export interface CatalogBlock {
  text: string;
  media: CatalogBlockMedia[];
  /** Ids de producto que este bloque nombra, en el orden en que aparecen numerados. */
  productIds: string[];
}

export interface RenderCatalogOptions {
  currency: string;
  locale: string;
  /**
   * Orden de categorias preferido (nombre tal cual esta en Product.category, sin normalizar). Las
   * categorias que no figuren salen despues, en el orden en que aparecen los productos de entrada.
   */
  categoryOrder?: string[];
  /** Encabezado para los productos sin categoria cargada. */
  uncategorizedLabel?: string;
}

/**
 * El umbral de "pocos productos": con esta cantidad o menos las fotos salen SOLAS, en el mismo turno.
 * Con mas, la lista va numerada y se ofrece elegir. Vive aca, en un solo lugar, a proposito.
 */
export const FEW_PRODUCTS_MAX = 2;

/**
 * Tope de lineas por mensaje. El corte natural es la categoria (por eso el catalogo completo sale como
 * un mensaje por categoria y no partido a los 700 caracteres), pero una categoria con decenas de
 * productos igual necesita un corte: se parte en mensajes de continuacion CONSERVANDO la numeracion,
 * nunca reiniciandola.
 */
const MAX_LINES_PER_BLOCK = 12;

const PHOTO_OFFER_LINE = "¿De cuál te gustaría ver fotos?";

const DEFAULT_UNCATEGORIZED_LABEL = "Otros productos";

function priceLine(product: ScopeProduct, opts: RenderCatalogOptions): string {
  return `$${formatPrice(product.price, product.currency || opts.currency, opts.locale)}`;
}

function stockSuffix(stock: number): string {
  return stock > 0 ? ` (${stock} disponibles)` : " (sin stock)";
}

function variantLabel(variant: ScopeVariant): string | null {
  const parts = [variant.color, variant.size].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * Los medios de un producto en alcance. Con variante elegida (el cliente nombro un color), solo los de
 * esa variante, cayendo a los generales si esa variante no tiene propios - nunca a los de OTRA variante,
 * que seria mandarle el color equivocado. Sin color nombrado se conserva el criterio actual de
 * send_product_media: los generales MAS los de todas las variantes.
 */
export function mediaForProduct(product: ScopeProduct, variant: ScopeVariant | null): ScopeMedia[] {
  if (variant) {
    return variant.media.length > 0 ? variant.media : product.media;
  }
  if (product.variants.length > 0) {
    return [...product.media, ...product.variants.flatMap((v) => v.media)];
  }
  return product.media;
}

function mediaBlockFor(product: ScopeProduct, variant: ScopeVariant | null): CatalogBlockMedia[] {
  const items = mediaForProduct(product, variant);
  if (items.length === 0) return [];
  const label = variant ? variantLabel(variant) : null;
  return [{ productId: product.id, productName: label ? `${product.name} (${label})` : product.name, items }];
}

/** La ficha de un producto puntual: sin numerar, porque no hay nada entre que elegir. */
function renderSingle(product: ScopeProduct, variant: ScopeVariant | null, opts: RenderCatalogOptions): CatalogBlock {
  const label = variant ? variantLabel(variant) : null;
  const title = label ? `*${product.name}* (${label})` : `*${product.name}*`;
  const stock = variant ? variant.stock : product.stock;
  const lines = [`${title} — ${priceLine(product, opts)}${stockSuffix(stock)}`];
  if (product.description.trim()) lines.push(product.description.trim());
  return { text: lines.join("\n"), media: mediaBlockFor(product, variant), productIds: [product.id] };
}

function groupByCategory(products: ScopeProduct[], opts: RenderCatalogOptions): { category: string | null; products: ScopeProduct[] }[] {
  const groups = new Map<string, { category: string | null; products: ScopeProduct[] }>();
  for (const product of products) {
    const key = product.category ?? "";
    const existing = groups.get(key);
    if (existing) existing.products.push(product);
    else groups.set(key, { category: product.category, products: [product] });
  }

  const preferred = opts.categoryOrder ?? [];
  const ordered = [...groups.values()];
  // Orden estable: primero las categorias declaradas en categoryOrder, en ESE orden; despues el resto
  // en el orden en que aparecieron los productos de entrada (que ya viene ordenado por la consulta).
  ordered.sort((a, b) => {
    const ia = a.category ? preferred.indexOf(a.category) : -1;
    const ib = b.category ? preferred.indexOf(b.category) : -1;
    if (ia === ib) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return ordered;
}

/**
 * Una lista numerada, partida en mensajes de a lo sumo MAX_LINES_PER_BLOCK lineas. `startNumber` es lo
 * que hace que la numeracion sea continua A TRAVES de los grupos: la directiva SELECCION POR NUMERO del
 * prompt depende de que el ultimo mensaje del bot sea una lista numerada, y si cada categoria
 * reiniciara en 1, "el 3" dejaria de resolver a un producto real.
 */
function renderNumberedGroup(
  heading: string | null,
  products: ScopeProduct[],
  startNumber: number,
  opts: RenderCatalogOptions
): CatalogBlock[] {
  const blocks: CatalogBlock[] = [];
  for (let offset = 0; offset < products.length; offset += MAX_LINES_PER_BLOCK) {
    const chunk = products.slice(offset, offset + MAX_LINES_PER_BLOCK);
    const lines = chunk.map(
      (product, i) => `${startNumber + offset + i}. *${product.name}* — ${priceLine(product, opts)}${stockSuffix(product.stock)}`
    );
    const text = heading && offset === 0 ? `*${heading}*\n${lines.join("\n")}` : lines.join("\n");
    blocks.push({ text, media: [], productIds: chunk.map((p) => p.id) });
  }
  return blocks;
}

/**
 * Convierte un alcance ya resuelto en los mensajes exactos que se envian. Nunca emite un producto que no
 * venga en la entrada, y las fotos se deciden por el alcance, no por el criterio del modelo:
 *
 *   one / few  -> los medios salen JUNTO con el mensaje, mismo turno. No se ofrece, no se pregunta.
 *   group/all  -> no se mandan medios. Lista numerada y se ofrece elegir.
 */
export function renderCatalog(scope: ProductScope, opts: RenderCatalogOptions): CatalogBlock[] {
  if (scope.kind === "none") return [];

  if (scope.kind === "one") {
    return [renderSingle(scope.product, scope.variant ?? null, opts)];
  }

  if (scope.kind === "few") {
    // Hasta FEW_PRODUCTS_MAX productos: una ficha por producto, cada una con sus fotos. No se numeran
    // ni se ofrece elegir - ya los tiene todos delante.
    return scope.products.map((product) => renderSingle(product, null, opts));
  }

  const groups =
    scope.kind === "group"
      ? [{ category: scope.category, products: scope.products }]
      : groupByCategory(scope.products, opts);

  const blocks: CatalogBlock[] = [];
  let next = 1;
  for (const group of groups) {
    // Con una sola categoria el encabezado repetiria lo que el cliente acaba de preguntar; con varias
    // es lo que separa un mensaje del siguiente.
    const heading = groups.length > 1 ? group.category ?? (opts.uncategorizedLabel ?? DEFAULT_UNCATEGORIZED_LABEL) : null;
    const rendered = renderNumberedGroup(heading, group.products, next, opts);
    next += group.products.length;
    blocks.push(...rendered);
  }

  if (blocks.length > 0) {
    // El ofrecimiento va UNA vez, pegado al ultimo mensaje: es la pregunta con la que termina el turno.
    const last = blocks[blocks.length - 1];
    blocks[blocks.length - 1] = { ...last, text: `${last.text}\n\n${PHOTO_OFFER_LINE}` };
  }

  return blocks;
}

/** Los ids que el cliente realmente vio, en orden: es contra esto que se resuelve "el 3" del proximo turno. */
export function presentedProductIds(blocks: CatalogBlock[]): string[] {
  return blocks.flatMap((b) => b.productIds);
}

/**
 * Le quita a la frase del modelo cualquier linea que sea una lista numerada. Cuando el servidor ya
 * compuso los bloques, una lista en la introduccion es, en el mejor caso, la misma informacion dos
 * veces, y en el peor la version inventada de la lista real que sale abajo.
 *
 * Sin expresion regular (regla del repositorio): se mira caracter por caracter si la linea arranca con
 * digitos seguidos de "." o ")" y un espacio, que es la forma exacta que produce renderCatalog.
 */
export function stripNumberedLines(text: string): string {
  const kept = text.split("\n").filter((line) => !startsAsNumberedItem(line.trim()));
  return kept.join("\n").trim();
}

export function startsAsNumberedItem(line: string): boolean {
  let i = 0;
  while (i < line.length && line[i] >= "0" && line[i] <= "9") i++;
  if (i === 0) return false;
  if (line[i] !== "." && line[i] !== ")") return false;
  return line[i + 1] === " ";
}
