import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCheckoutState,
  tieneNombreCompleto,
  direccionEsDespachable,
  type BusinessRequirements,
  type CheckoutFacts,
} from "./checkoutState";

// Todos los casos salen de conversaciones reales del 14-15 de septiembre.
//
// Fase 11: las reglas de documento ya no son una constante del producto, se las pasa el negocio. `magimp`
// reproduce exactamente lo que estaba cableado antes (Bogota y Soacha exentas), que es lo que la
// migracion le copio a cada negocio colombiano que ya existia.
const magimp: BusinessRequirements = { requiresIdDocument: true, idDocumentExemptZones: ["bogota", "soacha"] };

const base: CheckoutFacts = {
  pais: "CO",
  productos: [{ nombre: "Reloj Serie 11 Mini", cantidad: 1, variante: "rosa" }],
  varianteFaltante: false,
  nombre: "Angie Ramirez",
  documento: null,
  telefono: "3001234567",
  ciudad: "Soacha",
  direccion: "Cra 17 # 23-03, barrio La Aurora, casa",
  formaPago: "Contraentrega",
  zonaEnvio: "Soacha",
};

test("la cedula no se pide en Bogota ni Soacha, pero si en el resto del pais", () => {
  const soacha = computeCheckoutState({ ...base, zonaEnvio: "Soacha" }, magimp);
  assert.equal(soacha.completo, true, "en Soacha no falta la cedula");

  const nacional = computeCheckoutState({ ...base, zonaEnvio: "Nacional" }, magimp);
  assert.equal(nacional.completo, false);
  assert.deepEqual(nacional.faltan, ["tu número de cédula"]);
});

test("sin zona de envio resuelta todavia no se pide el documento", () => {
  // Pedir la cedula antes de saber a donde va seria pedir de mas.
  const state = computeCheckoutState({ ...base, zonaEnvio: null, ciudad: null }, magimp);
  assert.ok(!state.faltan.includes("tu número de cédula"));
  assert.deepEqual(state.faltan, ["tu ciudad"]);
});

test("un nombre sin apellido no alcanza para una guia", () => {
  // El caso de Diana: cerro el pedido con el nombre de pila y el dueno tuvo que pedir el apellido a mano
  // despues de haber mostrado el resumen.
  assert.equal(tieneNombreCompleto("Diana"), false);
  assert.equal(tieneNombreCompleto("Diana Perez"), true);
  assert.equal(tieneNombreCompleto(null), false);

  const state = computeCheckoutState({ ...base, nombre: "Diana" }, magimp);
  assert.deepEqual(state.faltan, ["tu nombre y apellido"]);
});

test("una direccion sin barrio ni detalle no sirve para despachar", () => {
  assert.equal(direccionEsDespachable("Cra 17 # 23-03", "CO"), false, "falta el barrio o el detalle de llegada");
  assert.equal(direccionEsDespachable("Cra 17 # 23-03 villa alegria casa", "CO"), true);
  assert.equal(direccionEsDespachable("Cr143#143b-42, Bilbao, casa piso 3", "CO"), true);
  assert.equal(direccionEsDespachable("Soacha", "CO"), false);
  assert.equal(direccionEsDespachable(null, "CO"), false);
});

test("pide todo lo que falta de una sola vez, no de a uno", () => {
  // El caso de Angie: el bot le pidio el barrio en cinco mensajes distintos.
  const state = computeCheckoutState({
    ...base,
    nombre: "Angie",
    direccion: null,
    formaPago: null,
    varianteFaltante: true,
  }, magimp);
  assert.deepEqual(state.faltan, [
    "el color",
    "tu nombre y apellido",
    "tu barrio, la dirección exacta, y si es casa o apartamento con piso",
    "cómo prefieres pagar",
  ]);
  assert.equal(state.completo, false);
});

test("un pedido con todo resuelto queda completo", () => {
  const state = computeCheckoutState(base, magimp);
  assert.equal(state.completo, true);
  assert.deepEqual(state.faltan, []);
});

test("sin productos elegidos lo primero que falta es el producto", () => {
  const state = computeCheckoutState({ ...base, productos: [], nombre: null, telefono: null, ciudad: null, direccion: null, formaPago: null, zonaEnvio: null }, magimp);
  assert.equal(state.faltan[0], "qué producto quieres y cuántas unidades");
});

test("una direccion mexicana necesita colonia o codigo postal, no barrio", () => {
  // Fase 11: el mismo criterio que en Colombia, con el patron de MX - via + numero + detalle de llegada.
  assert.equal(direccionEsDespachable("Av. Insurgentes Sur 300", "MX"), false, "falta la colonia o el C.P.");
  assert.equal(direccionEsDespachable("Calle 5 de Mayo 42, Col. Centro, C.P. 06000", "MX"), true);
  assert.equal(direccionEsDespachable("Cra 17 # 23-03 villa alegria casa", "MX"), false, "una via colombiana no es una mexicana");
});

test("un negocio que no pide documento nunca lo pide, aunque la zona no este exenta", () => {
  const sinDocumento: BusinessRequirements = { requiresIdDocument: false, idDocumentExemptZones: [] };
  const state = computeCheckoutState({ ...base, zonaEnvio: "Nacional" }, sinDocumento);
  assert.equal(state.completo, true);
});

test("las zonas exentas son las del negocio, no una lista del producto", () => {
  // Otro negocio colombiano puede eximir Medellin y cobrar documento en Bogota: es su decision, no la
  // del codigo.
  const otro: BusinessRequirements = { requiresIdDocument: true, idDocumentExemptZones: ["medellin"] };
  assert.equal(computeCheckoutState({ ...base, zonaEnvio: "Medellín" }, otro).completo, true);
  assert.deepEqual(computeCheckoutState({ ...base, zonaEnvio: "Bogota" }, otro).faltan, ["tu número de cédula"]);
});

test("las etiquetas de cada dato salen del pais, no estan cableadas a Colombia", () => {
  const mx = computeCheckoutState({ ...base, pais: "MX", direccion: null, zonaEnvio: "Ciudad de Mexico" }, magimp);
  assert.ok(mx.faltan.some((f) => f.includes("código postal")), "Mexico pide codigo postal, Colombia no");
  const co = computeCheckoutState({ ...base, direccion: null }, magimp);
  assert.ok(co.faltan.some((f) => f.includes("barrio")));
});
