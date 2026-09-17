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

// 2026-09-17: la directiva ya NO lista las modalidades. Cuales aplican depende de la ZONA
// (ShippingRate.paymentModalities): un negocio puede hacer contraentrega total en su ciudad y no en el
// resto del pais, asi que una lista fija en el prompt seria un dato equivocado en la mitad de las
// conversaciones. El dato correcto lo devuelve la herramienta cuando se le pasa la ciudad.
test("shipping payment modality: la directiva manda a pedir las modalidades por ciudad, no las lista", () => {
  const prompt = buildSystemPrompt({ shippingPaymentModalities: ["PREPAID_ALL", "COD_ALL"] });
  assert.match(prompt, /MODALIDAD DE PAGO DEL ENVIO/);
  assert.match(prompt, /get_shipping_payment_modalities/);
  assert.match(prompt, /ciudad/);
  assert.doesNotMatch(prompt, /todo por adelantado/, "las etiquetas son datos, y los datos no viven en el prompt");
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

// Fase E, 2026-09-13 audit (F8): third photo mode - list the catalog and OFFER photos instead of
// auto-sending or waiting to be asked. Opt-in (Business.offerPhotosBeforeSending), takes priority over
// autoSendPhotoOnQuote when set.
test("photo directive: defaults to AUTO when neither flag is set", () => {
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /el sistema ya le manda la foto\/video al cliente automaticamente/);
});

test("photo directive: autoSendPhotoOnQuote:false alone selects REACTIVE", () => {
  const prompt = buildSystemPrompt({ autoSendPhotoOnQuote: false });
  assert.match(prompt, /si el cliente pide ver fotos, imagenes o video de un producto, usa send_product_media/);
});

test("photo directive: offerPhotosBeforeSending selects the offer-then-send variant regardless of autoSendPhotoOnQuote", () => {
  const prompt = buildSystemPrompt({ offerPhotosBeforeSending: true, autoSendPhotoOnQuote: true });
  assert.match(prompt, /NO mandes fotos todavia/);
  assert.match(prompt, /hasMedia/);
});
