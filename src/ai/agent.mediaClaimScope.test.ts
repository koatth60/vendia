import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHOTO_CLAIM_PATTERN,
  PHOTO_REQUEST_PATTERN,
  NON_PRODUCT_PHOTO_PATTERN,
  OPEN_CLARIFYING_QUESTION_PATTERN,
  OFFER_OR_PENDING_CONFIRMATION_PATTERN,
  stripMarkdownEmphasis,
} from "./agent";

// Regression (2026-09-15, caused by the media-promise invariant shipped the same day): the media
// backstop treats "te paso la foto de la guía apenas se realice el envío" as a claim that CATALOG photos
// were just sent. It is not - it is a future promise about a courier tracking slip that does not exist
// yet. In production this appended a "no logré cargar las fotos" retraction to an otherwise correct
// shipping answer, in front of a customer mid-purchase. Same class: "mándame la foto del comprobante",
// where the photo travels the other way (customer -> us).

function claimsCatalogPhotosWereSent(text: string): boolean {
  return (
    PHOTO_CLAIM_PATTERN.test(text) &&
    PHOTO_REQUEST_PATTERN.test(text) &&
    !OPEN_CLARIFYING_QUESTION_PATTERN.test(text) &&
    !NON_PRODUCT_PHOTO_PATTERN.test(text) &&
    !OFFER_OR_PENDING_CONFIRMATION_PATTERN.test(stripMarkdownEmphasis(text))
  );
}

test("a courier-guide photo promise is not treated as a catalog-photo claim", () => {
  const real =
    "¡Diana! 😊 Como el envío es por Interrapidísimo a Mosquera, toma de 2 a 3 días hábiles después del despacho, y te paso la foto de la guía apenas se realice el envío 📦";
  assert.equal(PHOTO_CLAIM_PATTERN.test(real), true, "la frase sí matchea el patrón de claim genérico");
  assert.equal(claimsCatalogPhotosWereSent(real), false, "pero no debe disparar el backstop de fotos de catálogo");
});

test("a payment-receipt photo request is not treated as a catalog-photo claim", () => {
  const real = "Cuando lo hagas, me mandas la foto del comprobante por aquí, porfa 📸";
  assert.equal(claimsCatalogPhotosWereSent(real), false);
});

test("a real catalog-photo claim still fires the backstop", () => {
  assert.equal(claimsCatalogPhotosWereSent("¡Listo! Ahí te van las fotos del Serie 11 Mini 📸⌚"), true);
  assert.equal(claimsCatalogPhotosWereSent("¡Claro que sí! 📸 Aquí te van las fotos del reloj."), true);
});
