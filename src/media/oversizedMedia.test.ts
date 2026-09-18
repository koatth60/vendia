import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BYTES_BY_KIND } from "./s3";
import { excessBytes, isOversized, kindOfMediaType, maxBytesFor, unsendableReason } from "./oversizedMedia";

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

test("el motivo dice el peso real, el tope y que hacer", () => {
  const motivo = unsendableReason({ type: "IMAGE", bytes: FOTO_RECHAZADA_BYTES });
  assert.ok(motivo, "una foto por encima del tope tiene que tener motivo");
  assert.match(motivo, /6\.0 MB/);
  assert.match(motivo, /5\.0 MB/);
  assert.match(motivo, /Reemplazala/);
});

test("un video pesado se nombra en masculino", () => {
  // El motivo lo lee la duena en el panel; "Reemplazala" para un video se lee como un error del sistema.
  const motivo = unsendableReason({ type: "VIDEO", bytes: MAX_BYTES_BY_KIND.video + 1 });
  assert.ok(motivo);
  assert.match(motivo, /El video/);
  assert.match(motivo, /Reemplazalo/);
});

test("un archivo que cabe no tiene motivo", () => {
  assert.equal(unsendableReason({ type: "IMAGE", bytes: TOPE_DE_WHATSAPP }), null);
});

test("un archivo SIN medir no tiene motivo: null es 'no se midio', no 'esta mal'", () => {
  // Todo el catalogo cargado antes de la columna `bytes` esta asi. Tratarlo como pesado habria dejado
  // sin fotos a catalogos enteros el dia del despliegue, que es empeorar lo que hay hoy.
  assert.equal(unsendableReason({ type: "IMAGE", bytes: null }), null);
});
