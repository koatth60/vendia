import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCustomerFacts, formatCustomerFactsForModel, type CustomerFactsRow } from "./customerFacts";

// Los datos del cliente son del cliente, no de la conversacion. Todo puro: no toca base, no llama a
// DeepSeek. La fila de abajo es la de Andres, tal como esta en produccion el 2026-09-17.
const ANDRES: CustomerFactsRow = {
  name: "Andrés",
  idNumber: "3103325677",
  deliveryPhone: "3103325677",
  address: "Calle 22 #108-62, Fontibón Ferrocarril, Bogotá (Bodega naranja)",
  email: null,
};

test("los cuatro datos que el bot le volvio a pedir a Andres salen en el bloque", () => {
  const facts = buildCustomerFacts(ANDRES, 1);
  assert.ok(facts);
  assert.equal(facts.identidad.nombre, "Andrés");
  assert.equal(facts.identidad.documento, "3103325677");
  assert.equal(facts.identidad.telefonoDeEntrega, "3103325677");
  assert.equal(facts.identidad.direccionDeEntrega, "Calle 22 #108-62, Fontibón Ferrocarril, Bogotá (Bodega naranja)");
  assert.equal(facts.pedidosEnTotal, 1);
});

test("un cliente nuevo no produce bloque, asi que no paga ni un token", () => {
  const nuevo: CustomerFactsRow = { name: null, idNumber: null, deliveryPhone: null, address: null, email: null };
  assert.equal(buildCustomerFacts(nuevo, 0), null);
  assert.equal(buildCustomerFacts(null, 0), null);
});

test("un solo dato guardado ya justifica el bloque", () => {
  const soloNombre: CustomerFactsRow = { name: "Ariadna", idNumber: null, deliveryPhone: null, address: null, email: null };
  const facts = buildCustomerFacts(soloNombre, 0);
  assert.ok(facts);
  assert.equal(facts.identidad.nombre, "Ariadna");
  assert.equal(facts.identidad.documento, null);
});

test("una cadena vacia no cuenta como dato", () => {
  const vacios: CustomerFactsRow = { name: "", idNumber: "", deliveryPhone: "", address: "", email: "" };
  assert.equal(buildCustomerFacts(vacios, 0), null);
});

test("el bloque es dato: no lleva ninguna instruccion de como preguntar", () => {
  const texto = formatCustomerFactsForModel(buildCustomerFacts(ANDRES, 1)!);
  assert.match(texto, /"nombre":"Andrés"/);
  assert.match(texto, /leidos de la base/);
  // Sin verbos de instruccion sobre la conversacion. Que decir y como decirlo sigue siendo del agente.
  assert.doesNotMatch(texto, /\b(pregunta|pedile|pídele|no le pidas|nunca|siempre|recuerda|debes|juntos)\b/i);
});

test("el nombre de perfil de WhatsApp no entra: el bot no le dice 'milenaparra55' a nadie", () => {
  const conPerfil = { ...ANDRES, name: null };
  const facts = buildCustomerFacts(conPerfil, 0);
  assert.ok(facts);
  assert.equal(facts.identidad.nombre, null);
  // La forma del objeto es cerrada a proposito: si alguien agrega whatsappProfileName, esto falla.
  assert.deepEqual(Object.keys(facts.identidad).sort(), [
    "correo",
    "direccionDeEntrega",
    "documento",
    "nombre",
    "telefonoDeEntrega",
  ]);
});
