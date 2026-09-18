import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedMediaIdIsUsable, uploadOnceToWhatsapp } from "./mediaUpload";
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

// E17b: lo que la duena adjunta desde el panel tambien viaja HACIA Meta. El camino del bot dejo de darle
// una URL a Meta el 2026-09-17; el del panel seguia haciendolo, con el mismo 131053 esperando ("Downloading
// media from weblink failed with http code 500", cinco veces en la linea base).

const CREDENCIALES = { phoneNumberId: "linea-a", accessToken: "token" };
const ARCHIVO = Buffer.from("no importa el contenido");
const URL_S3 = "https://bucket.s3.amazonaws.com/images/abc.jpg?X-Amz-Signature=1234";

function conFetch(respuesta: { ok: boolean; status: number; body: string }, destinos: string[]) {
  return (async (input: unknown) => {
    destinos.push(String(input));
    return { ok: respuesta.ok, status: respuesta.status, text: async () => respuesta.body } as Response;
  }) as typeof fetch;
}

test("un adjunto del panel viaja como id de Meta, no como URL de S3", async () => {
  const original = globalThis.fetch;
  const destinos: string[] = [];
  globalThis.fetch = conFetch({ ok: true, status: 200, body: JSON.stringify({ id: "1234567890123456" }) }, destinos);
  try {
    const enviable = await uploadOnceToWhatsapp(CREDENCIALES, ARCHIVO, "image/jpeg", "foto.jpg", URL_S3);
    assert.equal(enviable, "1234567890123456");
    assert.equal(isUploadedMediaId(enviable), true, "la capa de envio lo va a mandar como { id }, no como { link }");
    assert.match(destinos[0], /\/linea-a\/media$/, "se subio a la linea de WhatsApp de ese negocio");
  } finally {
    globalThis.fetch = original;
  }
});

test("si la subida a Meta falla, el adjunto sale por el link de siempre", async () => {
  // El mecanismo solo puede mejorar la entrega, nunca impedirla: sin este respaldo, un error de subida
  // dejaria a la duena sin poder mandar la foto que antes si salia.
  const original = globalThis.fetch;
  const destinos: string[] = [];
  globalThis.fetch = conFetch({ ok: false, status: 500, body: "Internal Server Error" }, destinos);
  try {
    const enviable = await uploadOnceToWhatsapp(CREDENCIALES, ARCHIVO, "image/jpeg", "foto.jpg", URL_S3);
    assert.equal(enviable, URL_S3);
    assert.equal(isUploadedMediaId(enviable), false);
  } finally {
    globalThis.fetch = original;
  }
});
