import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, normalizeForMatch } from "./text";

test("tokenize strips accents and stopwords", () => {
  assert.deepEqual(tokenize("¿Tienen envíos a otras ciudades?"), ["envios", "otras", "ciudades"]);
});

test("normalizeForMatch makes accented and plain text comparable", () => {
  assert.equal(normalizeForMatch("envíos"), normalizeForMatch("envios"));
});
