import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesConfiguredPaymentMethod } from "./agent";

const REAL_METHODS = [
  { label: "Nequi, Llave o Daviplata" },
  { label: "Bancolombia" },
];

// Regression for a real production incident found via npm run regression (2026-09-13): close_conversation
// blocked in 6/37 real MAGByLizN conversations because the model confirmed the customer's actual channel
// ("Nequi") instead of repeating the full combined label ("Nequi, Llave o Daviplata") - the exact-match
// check treated a legitimate close as a hallucination.
test("matchesConfiguredPaymentMethod: a single channel name matches a combined multi-channel label", () => {
  assert.equal(matchesConfiguredPaymentMethod("Nequi", REAL_METHODS), true);
  assert.equal(matchesConfiguredPaymentMethod("Daviplata", REAL_METHODS), true);
  assert.equal(matchesConfiguredPaymentMethod("Llave", REAL_METHODS), true);
});

test("matchesConfiguredPaymentMethod: exact label still matches", () => {
  assert.equal(matchesConfiguredPaymentMethod("Bancolombia", REAL_METHODS), true);
  assert.equal(matchesConfiguredPaymentMethod("Nequi, Llave o Daviplata", REAL_METHODS), true);
});

test("matchesConfiguredPaymentMethod: a fabricated label still fails to match", () => {
  assert.equal(matchesConfiguredPaymentMethod("PayPal", REAL_METHODS), false);
  assert.equal(matchesConfiguredPaymentMethod("Efectivo", REAL_METHODS), false);
});
