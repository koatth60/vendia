import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDeliveryDataFromAnswer,
  extractNameFromDeliveryAnswer,
  extractNameFromAnswer,
  extractSelfIntroducedName,
} from "./agent";

// Incidente real (2026-09-15), el mas caro del dia: desde que el bot pide todos los datos de entrega en
// un solo mensaje, los clientes responden mezclando texto y numeros. Ni la cedula, ni el celular, ni el
// nombre llegaban a la ficha del cliente - el bot contestaba "ya tengo el nombre y la cédula" y en la
// base los tres campos seguian en null. Dos pedidos reales quedaron sin esos datos.

test("lee nombre y cedula de una respuesta combinada, tal como la escribio la clienta", () => {
  const real = "Sebastián montealegre sotelo        CC: 1004074880";
  assert.deepEqual(extractDeliveryDataFromAnswer(real), { idNumber: "1004074880" });
  assert.equal(extractNameFromDeliveryAnswer(real), "Sebastián Montealegre Sotelo");
});

test("lee el celular cuando viene etiquetado y seguido de la ciudad", () => {
  const real = "Celular 3208935318         Mosquera Cundinamarca";
  assert.deepEqual(extractDeliveryDataFromAnswer(real), { deliveryPhone: "3208935318" });
});

test("distingue cedula de celular por la forma cuando no hay etiqueta", () => {
  // 10 digitos empezando en 3 = celular en Colombia; el resto, documento.
  assert.deepEqual(extractDeliveryDataFromAnswer("3208935318"), { deliveryPhone: "3208935318" });
  assert.deepEqual(extractDeliveryDataFromAnswer("1004074880"), { idNumber: "1004074880" });
});

test("lee los dos datos de un mismo mensaje", () => {
  const found = extractDeliveryDataFromAnswer("Cedula 1007367074 y mi celular es 3133260330");
  assert.equal(found.idNumber, "1007367074");
  assert.equal(found.deliveryPhone, "3133260330");
});

test("la etiqueta gana sobre la forma", () => {
  // Un documento que casualmente empieza en 3 y tiene 10 digitos no es un celular si dice "CC".
  assert.deepEqual(extractDeliveryDataFromAnswer("CC 3004074880"), { idNumber: "3004074880" });
});

test("no confunde precios con documentos", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("El total es $145.000 COP"), {});
  assert.deepEqual(extractDeliveryDataFromAnswer("son 145.000 pesos"), {});
});

test("no inventa datos cuando el mensaje no trae ninguno", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("Barrio la aurora, casa primer piso"), {});
});

// El criterio de nombres, reescrito: la lista negra de palabras (primer intento del mismo dia) fallo a
// los minutos porque "envías" y "catalogo" no estaban en ella. El criterio nuevo usa las palabras de
// clase cerrada del español, que si son un conjunto finito: una oracion real casi siempre trae al menos
// una, un nombre propio no trae ninguna.

test("rechaza la frase que rompio el primer intento", () => {
  assert.equal(extractNameFromAnswer("Me envías el catalogo"), null);
});

test("rechaza oraciones sueltas que antes pasaban por tener pocas palabras", () => {
  assert.equal(extractNameFromAnswer("Pero negro sale con todo"), null);
  assert.equal(extractNameFromAnswer("Si deseo el catalogo"), null);
  assert.equal(extractNameFromAnswer("No soy nuevo"), null);
  assert.equal(extractNameFromAnswer("Plateado"), null);
});

test("sigue aceptando nombres reales, incluidos los compuestos", () => {
  assert.equal(extractNameFromAnswer("Diana"), "Diana");
  assert.equal(extractNameFromAnswer("Maria Jose Rodriguez"), "Maria Jose Rodriguez");
  assert.equal(extractNameFromAnswer("Sebastián Montealegre Sotelo"), "Sebastián Montealegre Sotelo");
  assert.equal(extractSelfIntroducedName("Soy maria Camila"), "maria Camila");
});

test("tolera particulas de apellido compuesto cuando hay nombre de verdad alrededor", () => {
  assert.equal(extractNameFromAnswer("Juan De la Hoz"), "Juan De La Hoz");
});
