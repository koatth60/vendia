import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCandidate } from "./learnedFaqQuality";

// Cada caso viene de las FAQ reales que hubo que limpiar a mano el 2026-09-15.

test("descarta lo que habla de un pedido concreto y no del negocio", () => {
  const v = classifyCandidate("Me puedes enviar la guíapor fa", "Si Sr apenas te envíe te envío la guía");
  assert.equal(v.skip, true);
});

test("descarta respuestas que no dicen nada por si solas", () => {
  assert.equal(classifyCandidate("Es sumergible ?", "Si").skip, true);
  assert.equal(classifyCandidate("Tienen garantia?", "Claro").skip, true);
});

test("conserva una respuesta corta pero con contenido real", () => {
  assert.equal(classifyCandidate("La garantia de cuanto es?", "3 meses por defectos de fabrica").skip, false);
  assert.equal(classifyCandidate("Hacen envios a Estados Unidos?", "No por ahora").skip, false);
});

test("no descarta lo que compromete plata: lo marca para que decida el dueno", () => {
  // El descuento de $10.000 por llevar dos productos resulto ser politica real. Descartarlo
  // automaticamente habria tirado una regla verdadera del negocio.
  const v = classifyCandidate("¿Hacen descuento si llevo dos productos?", "Si, se descuentan $10.000 del total");
  assert.equal(v.skip, false);
  assert.equal(v.risk, "dinero");
});

test("marca una respuesta que trae datos personales", () => {
  const v = classifyCandidate("A que numero consigno?", "Consigna al 3022168936 a nombre de Liseth");
  assert.equal(v.risk, "datos_personales");
});

test("una pregunta normal del negocio pasa sin marca", () => {
  const v = classifyCandidate("Es sumergible ?", "Son resistentes al agua más no sumergibles");
  assert.equal(v.skip, false);
  assert.equal(v.risk, null);
});
