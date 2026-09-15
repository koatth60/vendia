import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { checkWebhookSignature, signPayload } from "./webhookSignature";

// Fase 8, punto 1. La firma se calcula sobre los BYTES crudos, no sobre el objeto parseado: por eso
// el cuerpo de estas pruebas es un Buffer y no un objeto.
const SECRET = "app-secret-de-prueba";
const BODY = Buffer.from('{"object":"whatsapp_business_account","entry":[{"id":"1"}]}', "utf8");

test("una firma generada con el app secret correcto valida", () => {
  const check = checkWebhookSignature(BODY, signPayload(BODY, SECRET), SECRET);
  assert.deepEqual(check, { valid: true });
});

test("una firma hecha con otro secret no valida", () => {
  const check = checkWebhookSignature(BODY, signPayload(BODY, "otro-secret"), SECRET);
  assert.deepEqual(check, { valid: false, reason: "no-coincide" });
});

test("el mismo JSON con las claves en otro orden no valida: la firma es sobre los bytes", () => {
  const reordered = Buffer.from('{"entry":[{"id":"1"}],"object":"whatsapp_business_account"}', "utf8");
  const check = checkWebhookSignature(reordered, signPayload(BODY, SECRET), SECRET);
  assert.deepEqual(check, { valid: false, reason: "no-coincide" });
});

test("sin cabecera, sin cuerpo crudo o sin app secret se distingue cada caso", () => {
  assert.deepEqual(checkWebhookSignature(BODY, undefined, SECRET), { valid: false, reason: "sin-cabecera" });
  assert.deepEqual(checkWebhookSignature(undefined, signPayload(BODY, SECRET), SECRET), {
    valid: false,
    reason: "sin-cuerpo-crudo",
  });
  // Falta de configuracion, no entrega falsa: la ruta NO rechaza por este motivo aunque el rechazo
  // este activado, para que un .env incompleto no deje al bot sin recibir nada.
  assert.deepEqual(checkWebhookSignature(BODY, signPayload(BODY, SECRET), ""), {
    valid: false,
    reason: "sin-app-secret",
  });
});

test("una cabecera mal formada no revienta: se reporta como formato invalido", () => {
  assert.deepEqual(checkWebhookSignature(BODY, "sha1=abcdef", SECRET), { valid: false, reason: "formato-invalido" });
  // Firma truncada: timingSafeEqual tira TypeError si los largos difieren, hay que atajarlo antes.
  const truncated = signPayload(BODY, SECRET).slice(0, 20);
  assert.deepEqual(checkWebhookSignature(BODY, truncated, SECRET), { valid: false, reason: "formato-invalido" });
});

test("signPayload produce el mismo digest que el HMAC-SHA256 de referencia de Meta", () => {
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
  assert.equal(signPayload(BODY, SECRET), expected);
});
