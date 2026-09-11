import { test } from "node:test";
import assert from "node:assert/strict";
import { customerRequestsHuman } from "./agent";

// Cheap, no DB or LLM - the regex backstop that flags SOLICITA_AGENTE when the customer explicitly asks
// for a human but the model doesn't call flag_conversation_intent on its own (see finalizeTurn in
// agent.ts). Kept narrow on purpose: only the most unambiguous phrasings, to avoid false-positiving on
// normal product questions.

test("customerRequestsHuman detects explicit requests for a human", () => {
  assert.equal(customerRequestsHuman("quiero hablar con una persona por favor"), true);
  assert.equal(customerRequestsHuman("me pasas con un asesor?"), true);
  assert.equal(customerRequestsHuman("necesito hablar con un humano"), true);
  assert.equal(customerRequestsHuman("quiero un humano, no un bot"), true);
  assert.equal(customerRequestsHuman("no quiero hablar con un bot"), true);
  assert.equal(customerRequestsHuman("Hola, ¿me puedes comunicar con un agente?"), true);
});

test("customerRequestsHuman does not false-positive on normal questions", () => {
  assert.equal(customerRequestsHuman("necesito ayuda con la talla"), false);
  assert.equal(customerRequestsHuman("tienen el smartwatch en negro?"), false);
  assert.equal(customerRequestsHuman("cuanto cuesta el envio a Medellin"), false);
  assert.equal(customerRequestsHuman("gracias, hablamos luego"), false);
  assert.equal(customerRequestsHuman(""), false);
});
