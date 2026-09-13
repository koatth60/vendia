import { test } from "node:test";
import assert from "node:assert/strict";
import { findMentionedProductsForMediaBackstop } from "./agent";

// Regression for a real production bug (2026-09-12): bot listed 4 numbered smartwatch options and asked
// which one the customer wanted; customer replied "Muestrame fotos" with no name at all (reasonable -
// they haven't seen any yet and can't name one sight-unseen). The bot's reply said "aqui te van las
// fotos" without naming a specific product either. The matching only scanned the current turn's
// customerText + bot reply, found zero product-name matches, and fell back to calling
// send_product_media with the raw customer text as if it were a product name - never matched anything,
// so nothing was actually sent while the bot's text falsely claimed it was. Fix: also scan the bot's
// PRIOR turn (where the 4 option names actually live) - a photo request with no name right after being
// shown several options should resolve to all of them, not a guess or a repeat clarifying question.

const PRODUCTS = [
  { name: "Smartwatch Serie 11 Mini", media: ["x"] },
  { name: "Smartwatch Serie 12 Ultra 3", media: ["x"] },
  { name: "Smartwatch Gen 9", media: ["x"] },
  { name: "Smartwatch V20 Caballero", media: ["x"] },
  { name: "Audifonos Bluetooth X", media: ["x"] },
];

test("finds all 4 recently-listed options when the customer asks for photos without naming one", () => {
  const priorAssistantTurn =
    "Tenemos varios smartwatches en negro, ¿me confirmas cuál de estos te interesa?\n\n1. Serie 11 Mini — $145.000\n2. Serie 12 Ultra 3 — $140.000\n3. Smartwatch Gen 9 — $85.000\n4. Smartwatch V20 Caballero — $140.000";
  const currentReply = "¡Claro! Aquí te van las fotos de los smartwatches. ¿Alguno te llama más la atención?";
  const haystack = `Muestrame fotos ${currentReply} ${priorAssistantTurn}`;

  const matched = findMentionedProductsForMediaBackstop(PRODUCTS, haystack);

  assert.equal(matched.length, 4, "must find all 4 listed smartwatches, not zero");
  assert.ok(matched.every((p) => p.name.includes("Smartwatch") || p.name.includes("Serie")));
  assert.ok(!matched.some((p) => p.name === "Audifonos Bluetooth X"), "must not match an unrelated product");
});

test("finds zero products when nothing relevant was ever mentioned, current or prior turn", () => {
  const matched = findMentionedProductsForMediaBackstop(PRODUCTS, "Muestrame fotos ¿Cómo estás?");
  assert.equal(matched.length, 0);
});

test("still matches a single named product from the current turn alone (no prior-turn dependency)", () => {
  const matched = findMentionedProductsForMediaBackstop(PRODUCTS, "quiero fotos del Smartwatch Gen 9 por favor");
  assert.equal(matched.length, 1);
  assert.equal(matched[0].name, "Smartwatch Gen 9");
});

test("skips a product with no media even if its name matches", () => {
  const noMedia = [{ name: "Smartwatch Gen 9", media: [] }];
  const matched = findMentionedProductsForMediaBackstop(noMedia, "quiero fotos del Smartwatch Gen 9");
  assert.equal(matched.length, 0);
});

// Real production bug, second occurrence (2026-09-12, confirmed from prod logs after the first fix
// deployed): the bot's own numbered list ("1. Serie 11 Mini... 4. Smartwatch V20 Caballero") left a bare
// "4" token in the haystack from the list marker itself, not from any real product name. This
// coincidentally matched the literal "4" in an unrelated real catalog product's actual name ("AIRPODS
// SERIE 4") - combined with "Serie" being a shared brand word this business also uses for its
// smartwatches, that unrelated product crossed the 0.6 token-overlap threshold and its photo got sent to
// a real customer alongside the real watches. Uses the exact real product names/catalog shape involved.
const REAL_CATALOG_PRODUCTS = [
  { name: "Reloj Inteligente Smartwatch Serie 11 Mini (Edición Compacta y Elegante)", media: ["x"] },
  { name: "Reloj Inteligente Smartwatch Serie 12 Ultra 3 (Edición Deportiva / Robusta)", media: ["x"] },
  { name: "Smartwatch Gen 9", media: ["x"] },
  { name: "Smartwatch V20 Caballero", media: ["x"] },
  { name: "AIRPODS SERIE 4", media: ["x"] },
];

