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

// Category vocabulary is NOT hardcoded here on purpose: "reloj" vs "camisa" vs "torta" varies completely
// per business/vertical, so there's no fixed dictionary that would generalize across "muchos tipos de
// negocios". Instead this folds simple singular/plural + accent variance ("relojes" -> "reloj",
// "camisetas" -> "camiseta") so a business's own Product.category values match regardless of how the
// customer pluralizes or accents it - the real vocabulary always comes from that business's actual
// catalog data, never a list maintained here.
export function canonicalizeCategoryWord(word: string): string {
  const normalized = normalizeForMatch(word).trim();
  if (normalized.endsWith("es") && normalized.length > 4) return normalized.slice(0, -2);
  if (normalized.endsWith("s") && normalized.length > 3) return normalized.slice(0, -1);
  return normalized;
}
