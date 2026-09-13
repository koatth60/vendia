import { test } from "node:test";
import assert from "node:assert/strict";
import { guardAgainstShippingCostHallucination } from "./agent";

// Fase F of the 2026-09-13 audit (F6 revisit): with a SINGLE configured shipping tier there's exactly one
// real, unambiguous number, so a mismatch can now be corrected in place instead of only logged (the
// original 2026-09-12 tradeoff was detection-only because several tiers meant no single "the real number"
// to substitute - that reasoning still holds and is preserved for the multi-tier case).

test("corrects a hallucinated shipping cost in place when exactly one tier is configured", () => {
  const rates = [{ label: "Estandar", cost: "15000" }];
  const text = "Perfecto, el envio cuesta $25.000 y llega en 2 dias.";
  const result = guardAgainstShippingCostHallucination(text, rates);
  assert.match(result, /15\.000/);
  assert.doesNotMatch(result, /25\.000/);
});

test("leaves a correctly-quoted single-tier cost untouched (aside from harmless formatting)", () => {
  const rates = [{ label: "Estandar", cost: "15000" }];
  const text = "Perfecto, el envio cuesta $15.000 y llega en 2 dias.";
  const result = guardAgainstShippingCostHallucination(text, rates);
  assert.match(result, /15\.000/);
});

test("stays detection-only (no rewrite) with multiple configured tiers - no single real number to substitute", () => {
  const rates = [
    { label: "Bogota", cost: "12000" },
    { label: "Resto del pais", cost: "18000" },
  ];
  const text = "Perfecto, el envio cuesta $99.000 y llega en 2 dias.";
  const result = guardAgainstShippingCostHallucination(text, rates);
  assert.equal(result, text, "must not guess which of several tiers is the real one");
});

test("does nothing when the reply never mentions envio", () => {
  const rates = [{ label: "Estandar", cost: "15000" }];
  const text = "Tenemos ese producto en negro y blanco, ¿cual prefieres?";
  const result = guardAgainstShippingCostHallucination(text, rates);
  assert.equal(result, text);
});

test("does nothing when get_shipping_rates never ran this turn", () => {
  const text = "Perfecto, el envio cuesta $99.000 y llega en 2 dias.";
  const result = guardAgainstShippingCostHallucination(text, null);
  assert.equal(result, text);
});
