import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalColors, canonicalizeCategoryWord } from "./attributeTaxonomy";

test("canonicalColors: negro and oscuro resolve to the same bucket (TikTok policy wording workaround)", () => {
  assert.deepEqual(canonicalColors("quiero un reloj negro"), ["negro"]);
  assert.deepEqual(canonicalColors("este producto viene en color oscuro"), ["negro"]);
});

test("canonicalColors: the diminutive from the user's own example resolves to rosado", () => {
  assert.deepEqual(canonicalColors("hola quiero el rosadito"), ["rosado"]);
});

test("canonicalColors: finds multiple colors mentioned in the same text", () => {
  const found = canonicalColors("lo tengo en negro y en azul");
  assert.deepEqual(new Set(found), new Set(["negro", "azul"]));
});

test("canonicalColors: returns empty when no color word is present", () => {
  assert.deepEqual(canonicalColors("quiero un reloj para regalo"), []);
});

test("canonicalColors: silver/plateado/plata all fold to gris", () => {
  assert.equal(canonicalColors("edicion plateada")[0], "gris");
  assert.equal(canonicalColors("silver edition")[0], "gris");
});

test("canonicalizeCategoryWord: folds simple Spanish plurals", () => {
  assert.equal(canonicalizeCategoryWord("relojes"), "reloj");
  assert.equal(canonicalizeCategoryWord("camisetas"), "camiseta");
  assert.equal(canonicalizeCategoryWord("audifonos"), "audifono");
});

test("canonicalizeCategoryWord: strips accents so it matches regardless of typing", () => {
  assert.equal(canonicalizeCategoryWord("diadema"), canonicalizeCategoryWord("diadéma"));
});

test("canonicalizeCategoryWord: leaves an already-singular short word alone", () => {
  assert.equal(canonicalizeCategoryWord("reloj"), "reloj");
});

test("canonicalizeCategoryWord: with no aliasMap, an unconfigured word just matches itself (no hardcoded vertical vocabulary)", () => {
  assert.equal(canonicalizeCategoryWord("smartwatch"), "smartwatch");
  assert.notEqual(canonicalizeCategoryWord("smartwatch"), canonicalizeCategoryWord("reloj"));
});

// Real production bug (2026-09-13): a business categorized some watches "Relojes Inteligentes
// (Smartwatches)" and others just "smartwatch" - a customer's "reloj negro" silently excluded the second
// group even though both are the same real category. Fixed via a per-business CategoryAlias table (see
// findProductsByAttributes in products.ts), never a hardcoded list here - that would only ever help one
// vertical (electronics) and silently do nothing for e.g. a fruit stand's "guineo"/"banano".
test("canonicalizeCategoryWord: an aliasMap folds a business's own configured synonym to its canonical word", () => {
  const aliasMap = new Map([["smartwatch", "reloj"]]);
  assert.equal(canonicalizeCategoryWord("smartwatch", aliasMap), "reloj");
  assert.equal(canonicalizeCategoryWord("smartwatches", aliasMap), "reloj");
  assert.equal(canonicalizeCategoryWord("reloj", aliasMap), "reloj");
});
