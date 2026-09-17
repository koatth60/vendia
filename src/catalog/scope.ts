import { prisma } from "../db/client";
import { tokenize, normalizeForMatch } from "../search/text";
import { canonicalColors, canonicalizeCategoryWord } from "./attributeTaxonomy";
import { MIN_CONFIDENT_SCORE, relevanceScore, loadCategoryAliasMap, getProductById } from "./products";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 1).
//
// Decide EN CODIGO de que trata el turno, usando solo datos reales del negocio. Hasta esta fase no
// existia ninguna funcion que recibiera el mensaje del cliente y devolviera "estos productos": todo
// pasaba por el modelo, asi que un turno donde el modelo no llamaba ninguna herramienta podia listar
// productos que no existen (medido en produccion el 2026-09-15).
//
// Regla del repositorio: cero expresiones regulares nuevas. Todo lo de aca se apoya en tokenize,
// normalizeForMatch, canonicalColors, canonicalizeCategoryWord, CategoryAlias y relevanceScore, que ya
// existian.

export interface ScopeMedia {
  type: string;
  url: string;
  s3Key: string;
}

export interface ScopeVariant {
  id: string;
  color: string | null;
  size: string | null;
  active: boolean;
  stock: number;
  media: ScopeMedia[];
}

export interface ScopeProduct {
  id: string;
  name: string;
  description: string;
  category: string | null;
  color: string | null;
  size: string | null;
  price: number | { toString(): string };
  currency: string;
  stock: number;
  media: ScopeMedia[];
  variants: ScopeVariant[];
}

export type ProductScope =
  | { kind: "one"; product: ScopeProduct; variant?: ScopeVariant | null }
  | { kind: "few"; products: ScopeProduct[] }
  | { kind: "group"; category: string; products: ScopeProduct[] }
  | { kind: "all"; products: ScopeProduct[] }
  | { kind: "none" };

/** Ver FEW_PRODUCTS_MAX en presenter.ts: el umbral vive alla, este modulo solo lo consume. */
import { FEW_PRODUCTS_MAX } from "./presenter";

// Las mismas listas que ya usaba looksLikeCatalogRequest en agent.ts. Viven aca porque el alcance es
// ahora quien decide, y agent.ts pasa a importarlas de este modulo en vez de tener su propia copia.
const CATALOG_REQUEST_WORDS = new Set([
  "catalogo", "catalogos", "lista", "listado", "productos", "inventario", "portafolio", "mercancia",
  "articulos", "surtido",
]);

const CATALOG_REQUEST_PHRASES = [
  "que tienen", "que tienes", "que tenes", "que hay", "que venden", "que vendes", "que manejan",
  "que manejas", "que ofrecen",
];

