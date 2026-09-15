import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, countryConfig, isCountryCode } from "./countries";
import { formatPrice } from "./money";
import { parseBusinessHours, formatBusinessHours, closedDays } from "./businessHours";

// Fase 11 del plan maestro (2026-09-15). Lo que estas pruebas cuidan es que ningun pais nuevo tenga que
// tocar codigo: todo lo que antes era una constante colombiana ahora es una entrada de esta tabla.

test("un celular mexicano de 10 digitos no se clasifica como documento", () => {
  // El defecto concreto que motivo esta pieza: con la heuristica colombiana ("10 digitos que arrancan en
  // 3 = celular"), un celular de Ciudad de Mexico (55...) caia en la rama de cedula y se guardaba como
  // documento de identidad.
  assert.equal(COUNTRIES.CO.classifyDigits("5512345678"), "document");
  assert.equal(COUNTRIES.MX.classifyDigits("5512345678"), "phone");
  assert.equal(COUNTRIES.MX.classifyDigits("3312345678"), "phone");
});

test("la forma colombiana sigue siendo exactamente la de antes", () => {
  assert.equal(COUNTRIES.CO.classifyDigits("3135794619"), "phone");
  assert.equal(COUNTRIES.CO.classifyDigits("1093223487"), "document");
  assert.equal(COUNTRIES.CO.classifyDigits("12345"), null, "menos de 6 digitos no es ninguno de los dos");
  assert.equal(COUNTRIES.CO.classifyDigits("12345678901"), null, "mas de 10 tampoco");
});

test("Mexico no clasifica ninguna corrida de digitos como documento", () => {
  // CURP/RFC/INE son alfanumericos, y la paqueteria mexicana no pide documento para despachar.
  for (const digits of ["123456", "12345678", "123456789012345"]) {
    assert.notEqual(COUNTRIES.MX.classifyDigits(digits), "document");
  }
  assert.equal(COUNTRIES.MX.requiresIdDocumentByDefault, false);
});

test("las etiquetas de documento y telefono son las de cada pais", () => {
  assert.ok(COUNTRIES.CO.idLabelPattern.test("CC: 1004074880"));
  assert.ok(!COUNTRIES.MX.idLabelPattern.test("CC: 1004074880"), "CC no es una etiqueta mexicana");
  assert.ok(COUNTRIES.MX.idLabelPattern.test("INE 1234"));
  assert.ok(COUNTRIES.MX.idLabelPattern.test("CURP abc"));
  assert.ok(COUNTRIES.MX.phoneLabelPattern.test("celular 5512345678"));
});

test("un countryCode desconocido cae en Colombia, no rompe", () => {
  assert.equal(countryConfig("XX").code, "CO");
  assert.equal(countryConfig(null).code, "CO");
  assert.equal(countryConfig("MX").code, "MX");
  assert.equal(isCountryCode("MX"), true);
  assert.equal(isCountryCode("XX"), false);
});

test("formatPrice usa el separador de la moneda y el locale, no siempre es-CO", () => {
  assert.equal(formatPrice(145000, "COP", "es-CO"), "145.000");
  assert.equal(formatPrice(145000, "MXN", "es-MX"), "145,000.00");
  assert.equal(formatPrice(1234.5, "MXN", "es-MX"), "1,234.50");
  // COP no usa centavos: un precio con decimales igual se muestra entero, como antes.
  assert.equal(formatPrice(145000.4, "COP", "es-CO"), "145.000");
});

test("formatPrice no rompe con un valor que no es un numero", () => {
  assert.equal(formatPrice("no es un numero" as unknown as string, "COP", "es-CO"), "no es un numero");
});

test("el horario de atencion agrupa dias seguidos con el mismo horario", () => {
  const hours = parseBusinessHours({
    mon: ["09:00", "18:00"],
    tue: ["09:00", "18:00"],
    wed: ["09:00", "18:00"],
    thu: ["09:00", "18:00"],
    fri: ["09:00", "18:00"],
    sat: ["09:00", "13:00"],
    sun: null,
  });
  assert.ok(hours);
  assert.equal(formatBusinessHours(hours!), "lunes a viernes de 09:00 a 18:00, sábado de 09:00 a 13:00");
  assert.deepEqual(closedDays(hours!), ["domingo"]);
});

test("un horario mal formado se descarta entero en vez de llegar a medias al prompt", () => {
  assert.equal(parseBusinessHours(null), null);
  assert.equal(parseBusinessHours("lunes a viernes"), null);
  assert.equal(parseBusinessHours({ mon: ["9", "18"] }), null, "hace falta HH:MM");
  assert.equal(parseBusinessHours({ mon: ["09:00"] }), null, "hace falta apertura y cierre");
  assert.equal(parseBusinessHours({ mon: ["25:00", "18:00"] }), null);
  assert.deepEqual(parseBusinessHours({ mon: ["09:00", "18:00"], tue: "abierto" }), { mon: ["09:00", "18:00"] });
});

test("las frases con que el bot pide cada dato son las del pais", () => {
  // Estaban escritas en agent.ts con "cedula" y "celular" adentro: en Mexico ningun turno del bot las
  // cumplia, asi que un numero pelado no se guardaba nunca.
  assert.ok(COUNTRIES.CO.askIdPattern.test("¿Me confirmas tu cédula, por favor?"));
  assert.ok(!COUNTRIES.MX.askIdPattern.test("¿Me confirmas tu cédula, por favor?"));
  assert.ok(COUNTRIES.MX.askIdPattern.test("¿Me compartes tu INE?"));
  assert.ok(COUNTRIES.MX.askPhonePattern.test("¿Cuál es tu teléfono de contacto?"));
  assert.ok(!COUNTRIES.CO.askPhonePattern.test("¿Cuál es tu teléfono de contacto?"), "en Colombia se pide el celular");
  assert.ok(COUNTRIES.MX.askDeliveryDataPattern.test("Necesito tus datos de entrega"));
  assert.ok(COUNTRIES.CO.askDeliveryDataPattern.test("Necesito tus datos de entrega"));
});
