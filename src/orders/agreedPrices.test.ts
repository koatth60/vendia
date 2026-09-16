import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractNumbers,
  parseOwnerPriceReply,
  validateProposedPrices,
  applyAgreedPrices,
  agreedKey,
  agreedUnitPriceOf,
  formatProposalForOwner,
  formatAgreedPricesForCustomer,
  parsePriceSlots,
  parseProposedPrices,
  type PriceSlot,
  type AgreedPriceMap,
} from "./agreedPrices";

// El nucleo PURO del precio acordado: sin base, sin red, sin modelo. Lo que se fija aca es que la
// interpretacion de la respuesta de la duena sea llenar un formulario de N ranuras y nunca adivinar.

const SLOTS: PriceSlot[] = [
  {
    productId: "p-airpods",
    variantKey: "",
    productName: "AIRPODS PRO 3",
    variantLabel: null,
    quantity: 1,
    unitPrice: 75000,
    currency: "COP",
  },
  {
    productId: "p-alexa",
    variantKey: "",
    productName: "PARLANTE TIPO ALEXA",
    variantLabel: null,
    quantity: 1,
    unitPrice: 70000,
    currency: "COP",
  },
];

test("extractNumbers lee un separador de tres digitos como miles y uno de uno o dos como decimal", () => {
  assert.deepEqual(extractNumbers("70.000"), [70000]);
  assert.deepEqual(extractNumbers("$65.000 y 70000"), [65000, 70000]);
  assert.deepEqual(extractNumbers("1.234.567"), [1234567]);
  assert.deepEqual(extractNumbers("65,50"), [65.5]);
  assert.deepEqual(extractNumbers("sin numeros aca"), []);
});

test("una respuesta con un numero por item resuelve las ranuras en orden", () => {
  const parsed = parseOwnerPriceReply("70000, 65000", SLOTS.length);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.prices, [70000, 65000]);
});

// EL CASO REAL, 2026-09-16 22:58:12, conversacion cmu4gykpm003le82keve7ngck. La duena escribio un precio
// de combo Y dos precios sueltos en el mismo mensaje: cuatro numeros para dos ranuras. Elegir cuales dos
// son los unitarios seria interpretar prosa, que es justo lo que este repositorio no admite. El servidor
// no elige: vuelve a preguntar.
test("la respuesta real de la duena, con un precio de combo adentro, NO se resuelve y se vuelve a preguntar", () => {
  const parsed = parseOwnerPriceReply("Te dejaría los dos en 135 mil / Pro 3 70 / Alexa $65", SLOTS.length);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.reason, "cantidad_distinta");
  assert.equal(parsed.ok === false && parsed.found, 4);
});

test("una respuesta sin ningun numero tampoco resuelve nada", () => {
  const parsed = parseOwnerPriceReply("dale, hacele un descuentito", SLOTS.length);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.reason, "sin_numeros");
});

test("un precio mayor al del catalogo se rechaza", () => {
  const validation = validateProposedPrices(SLOTS, [80000, 65000]);
  assert.equal(validation.ok, false);
  assert.equal(validation.ok === false && validation.reason, "mayor_al_catalogo");
  assert.equal(validation.ok === false && validation.slot.productName, "AIRPODS PRO 3");
});

test("un precio de cero o negativo se rechaza", () => {
  assert.equal(validateProposedPrices(SLOTS, [0, 65000]).ok, false);
  assert.equal(validateProposedPrices(SLOTS, [70000, -5]).ok, false);
});

test("un precio igual al del catalogo es valido (no es un descuento, pero tampoco es un error)", () => {
  assert.equal(validateProposedPrices(SLOTS, [75000, 70000]).ok, true);
});

test("el precio acordado gana sobre el de catalogo, y el resto de los items no se toca", () => {
  const agreed: AgreedPriceMap = new Map([
    [agreedKey("p-airpods", null), { productId: "p-airpods", variantKey: "", unitPrice: 70000, currency: "COP" }],
  ]);
  const items = [
    { productId: "p-airpods", variantId: null, unitPrice: 75000, currency: "COP" },
    { productId: "p-alexa", variantId: null, unitPrice: 70000, currency: "COP" },
  ];
  const applied = applyAgreedPrices(items, agreed);
  assert.equal(applied[0].unitPrice, 70000);
  assert.equal(applied[1].unitPrice, 70000);
  assert.equal(agreedUnitPriceOf(items[0], agreed), 70000);
  assert.equal(agreedUnitPriceOf(items[1], agreed), null);
});

test("el precio acordado de una variante no aplica a otra variante del mismo producto", () => {
  const agreed: AgreedPriceMap = new Map([
    [agreedKey("p-reloj", "v-negro"), { productId: "p-reloj", variantKey: "v-negro", unitPrice: 100000, currency: "COP" }],
  ]);
  const items = [
    { productId: "p-reloj", variantId: "v-negro", unitPrice: 120000, currency: "COP" },
    { productId: "p-reloj", variantId: "v-rosado", unitPrice: 120000, currency: "COP" },
  ];
  const applied = applyAgreedPrices(items, agreed);
  assert.equal(applied[0].unitPrice, 100000);
  assert.equal(applied[1].unitPrice, 120000);
});

test("la propuesta que ve la duena y el aviso que ve el cliente traen las cifras formateadas", () => {
  const propuesta = formatProposalForOwner(SLOTS, [70000, 65000], "es-CO");
  assert.ok(propuesta.includes("AIRPODS PRO 3"));
  assert.ok(propuesta.includes("$70.000"));
  assert.ok(propuesta.includes("$65.000"));
  const aviso = formatAgreedPricesForCustomer(SLOTS, [70000, 65000], "es-CO");
  assert.ok(aviso.includes("$70.000"));
  assert.ok(aviso.includes("$65.000"));
});

test("las ranuras y la propuesta se releen del payload, y un payload roto no devuelve nada", () => {
  assert.equal(parsePriceSlots({ items: SLOTS }).length, 2);
  assert.equal(parsePriceSlots({ items: [{ productId: 1 }] }).length, 0);
  assert.equal(parsePriceSlots(null).length, 0);
  assert.deepEqual(parseProposedPrices({ items: SLOTS, propuesta: [70000, 65000] }), [70000, 65000]);
  assert.equal(parseProposedPrices({ items: SLOTS }), null);
  assert.equal(parseProposedPrices({ items: SLOTS, propuesta: ["70000"] }), null);
});
