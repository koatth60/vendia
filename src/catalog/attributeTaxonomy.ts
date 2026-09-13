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

// Category taxonomy is NOT hardcoded here on purpose: "reloj" vs "smartwatch" (tech reseller) or "guineo"
// vs "banano" (fruit stand) means the same product type only WITHIN one vertical - there's no fixed
// dictionary that would generalize across every business Onix serves. That vocabulary lives per-business
// instead, in the CategoryAlias table (see prisma/schema.prisma), configured by each business in its own
// admin panel - `aliasMap` here is that business's own synonym->canonical lookup (normalizeForMatch'd
// keys), built by the caller (see findProductsByAttributes in products.ts) and passed in. With no
// aliasMap (or a word not in it), a word just matches itself, exactly as before this table existed - real
// bug this replaces (2026-09-13): a first attempt hardcoded "reloj"/"smartwatch" etc as a global synonym
// list here, which only ever helps electronics resellers and would need editing in code for every new
// vertical Onix sells into.
export function canonicalizeCategoryWord(word: string, aliasMap?: ReadonlyMap<string, string>): string {
  const normalized = normalizeForMatch(word).trim();
  let singular = normalized;
  if (singular.endsWith("es") && singular.length > 4) singular = singular.slice(0, -2);
  else if (singular.endsWith("s") && singular.length > 3) singular = singular.slice(0, -1);
  return aliasMap?.get(singular) ?? singular;
}