export function looksLikeCatalogRequest(text: string): boolean {
  if (tokenize(text).some((word) => CATALOG_REQUEST_WORDS.has(word))) return true;
  const normalized = normalizeForMatch(text);
  return CATALOG_REQUEST_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * Los numeros que el cliente escribio, si el mensaje es SOLO numeros una vez tokenizado ("el 3", "el 2
 * y el 5"). Sin expresion regular: tokenize ya deja pasar los tokens de puros digitos, y aca se
 * confirma que el token entero sea el numero. La restriccion de que TODOS los tokens sean numeros es lo
 * que separa "el 3" de "tengo 3 hijos" sin leer la prosa.
 */
export function numericSelection(customerText: string): number[] {
  const tokens = tokenize(customerText);
  if (tokens.length === 0) return [];
  const numbers: number[] = [];
  for (const token of tokens) {
    const value = Number(token);
    if (!Number.isInteger(value) || String(value) !== token) return [];
    numbers.push(value);
  }
  return numbers;
}

/**
 * La variante que corresponde cuando el cliente nombro un color ("el Serie 11 Mini negro"). Sin color
 * nombrado devuelve null, que es lo que le dice al presentador que mande los medios generales mas los
 * de todas las variantes (el criterio actual de send_product_media, conservado).
 */
function pickVariant(product: ScopeProduct, customerText: string): ScopeVariant | null {
  const wanted = new Set(canonicalColors(customerText));
  if (wanted.size === 0) return null;
  return (
    product.variants.find((variant) => {
      if (!variant.active) return false;
      return canonicalColors(variant.color ?? "").some((color) => wanted.has(color));
    }) ?? null
  );
}

/**
 * El match confiable por texto, en memoria. Misma puntuacion y mismo umbral que
 * findConfidentProductMatch (products.ts) - se comparte relevanceScore y MIN_CONFIDENT_SCORE en vez de
 * escribir una segunda regla de coincidencia que despues se desincronice. Un empate no elige: devuelve
 * null y el alcance sigue bajando a categoria, que es mas honesto que adivinar.
 *
 * Exige ADEMAS que el cliente haya usado una palabra del NOMBRE del producto. Sin ese requisito,
 * "tienen smartwatches?" resolvia a UN producto puntual (ganaba por una palabra suelta de su
 * descripcion) en vez de a la categoria que el cliente realmente pidio. La distincion es estructural:
 * una categoria configurada es un dato real del negocio, un puntaje por palabras sueltas de la
 * descripcion es una conjetura, y una conjetura no le gana a un dato.
 */
function confidentMatch(
  products: ScopeProduct[],
  tokens: string[],
  aliasMap: ReadonlyMap<string, string>,
  categoryWords: ReadonlySet<string>
): ScopeProduct | null {
  if (tokens.length === 0) return null;
  const scored = products
    .map((product) => ({
      product,
      score: relevanceScore(tokens, product, aliasMap),
      nameHit: namedInText(product, tokens, aliasMap, categoryWords),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));

  if (scored.length === 0) return null;
  const [top, ...rest] = scored;
  if (top.score < MIN_CONFIDENT_SCORE) return null;
  if (!top.nameHit) return null;
  if (rest.some((s) => s.score === top.score)) return null;
  return top.product;
}

/**
 * True cuando el cliente escribio, tal cual, una palabra del nombre del producto que NO sea ademas una
 * palabra de categoria de ese negocio.
 *
 * La exclusion importa: el catalogo real de MAGByLizN tiene un producto llamado "Audífonos Bluetooth con
 * parlante integrado", asi que "y que audifonos tienen?" - una pregunta por categoria - ganaba por
 * nombre contra ESE producto y le tapaba los siete de la categoria audifonos. Una palabra que el propio
 * negocio usa como categoria es vocabulario de categoria, no lo que distingue a un producto de otro.
 */
function namedInText(
  product: ScopeProduct,
  tokens: string[],
  aliasMap: ReadonlyMap<string, string>,
  categoryWords: ReadonlySet<string>
): boolean {
  const nameTokens = new Set(tokenize(product.name));
  return tokens.some(
    (t) => !isDigitsOnly(t) && nameTokens.has(t) && !categoryWords.has(canonicalizeCategoryWord(t, aliasMap))
  );
}

/**
 * Un numero suelto NUNCA identifica un producto por nombre.
 *
 * Defecto real de produccion (2026-09-16, turno 19:02:06). El servidor le habia presentado al cliente una
 * lista numerada de 7 audifonos y el cliente contesto "El número 5 y el número 6". Como el mensaje trae
 * la palabra "numero", numericSelection no lo toma (exige que TODOS los tokens sean numeros), asi que
 * bajo al match por texto - y ahi el token "6" coincidio con el nombre del producto *Parlante Charge 6*.
 * El alcance quedo en `one:Parlante Charge 6` y al cliente le salieron la ficha y las fotos de un
 * parlante mientras el agente le escribia, en el mismo turno, la comparacion de los dos audifonos.
 *
 * La exclusion es estructural y vale para cualquier catalogo, no para uno: los digitos de un nombre
 * ("Charge 6", "Serie 12", "Gen 9", "V20") son numero de modelo, y el cliente que escribe un numero
 * suelto casi siempre esta senalando una posicion de la ultima lista que vio - que es lo que resuelve
 * lastPresentedList, con ids reales, sin adivinar. Sacarle el digito a esta funcion no le quita nada:
 * para que un producto gane por nombre tiene que quedar una palabra de verdad ("serie", "charge",
 * "bombox"), que es lo que de veras lo distingue de los otros.
 */
function isDigitsOnly(token: string): boolean {
  const value = Number(token);
  return Number.isInteger(value) && String(value) === token;
}

/** Todas las palabras de categoria REALES de este negocio, canonizadas con sus propios alias. */
function categoryVocabulary(products: ScopeProduct[], aliasMap: ReadonlyMap<string, string>): Set<string> {
  const words = new Set<string>();
  for (const product of products) {
    if (!product.category) continue;
    for (const word of tokenize(product.category)) words.add(canonicalizeCategoryWord(word, aliasMap));
  }
  return words;
}

/**
 * La categoria configurada que el cliente nombro, si nombro alguna. Es la version "cual" de
 * textMentionsConfiguredCategory (que solo devuelve un booleano): se canonizan las palabras de
 * Product.category con los alias del propio negocio y se busca cual de ellas aparece en el mensaje.
 * Nunca un vocabulario cableado por vertical.
 */
function matchCategory(
  products: ScopeProduct[],
  tokens: string[],
  aliasMap: ReadonlyMap<string, string>
): { category: string; products: ScopeProduct[] } | null {
  if (tokens.length === 0) return null;
  const asked = new Set(tokens.map((t) => canonicalizeCategoryWord(t, aliasMap)));

  // Una categoria real puede ser compuesta ("Tecnología / Relojes Inteligentes (Smartwatches)"), asi
  // que se compara palabra por palabra, igual que findProductsByAttributes.
  const hits = new Map<string, ScopeProduct[]>();
  for (const product of products) {
    if (!product.category) continue;
    const words = tokenize(product.category).map((w) => canonicalizeCategoryWord(w, aliasMap));
    if (!words.some((w) => asked.has(w))) continue;
    const bucket = hits.get(product.category);
    if (bucket) bucket.push(product);
    else hits.set(product.category, [product]);
  }
  if (hits.size === 0) return null;

  // Varias categorias reales pueden compartir la palabra que se pidio ("Tecnologia (Audifonos)" y
  // "Tecnologia (Smartwatch)" ante "tecnologia"): se muestran todas juntas bajo la palabra que el
  // cliente uso, no una elegida al azar.
  if (hits.size === 1) {
    const [category, matched] = [...hits.entries()][0];
    return { category, products: matched };
  }
  const merged = [...hits.values()].flat();
  const label = [...hits.keys()].sort()[0];
  return { category: label, products: merged };
}

/**
 * El nucleo PURO: mismo catalogo en memoria, misma decision, sin base de datos ni red. La version
 * async de abajo es la que lee el catalogo real; esta es la que se prueba.
 *
 * Orden de resolucion, de lo mas especifico a lo mas general:
 *   1. "el 3" contra la ultima lista que se le envio de verdad (nunca adivinando).
 *   2. un producto nombrado, con match confiable (mismo umbral que send_product_media).
 *   3. una categoria configurada del negocio.
 *   4. un pedido de catalogo completo.
 *   5. nada: no es un turno de presentacion y el modelo responde como hasta hoy.
 */
export function resolveProductScopeFrom(
  products: ScopeProduct[],
  aliasMap: ReadonlyMap<string, string>,
  customerText: string,
  lastPresentedList: string[] = []
): ProductScope {
  if (!customerText.trim() || products.length === 0) return { kind: "none" };

  const byId = new Map(products.map((p) => [p.id, p]));

  const numbers = numericSelection(customerText);
  if (numbers.length > 0 && lastPresentedList.length > 0) {
    const chosen: ScopeProduct[] = [];
    for (const n of numbers) {
      const id = lastPresentedList[n - 1];
      const product = id ? byId.get(id) : undefined;
      if (product && !chosen.includes(product)) chosen.push(product);
    }
    if (chosen.length === 1) return { kind: "one", product: chosen[0], variant: pickVariant(chosen[0], customerText) };
    if (chosen.length > 1 && chosen.length <= FEW_PRODUCTS_MAX) return { kind: "few", products: chosen };
    // Mas numeros que el umbral de "pocos" no es una eleccion, es otra lista: la resuelve el modelo.
    if (chosen.length > FEW_PRODUCTS_MAX) return { kind: "none" };
  }

  const tokens = tokenize(customerText);

  const categoryWords = categoryVocabulary(products, aliasMap);

  const named = confidentMatch(products, tokens, aliasMap, categoryWords);
  if (named) return { kind: "one", product: named, variant: pickVariant(named, customerText) };

  const category = matchCategory(products, tokens, aliasMap);
  if (category) {
    // Con un solo producto en la categoria no hay nada que elegir: preguntarle "¿de cual querés ver
    // fotos?" ante una lista de uno no tiene sentido, asi que se trata como producto puntual y las
    // fotos salen solas. Con dos o mas sigue siendo un grupo, aunque sean pocos: el cliente pregunto
    // por una categoria, no por un producto, y lo que corresponde es que elija.
    if (category.products.length === 1) {
      const only = category.products[0];
      return { kind: "one", product: only, variant: pickVariant(only, customerText) };
    }
    return { kind: "group", category: category.category, products: category.products };
  }

  if (looksLikeCatalogRequest(customerText)) return { kind: "all", products };

  return { kind: "none" };
}

const SCOPE_PRODUCT_SELECT = {
  id: true,
  name: true,
  description: true,
  category: true,
  color: true,
  size: true,
  price: true,
  currency: true,
  stock: true,
  media: { where: { variantId: null }, select: { type: true, url: true, s3Key: true } },
  variants: {
    select: { id: true, color: true, size: true, active: true, stock: true, media: { select: { type: true, url: true, s3Key: true } } },
  },
} as const;

/**
 * La version con base de datos. Lee el catalogo activo SIN volver a firmar las URLs de S3 (una firma por
 * foto en cada turno seria caro y casi siempre inutil): las URLs frescas se resuelven despues, y solo
 * para los productos que realmente van a salir con fotos - ver withSignedMedia.
 */
export async function resolveProductScope(
  businessId: string,
  customerText: string,
  lastPresentedList: string[] = []
): Promise<ProductScope> {
  if (!customerText.trim()) return { kind: "none" };

  const [products, aliasMap] = await Promise.all([
    prisma.product.findMany({
      where: { businessId, active: true },
      select: SCOPE_PRODUCT_SELECT,
      orderBy: { createdAt: "desc" },
    }),
    loadCategoryAliasMap(businessId),
  ]);

  return resolveProductScopeFrom(products as ScopeProduct[], aliasMap, customerText, lastPresentedList);
}

/**
 * Vuelve a leer con getProductById (que SI firma las URLs de S3) unicamente los productos cuyo alcance
 * manda fotos - uno o dos. Un alcance de grupo/catalogo completo no manda medios, asi que no paga nada
 * de esto.
 */
export async function withSignedMedia(businessId: string, scope: ProductScope): Promise<ProductScope> {
  if (scope.kind === "one") {
    const fresh = await getProductById(businessId, scope.product.id);
    if (!fresh) return scope;
    const product = fresh as unknown as ScopeProduct;
    const variant = scope.variant ? product.variants.find((v) => v.id === scope.variant?.id) ?? null : null;
    return { kind: "one", product, variant };
  }
  if (scope.kind === "few") {
    const fresh = await Promise.all(scope.products.map((p) => getProductById(businessId, p.id)));
    const products = fresh.filter((p): p is NonNullable<typeof p> => Boolean(p)) as unknown as ScopeProduct[];
    return products.length > 0 ? { kind: "few", products } : scope;
  }
  return scope;
}

/** Para el registro de AgentTurn y para el mensaje de contexto del modelo, sin volcar productos enteros. */
export function describeScope(scope: ProductScope): string {
  switch (scope.kind) {
    case "one":
      return `one:${scope.product.name}${scope.variant ? ` (${[scope.variant.color, scope.variant.size].filter(Boolean).join(" / ")})` : ""}`;
    case "few":
      return `few:${scope.products.map((p) => p.name).join(", ")}`;
    case "group":
      return `group:${scope.category} (${scope.products.length})`;
    case "all":
      return `all:${scope.products.length}`;
    default:
      return "none";
  }
}
