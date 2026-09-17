import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedMediaIdIsUsable } from "./mediaUpload";
import { isUploadedMediaId, WHATSAPP_MEDIA_TTL_DAYS } from "./outbound";

// El archivo viaja UNA vez, hacia Meta, en vez de darle a Meta una URL nuestra para que la descargue.
// Ese paso era el unico de la cadena que no controlabamos, y cuando fallaba (131053, "Downloading media
// from weblink failed with http code 500") la foto no llegaba nunca sin que nadie se enterara.

const AHORA = new Date("2026-09-17T12:00:00Z");
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 24 * 60 * 60 * 1000);

test("un id subido hace poco por la misma linea se reusa", () => {
  const fila = { whatsappMediaId: "1234567890", whatsappMediaAt: hace(3), whatsappMediaPhoneId: "linea-a" };
  assert.equal(cachedMediaIdIsUsable(fila, "linea-a", AHORA), true);
});

test("un id vencido no se reusa: Meta los borra a los 30 dias", () => {
  const fila = { whatsappMediaId: "1234567890", whatsappMediaAt: hace(WHATSAPP_MEDIA_TTL_DAYS + 1), whatsappMediaPhoneId: "linea-a" };
  assert.equal(cachedMediaIdIsUsable(fila, "linea-a", AHORA), false);
});

test("un id subido por OTRA linea de WhatsApp no sirve", () => {
  // Un negocio que reconecta WhatsApp con otro numero: sus ids viejos dejan de existir para la linea
  // nueva. Sin este chequeo, cada foto de ese catalogo fallaria hasta que alguien lo notara.
  const fila = { whatsappMediaId: "1234567890", whatsappMediaAt: hace(1), whatsappMediaPhoneId: "linea-vieja" };
  assert.equal(cachedMediaIdIsUsable(fila, "linea-nueva", AHORA), false);
});

test("sin id cacheado no hay nada que reusar", () => {
  assert.equal(cachedMediaIdIsUsable({ whatsappMediaId: null, whatsappMediaAt: null, whatsappMediaPhoneId: null }, "linea-a", AHORA), false);
  assert.equal(cachedMediaIdIsUsable({ whatsappMediaId: "123", whatsappMediaAt: null, whatsappMediaPhoneId: "linea-a" }, "linea-a", AHORA), false);
});

test("un id de Meta y una URL de S3 no se confunden", () => {
  // La capa de envio decide por la FORMA si manda `{ id }` o `{ link }`. Si esto fallara, una URL se
  // mandaria como id (Meta la rechaza) o un id como link (Meta intentaria descargarlo).
  assert.equal(isUploadedMediaId("1234567890123456"), true);
  assert.equal(isUploadedMediaId("https://bucket.s3.amazonaws.com/images/abc.jpg?X-Amz-Signature=1234"), false);
  assert.equal(isUploadedMediaId("images/abc-123.jpg"), false);
  assert.equal(isUploadedMediaId(""), false);
});
