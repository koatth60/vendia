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
  // Este pedido es contraentrega total: lo que paga al recibir es el total.
  amountOnDelivery: 149000,
  amountPrepaid: 0,
  itemsTotal: 140000,
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

// Fase 4 (2026-09-17). Riesgo de plata, directo al cliente: la plantilla de un negocio dice "en total
// serian [Precio total] pesos a pagar contra entrega". En un pedido donde el cliente YA pago el producto
// y solo le debe el flete al mensajero, resolver ese placeholder al total del pedido le dice que debe
// $154.000 cuando debe $9.000.
const SOLO_FLETE: ClosingFacts = {
  customerName: "Milena",
  summary: "1x Reloj Serie 11 Mini",
  shippingAddress: "Diagonal 48 sur #55-20",
  paymentMethodLabel: "Nequi",
  shippingCost: 9000,
  totalAmount: 154000,
  amountOnDelivery: 9000,
  amountPrepaid: 145000,
  itemsTotal: 145000,
  currency: "COP",
  locale: "es-CO",
};

// Los cuatro placeholders TEXTUALES de la plantilla de cierre de un negocio real, uno por variante. Dos
// de ellos estaban rotos: "[Precio del monto cancelado]" no resolvia y tiraba el cierre entero al mensaje
// generico, y "[Precio del producto]" devolvia el RESUMEN, asi que al cliente le llegaba "el valor
// cancelado del producto fue de 1x Reloj Serie 11 Mini pesos".
test("[Precio del monto cancelado] es lo que el cliente ya transfirio, no el total", () => {
  const r = fillClosingPlaceholders("Listo Milena en total fueron [Precio del monto cancelado] pesos.", SOLO_FLETE);
  assert.deepEqual(r.unresolved, [], "antes no resolvia y el cierre caia al generico");
  assert.ok(r.text.includes("145.000"), `salio: "${r.text}"`);
  assert.ok(!r.text.includes("154.000"), `y no el total del pedido; salio: "${r.text}"`);
});

test("[Precio del producto] es una cifra, no el resumen del pedido", () => {
  const r = fillClosingPlaceholders("el valor cancelado del producto fue de [Precio del producto] pesos", SOLO_FLETE);
  assert.ok(r.text.includes("145.000"), `salio: "${r.text}"`);
  assert.ok(!r.text.includes("Reloj"), `nunca el nombre del producto; salio: "${r.text}"`);
});

test("[Producto] a secas sigue siendo el resumen del pedido", () => {
  const r = fillClosingPlaceholders("Tu pedido: [Producto]", SOLO_FLETE);
  assert.ok(r.text.includes("Reloj"), `salio: "${r.text}"`);
});

test("[Precio total (Productos + envio)] sigue siendo el total del pedido", () => {
  const r = fillClosingPlaceholders("en total serian [Precio total (Productos + envio)] pesos", SOLO_FLETE);
  assert.ok(r.text.includes("154.000"), `salio: "${r.text}"`);
});

test("un placeholder que nombra la contraentrega resuelve a lo que se paga AL RECIBIR", () => {
  const r = fillClosingPlaceholders("son [Total a pagar contra entrega] pesos", SOLO_FLETE);
  assert.deepEqual(r.unresolved, []);
  assert.ok(r.text.includes("9.000"), `tiene que decir el flete; salio: "${r.text}"`);
  assert.ok(!r.text.includes("154.000"), `y nunca el total; salio: "${r.text}"`);
});

test("sin modalidad resuelta, ese placeholder queda sin resolver y el mensaje no sale", () => {
  // Preferible el cierre generico a mandarle al cliente una cifra que no le corresponde pagar.
  const r = fillClosingPlaceholders("son [Total a pagar contra entrega] pesos", { ...SOLO_FLETE, amountOnDelivery: null });
  assert.equal(r.unresolved.length, 1);
});
