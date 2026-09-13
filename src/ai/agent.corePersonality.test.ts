import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./agent";

// Coverage for the two core mechanisms promoted out of MAGByLizN's business-specific prompt (2026-09-12
// plan, Fase 4): gendered address tone and shipping-payment-modality. Both are opt-in per business (off
// by default) - the prompt-building logic is pure and cheap to test without any DeepSeek call.

test("gendered address: off by default, no directive added", () => {
  const prompt = buildSystemPrompt({});
  assert.doesNotMatch(prompt, /TRATO SEGUN GENERO/);
});

test("gendered address: enabled with both terms includes both in the directive", () => {
  const prompt = buildSystemPrompt({ genderedAddressEnabled: true, femaleAddressTerm: "linda", maleAddressTerm: "Sr." });
  assert.match(prompt, /TRATO SEGUN GENERO/);
  assert.match(prompt, /"linda"/);
  assert.match(prompt, /"Sr\."/);
});

test("gendered address: enabled flag alone with no terms configured adds nothing (nothing to say)", () => {
  const prompt = buildSystemPrompt({ genderedAddressEnabled: true });
  assert.doesNotMatch(prompt, /TRATO SEGUN GENERO/);
});

test("gendered address: enabled with only the female term omits the male sentence", () => {
  const prompt = buildSystemPrompt({ genderedAddressEnabled: true, femaleAddressTerm: "linda" });
  assert.match(prompt, /"linda"/);
  assert.doesNotMatch(prompt, /Si es hombre/);
});

test("shipping payment modality: empty/undefined by default, no directive added", () => {
  const prompt = buildSystemPrompt({});
  assert.doesNotMatch(prompt, /MODALIDAD DE PAGO DEL ENVIO/);
});

test("shipping payment modality: configured modalities are named in the directive with real Spanish labels", () => {
  const prompt = buildSystemPrompt({ shippingPaymentModalities: ["PREPAID_ALL", "COD_ALL"] });
  assert.match(prompt, /MODALIDAD DE PAGO DEL ENVIO/);
  assert.match(prompt, /todo por adelantado/);
  assert.match(prompt, /contraentrega/);
  assert.match(prompt, /get_shipping_payment_modalities/);
});

test("shipping payment modality: empty array (explicit, not just missing) adds nothing", () => {
  const prompt = buildSystemPrompt({ shippingPaymentModalities: [] });
  assert.doesNotMatch(prompt, /MODALIDAD DE PAGO DEL ENVIO/);
});

// Fase 6.3 (2026-09-13): TARIFAS DE ENVIO POR CATEGORIA only makes sense once a business has real
// ShippingRate rows - a business with none just follows its own customInstructions prose either way.
test("shipping rates directive: off by default (no ShippingRate configured), no directive added", () => {
  const prompt = buildSystemPrompt({});
  assert.doesNotMatch(prompt, /TARIFAS DE ENVIO POR CATEGORIA/);
});

test("shipping rates directive: added when the business has real ShippingRate rows configured", () => {
  const prompt = buildSystemPrompt({ shippingRatesConfigured: true });
  assert.match(prompt, /TARIFAS DE ENVIO POR CATEGORIA/);
  assert.match(prompt, /get_shipping_rates/);
});
