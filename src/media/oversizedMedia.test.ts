import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BYTES_BY_KIND } from "./s3";
import { excessBytes, isOversized, kindOfMediaType, maxBytesFor } from "./oversizedMedia";

// El caso real de produccion del 2026-09-16, con el peso exacto que WhatsApp rechazo:
// "Image file has size 6303812 bytes but must be atmost 5242880 bytes and non-empty".
const FOTO_RECHAZADA_BYTES = 6303812;
const TOPE_DE_WHATSAPP = 5242880;

test("la foto que WhatsApp rechazo en produccion queda listada", () => {
  assert.equal(maxBytesFor("IMAGE"), TOPE_DE_WHATSAPP, "el tope de imagen es el de WhatsApp, no uno propio");
  assert.equal(isOversized({ type: "IMAGE", bytes: FOTO_RECHAZADA_BYTES }), true);
  assert.equal(excessBytes({ type: "IMAGE", bytes: FOTO_RECHAZADA_BYTES }), FOTO_RECHAZADA_BYTES - TOPE_DE_WHATSAPP);
});

test("una foto justo en el tope NO se lista, y un byte mas si", () => {
  assert.equal(isOversized({ type: "IMAGE", bytes: TOPE_DE_WHATSAPP }), false);
  assert.equal(excessBytes({ type: "IMAGE", bytes: TOPE_DE_WHATSAPP }), 0);
  assert.equal(isOversized({ type: "IMAGE", bytes: TOPE_DE_WHATSAPP + 1 }), true);
});

test("cada tipo se mide con SU tope, no con el mas alto", () => {
  // Un video de 6 MB esta bien; una foto de 6 MB no. Medir todo con el tope mas alto es justamente lo
  // que dejaba pasar las fotos que despues fallaban al enviarse.
  assert.equal(isOversized({ type: "VIDEO", bytes: FOTO_RECHAZADA_BYTES }), false);
  assert.equal(isOversized({ type: "AUDIO", bytes: FOTO_RECHAZADA_BYTES }), false);
  assert.equal(isOversized({ type: "VIDEO", bytes: MAX_BYTES_BY_KIND.video + 1 }), true);
  assert.equal(isOversized({ type: "AUDIO", bytes: MAX_BYTES_BY_KIND.audio + 1 }), true);
});

test("el tipo de la base se traduce al tipo con el que s3.ts define los topes", () => {
  assert.equal(kindOfMediaType("IMAGE"), "image");
  assert.equal(kindOfMediaType("VIDEO"), "video");
  assert.equal(kindOfMediaType("AUDIO"), "audio");
});
