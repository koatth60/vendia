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
