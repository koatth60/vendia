import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDeliveryDataFromAnswer,
  extractNameFromDeliveryAnswer,
  extractAddressFromAnswer,
  extractNameFromAnswer,
  extractSelfIntroducedName,
} from "./agent";

// Incidente real (2026-09-15), el mas caro del dia: desde que el bot pide todos los datos de entrega en
// un solo mensaje, los clientes responden mezclando texto y numeros. Ni la cedula, ni el celular, ni el
// nombre llegaban a la ficha del cliente - el bot contestaba "ya tengo el nombre y la cédula" y en la
// base los tres campos seguian en null. Dos pedidos reales quedaron sin esos datos.

test("lee nombre y cedula de una respuesta combinada, tal como la escribio la clienta", () => {
  const real = "Sebastián montealegre sotelo        CC: 1004074880";
  assert.deepEqual(extractDeliveryDataFromAnswer(real, "CO"), { idNumber: "1004074880" });
  assert.equal(extractNameFromDeliveryAnswer(real, "CO"), "Sebastián Montealegre Sotelo");
});

test("lee el celular cuando viene etiquetado y seguido de la ciudad", () => {
  const real = "Celular 3208935318         Mosquera Cundinamarca";
  assert.deepEqual(extractDeliveryDataFromAnswer(real, "CO"), { deliveryPhone: "3208935318" });
});

test("distingue cedula de celular por la forma cuando no hay etiqueta", () => {
  // 10 digitos empezando en 3 = celular en Colombia; el resto, documento.
  assert.deepEqual(extractDeliveryDataFromAnswer("3208935318", "CO"), { deliveryPhone: "3208935318" });
  assert.deepEqual(extractDeliveryDataFromAnswer("1004074880", "CO"), { idNumber: "1004074880" });
});

test("lee los dos datos de un mismo mensaje", () => {
  const found = extractDeliveryDataFromAnswer("Cedula 1007367074 y mi celular es 3133260330", "CO");
  assert.equal(found.idNumber, "1007367074");
  assert.equal(found.deliveryPhone, "3133260330");
});

test("la etiqueta gana sobre la forma", () => {
  // Un documento que casualmente empieza en 3 y tiene 10 digitos no es un celular si dice "CC".
  assert.deepEqual(extractDeliveryDataFromAnswer("CC 3004074880", "CO"), { idNumber: "3004074880" });
});

test("no confunde precios con documentos", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("El total es $145.000 COP", "CO"), {});
  assert.deepEqual(extractDeliveryDataFromAnswer("son 145.000 pesos", "CO"), {});
});

test("no inventa datos cuando el mensaje no trae ninguno", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("Barrio la aurora, casa primer piso", "CO"), {});
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

// La direccion de entrega no tenia donde guardarse hasta el 2026-09-15: Customer.address existia pero
// ningun camino lo llenaba. Estos son mensajes reales de clientes de esa noche.
test("saca la direccion de una respuesta con varios datos juntos", () => {
  const real = "Santa rosa de cabal risaralda  \n Cra 17 # 23-03 villa alegria  \n Linda Marin  \n 1093223487  \n 3135794619";
  assert.equal(extractAddressFromAnswer(real, "CO"), "Cra 17 # 23-03 villa alegria");
});

test("conserva el detalle de casa o piso, que el mensajero necesita", () => {
  assert.equal(extractAddressFromAnswer("Cr143#143b-42  Casa piso 3", "CO"), "Cr143#143b-42  Casa piso 3");
  assert.equal(extractAddressFromAnswer("Barrio la aurora   Calle 57 sur 65 92", "CO"), "Calle 57 sur 65 92");
});

test("no confunde una cedula ni un celular con una direccion", () => {
  assert.equal(extractAddressFromAnswer("Sebastián montealegre sotelo        CC: 1004074880", "CO"), null);
  assert.equal(extractAddressFromAnswer("3208935318", "CO"), null);
  assert.equal(extractAddressFromAnswer("Camila", "CO"), null);
});

// Fase 11 del plan maestro (2026-09-15): las mismas tres funciones, con el pais del negocio decidiendo la
// forma. El defecto concreto que cierra: en Mexico un celular de 10 digitos se guardaba como documento de
// identidad, porque la regla colombiana ("arranca en 3") no lo reconocia como telefono.
test("un celular mexicano se guarda como celular, no como documento", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("5512345678", "MX"), { deliveryPhone: "5512345678" });
  assert.deepEqual(extractDeliveryDataFromAnswer("5512345678", "CO"), { idNumber: "5512345678" });
});

test("las etiquetas de documento son las del pais", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("INE 1234567890", "MX"), { idNumber: "1234567890" });
  // "CC" no es una etiqueta mexicana: ese numero se resuelve por su forma, y en Mexico 10 digitos es un
  // telefono.
  assert.deepEqual(extractDeliveryDataFromAnswer("CC 3004074880", "MX"), { deliveryPhone: "3004074880" });
});

test("una direccion mexicana se reconoce por calle y colonia, no por barrio", () => {
  const real = "Ana Lopez  \n Av. Insurgentes Sur 300, Col. Roma Norte  \n 5512345678";
  assert.equal(extractAddressFromAnswer(real, "MX"), "Av. Insurgentes Sur 300, Col. Roma Norte");
  // Una direccion con colonia pero sin via reconocible en Colombia ("Mz 4" si, "Col. Roma" no) no pasa
  // por el patron colombiano - es el caso inverso del que rompia antes.
  assert.equal(extractAddressFromAnswer("Privada Juarez 12, Col. Centro", "CO"), null);
  assert.equal(extractAddressFromAnswer("Privada Juarez 12, Col. Centro", "MX"), "Privada Juarez 12, Col. Centro");
  assert.equal(extractNameFromDeliveryAnswer("Ana Lopez   INE 1234567890", "MX"), "Ana Lopez");
});

test("no confunde un precio en pesos mexicanos con un documento", () => {
  assert.deepEqual(extractDeliveryDataFromAnswer("son 1450.00 MXN", "MX"), {});
});
