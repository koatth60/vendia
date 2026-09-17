import { test } from "node:test";
import assert from "node:assert/strict";
import { fillClosingPlaceholders, type ClosingFacts } from "./closingPlaceholders";

// El caso literal de produccion (2026-09-17): al cliente le llego "en total serian [Precio total
// (Productos + envio)] pesos a pagar contra entrega". Funcion pura: sin base, sin red, sin modelo.

const FACTS: ClosingFacts = {
  customerName: "Andrés Rojas",
  summary: "1x Reloj Serie 12 Ultra 3, negro",
  shippingAddress: "Calle 22 #108-62, Fontibón",
  paymentMethodLabel: "Contraentrega",
  shippingCost: 9000,
  totalAmount: 149000,
  currency: "COP",
  locale: "es-CO",
};

test("el placeholder del total se reemplaza por el total real", () => {
  const r = fillClosingPlaceholders("Listo Andrés en total serían [Precio total (Productos + envio)] pesos.", FACTS);
  assert.deepEqual(r.unresolved, []);
  assert.match(r.text, /149\.000/);
  assert.ok(!r.text.includes("["), "no puede quedar ningun corchete");
});

test("las llaves dobles funcionan igual que los corchetes", () => {
  const r = fillClosingPlaceholders("Gracias {{nombre del cliente}}, tu pedido va a {{dirección}}.", FACTS);
  assert.deepEqual(r.unresolved, []);
  assert.match(r.text, /Andrés Rojas/);
  assert.match(r.text, /Fontibón/);
});

test("'total' le gana a 'envio' cuando el placeholder nombra los dos", () => {
  // "Precio total (Productos + envio)" pide el TOTAL, no el costo del flete.
  const r = fillClosingPlaceholders("[Precio total (Productos + envio)]", FACTS);
  assert.equal(r.text, "149.000");
});

test("el costo de envio sale aparte cuando la plantilla lo pide solo", () => {
  const r = fillClosingPlaceholders("El flete es [costo de envío].", FACTS);
  assert.deepEqual(r.unresolved, []);
  assert.match(r.text, /9\.000/);
});

test("un placeholder que no mapea a ningun dato queda sin resolver y se puede bloquear", () => {
  const r = fillClosingPlaceholders("Tu guía es [número de guía de la transportadora].", FACTS);
  assert.deepEqual(r.unresolved, ["[número de guía de la transportadora]"]);
  assert.match(r.text, /\[número de guía/, "el texto queda intacto: el llamador lo descarta entero");
});

test("un dato real que falta en el pedido cuenta como sin resolver, no como vacio", () => {
  const sinDireccion = { ...FACTS, shippingAddress: null };
  const r = fillClosingPlaceholders("Enviamos a [dirección de entrega].", sinDireccion);
  assert.equal(r.unresolved.length, 1, "mejor el cierre generico que 'Enviamos a .'");
});

test("un mensaje sin ningun placeholder pasa tal cual", () => {
  const texto = "¡Gracias por tu compra! Te avisamos cuando salga el envío.";
  const r = fillClosingPlaceholders(texto, FACTS);
  assert.equal(r.text, texto);
  assert.deepEqual(r.unresolved, []);
});

test("el separador de miles sale del locale del negocio, no siempre el colombiano", () => {
  const mx = fillClosingPlaceholders("[total]", { ...FACTS, currency: "MXN", locale: "es-MX" });
  assert.match(mx.text, /149,000/);
});
