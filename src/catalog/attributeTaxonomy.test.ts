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