test("does not match an unrelated product whose name ends in the same digit as a list marker", () => {
  const priorAssistantTurn =
    "Tenemos estos modelos disponibles en negro:\n\n1. Serie 11 Mini — $145.000\n2. Serie 12 Ultra 3 — $140.000\n3. Smartwatch Gen 9 — $85.000\n4. Smartwatch V20 Caballero — $140.000";
  const currentReply =
    "¡Claro que sí! 😊 ¿De cuál de los cuatro quieres ver las fotos?\n\n1. Serie 11 Mini — $145.000\n2. Serie 12 Ultra 3 — $140.000\n3. Smartwatch Gen 9 — $85.000\n4. Smartwatch V20 Caballero — $140.000\n\nDime el numero o el nombre";
  const haystack = `Muestrame fotos ${currentReply} ${priorAssistantTurn}`;

  const matched = findMentionedProductsForMediaBackstop(REAL_CATALOG_PRODUCTS, haystack);

  assert.ok(!matched.some((p) => p.name === "AIRPODS SERIE 4"), "must not match airpods from a stray list-numbering digit");
  assert.ok(matched.length > 0, "must still match the real watches that were actually listed");
});

// Defense in depth, independent of the list-marker fix above: even if some OTHER future token collision
// drags an unrelated-category product into the token-overlap match, a clear category majority among the
// matches should exclude it - the customer's intent is "more of the same kind of thing", never a silent
// category switch buried in an otherwise single-category list.
test("category dominance: excludes a minority-category match even when token-overlap alone would include it", () => {
  const products = [
    { name: "Reloj Serie X Negro", media: ["x"], category: "reloj" },
    { name: "Reloj Serie Y Negro", media: ["x"], category: "reloj" },
    { name: "Reloj Serie Z Negro", media: ["x"], category: "reloj" },
    { name: "Diadema Serie Bluetooth", media: ["x"], category: "audifonos" },
  ];
  // "serie" and "negro" both appear in the haystack from the real reloj context - enough for the
  // diadema (a totally different category) to also cross the 0.6 threshold on shared generic words.
  const haystack = "Muestrame fotos de los relojes negro serie que tenemos disponibles bluetooth";
  const matched = findMentionedProductsForMediaBackstop(products, haystack);

  assert.ok(!matched.some((p) => p.category === "audifonos"), "must exclude the minority-category diadema");
  assert.ok(matched.some((p) => p.category === "reloj"), "must keep the dominant-category matches");
});

test("category dominance: does nothing when there is no clear majority (an exact tie)", () => {
  const products = [
    { name: "Reloj Serie X", media: ["x"], category: "reloj" },
    { name: "Diadema Serie X", media: ["x"], category: "audifonos" },
  ];
  const haystack = "Reloj Serie X Diadema Serie X";
  const matched = findMentionedProductsForMediaBackstop(products, haystack);

  assert.equal(matched.length, 2, "an exact tie must not guess which category to drop");
});

test("category dominance: does not affect products with no category set (backward compatible)", () => {
  const products = [
    { name: "Producto Uno", media: ["x"] },
    { name: "Producto Dos", media: ["x"] },
  ];
  const matched = findMentionedProductsForMediaBackstop(products, "Producto Uno Producto Dos");
  assert.equal(matched.length, 2);
});

// Regression for a real production bug (2026-09-13): a business's own combo lineup spans categories on
// purpose (2 smartwatch combos + 1 earbuds combo). The bot listed all 3 by their full real names in one
// message and asked which one; the customer said "Muestrame fotos" with no name. The category-dominance
// guard above (built for a DIFFERENT bug - a stray shared token dragging in an unrelated product) was
// dropping the earbuds combo purely for being outnumbered 2-to-1 by category, even though it was named
// in full, not through a coincidental word collision. Fix: never drop a near-exact name match (ratio
// >= 0.9) regardless of category.
test("category dominance: keeps a minority-category match that was named by its full real name", () => {
  const products = [
    { name: "Combo Smartwatch T2000 Ultra", media: ["x"], category: "Tecnologia (Smartwatch)" },
    { name: "Combo Pareja", media: ["x"], category: "Tecnologia (Smartwatch)" },
    { name: "Combo k11 Mini", media: ["x"], category: "Tecnologia (Audifonos)" },
  ];
  const priorAssistantTurn =
    "Tenemos varios combos disponibles:\n\n1. Combo K11 Mini - $98.000\n2. Combo Pareja - $115.000\n3. Combo Smartwatch T2000 Ultra - $80.000\n\n¿Alguno te llama la atencion?";
  const haystack = `Muestrame fotos ${priorAssistantTurn}`;
  const matched = findMentionedProductsForMediaBackstop(products, haystack);

  assert.equal(matched.length, 3, "must keep all 3 combos, not just the 2-vs-1 majority category");
  assert.ok(matched.some((p) => p.name === "Combo k11 Mini"), "must keep the fully-named minority-category combo");
});
