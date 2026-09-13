import { tokenize, normalizeForMatch } from "../search/text";

// Colors are a closed, language-level vocabulary (unlike categories, which vary completely per
// business/vertical - see canonicalizeCategoryWord below for why those stay generic normalization
// instead of a fixed list). Some businesses describe a genuinely black product as "oscuro" instead of
// "negro" - a workaround for TikTok/Meta ad-content policies that can flag the literal word "negro" in
// some contexts - so both must resolve to the same bucket, or a customer asking for "reloj negro" would
// miss a product whose own description only ever says "oscuro".
const COLOR_SYNONYMS: Record<string, string[]> = {
  negro: ["negro", "negros", "negra", "negras", "oscuro", "oscura", "oscuros", "oscuras", "black"],
  blanco: ["blanco", "blancos", "blanca", "blancas", "white"],
  rojo: ["rojo", "rojos", "roja", "rojas", "red"],
  azul: ["azul", "azules", "blue"],
  verde: ["verde", "verdes", "green"],
  amarillo: ["amarillo", "amarillos", "amarilla", "amarillas", "yellow"],
  rosado: ["rosado", "rosados", "rosada", "rosadas", "rosa", "rosadito", "rosadita", "fucsia", "pink"],
  morado: ["morado", "morados", "morada", "moradas", "violeta", "lila", "purple"],
  naranja: ["naranja", "naranjas", "naranjado", "naranjada", "orange"],
  gris: ["gris", "grises", "plateado", "plateados", "plateada", "plateadas", "plata", "silver", "gray", "grey"],
  dorado: ["dorado", "dorados", "dorada", "doradas", "oro", "gold"],
  cafe: ["cafe", "cafes", "marron", "marrones", "chocolate", "brown", "beige"],
  multicolor: ["multicolor", "multicolores", "combinado", "combinados", "combinada", "combinadas"],
};

const COLOR_TOKEN_LOOKUP = new Map<string, string>();
for (const [canonical, synonyms] of Object.entries(COLOR_SYNONYMS)) {
  for (const synonym of synonyms) COLOR_TOKEN_LOOKUP.set(synonym, canonical);
}

// Returns the canonical color bucket(s) mentioned in text (tokenized, so "reloj negro y azul" -> both).
// Same function is meant to run on both the customer's query AND a product's own color/name/description,
// so two differently-worded mentions of the same real color still match each other.
export function canonicalColors(text: string): string[] {
  const found = new Set<string>();
  for (const token of tokenize(text)) {
    const canonical = COLOR_TOKEN_LOOKUP.get(token);
    if (canonical) found.add(canonical);
  }
  return [...found];
}

// Full category taxonomy is NOT hardcoded here on purpose: "reloj" vs "camisa" vs "torta" varies
// completely per business/vertical, so there's no fixed dictionary that would generalize across "muchos
// tipos de negocios" - the real vocabulary always comes from that business's own catalog data. This
// small map is different: it's the handful of near-universal Spanish-electronics synonym pairs a single
// business uses INTERCHANGEABLY for its own products (same shape as COLOR_SYNONYMS above, not a business
// taxonomy) - real bug (2026-09-13): one business categorized some watches "Relojes Inteligentes
// (Smartwatches)" and others "smartwatch" with no "reloj" word at all, so a customer's "reloj negro"
// silently excluded the second group even after the plural/accent folding below already worked correctly.
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  reloj: ["reloj", "smartwatch", "smartwatches"],
  audifono: ["audifono", "auricular", "auriculares", "airpod", "airpods", "earbud", "earbuds"],
  parlante: ["parlante", "bocina", "altavoz", "altavoces", "speaker", "speakers"],
  celular: ["celular", "telefono", "movil", "phone", "smartphone"],
};
const CATEGORY_SYNONYM_LOOKUP = new Map<string, string>();
for (const [canonical, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
  for (const synonym of synonyms) CATEGORY_SYNONYM_LOOKUP.set(synonym, canonical);
}

// Folds simple singular/plural + accent variance ("relojes" -> "reloj", "camisetas" -> "camiseta") so a
// business's own Product.category values match regardless of how the customer pluralizes or accents it,
// THEN folds the handful of synonym pairs above so equivalent words used inconsistently across a
// business's own catalog land in the same bucket.
export function canonicalizeCategoryWord(word: string): string {
  const normalized = normalizeForMatch(word).trim();
  let singular = normalized;
  if (singular.endsWith("es") && singular.length > 4) singular = singular.slice(0, -2);
  else if (singular.endsWith("s") && singular.length > 3) singular = singular.slice(0, -1);
  return CATEGORY_SYNONYM_LOOKUP.get(singular) ?? singular;
}
