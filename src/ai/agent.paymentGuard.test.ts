import { test } from "node:test";
import assert from "node:assert/strict";
import { guardAgainstPaymentHallucination } from "./agent";

// Regression for a real production incident (2026-09-12): the model told a customer to pay to a
// completely fabricated Nequi number and titular ("Elizabeth Ríos") that matched none of the business's
// actually configured payment methods - real money risk. This is the hard backstop that catches it.

const REAL_METHODS = [
  { label: "Nequi, Llave o Daviplata", details: "Número 3022168936 (Nequi, Daviplata o Llave).\nA nombre de : Liseth Herrera." },
  { label: "Bancolombia", details: "Cuenta Bancolombia, Cuenta de ahorros\nNúmero:  67300055475\nA nombre de : Liseth herrera Narváez" },
];

test("replaces a fabricated payment number/titular with the real configured data", () => {
  const hallucinated =
    "¡Genial! Aquí están los datos de pago por Nequi:\n\nNúmero: 3112781665\nTitular: Elizabeth Ríos\n\nCuando realices la transferencia me mandas el comprobante.";
  const result = guardAgainstPaymentHallucination(hallucinated, REAL_METHODS);
  assert.doesNotMatch(result, /3112781665/, "the fake number must not reach the customer");
  assert.doesNotMatch(result, /Elizabeth/, "the fake name must not reach the customer");
  assert.match(result, /3022168936/, "must fall back to the real configured number");
  assert.match(result, /Liseth Herrera/, "must fall back to the real configured titular");
});

test("leaves the reply untouched when it correctly quotes a real configured number", () => {
  const correct = "¡Perfecto! Aquí están los datos: Nequi 3022168936, a nombre de Liseth Herrera. Envíame el comprobante cuando puedas.";
  const result = guardAgainstPaymentHallucination(correct, REAL_METHODS);
  assert.equal(result, correct);
});

test("leaves unrelated replies untouched even if they contain long numbers (order totals, etc.)", () => {
  const unrelated = "Tu pedido quedo con el numero de seguimiento 9988776655, te aviso cuando salga.";
  const result = guardAgainstPaymentHallucination(unrelated, REAL_METHODS);
  assert.equal(result, unrelated, "no payment keywords present - must not touch tracking numbers or other unrelated digits");
});

test("does nothing when get_payment_methods was never called this turn (no known methods to check against)", () => {
  const text = "Nequi: 3112781665, Titular: Elizabeth Ríos";
  const result = guardAgainstPaymentHallucination(text, null);
  assert.equal(result, text);
});

test("does not false-positive on Colombian-formatted prices (dot as thousands separator)", () => {
  const text = "El total de tu pedido por transferencia Nequi es de $1.234.567, número de cuenta 3022168936.";
  const result = guardAgainstPaymentHallucination(text, REAL_METHODS);
  assert.equal(result, text, "dotted price formatting must never look like an unverified account number");
});
