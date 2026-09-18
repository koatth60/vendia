import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderFixedBlocks,
  PAYMENT_BLOCK_MARKER,
  SHIPPING_BLOCK_MARKER,
  TOTAL_BLOCK_MARKER,
  ORDER_SUMMARY_BLOCK_MARKER,
  SALE_BLOCKED_BLOCK_MARKER,
} from "./agent";

// Fase 3 del plan maestro (2026-09-15): reemplaza a agent.paymentGuard.test.ts / shippingCostGuard /
// orderTotalGuard - esos guards leian la prosa YA generada para detectar una cifra inventada; esta
// funcion en cambio sustituye una marca que el modelo puso a proposito, asi que no hay cifra que
// detectar como correcta o incorrecta: o hay dato real de este turno, o la marca se borra.

const REAL_METHODS = [
  { label: "Nequi, Llave o Daviplata", details: "Número 3022168936 (Nequi, Daviplata o Llave).\nA nombre de: Liseth Herrera." },
];

test("sustituye la marca de pago por los datos reales configurados", () => {
  const { text, missingBlocks } = renderFixedBlocks(`Perfecto, aca los datos:\n\n${PAYMENT_BLOCK_MARKER}`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: REAL_METHODS,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.match(text, /3022168936/);
  assert.match(text, /Liseth Herrera/);
  assert.doesNotMatch(text, /BLOQUE_PAGO/);
  assert.deepEqual(missingBlocks, []);
});

// 2026-09-18: este caso dejo de significar "el modelo no llamo la herramienta". Desde el arreglo del
// bloque de pago, los metodos del negocio los lee el servidor al empezar el turno, asi que `null` aca
// significa lo unico que todavia puede significar: el negocio NO tiene formas de pago configuradas. Ver
// src/ai/agent.bloqueDePago.test.ts, que prueba el otro lado desde generateReply.
test("borra la marca de pago sin dejar rastro si el negocio no tiene formas de pago configuradas", () => {
  const { text, missingBlocks } = renderFixedBlocks(`Aca los datos: ${PAYMENT_BLOCK_MARKER}`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "Aca los datos: ");
  assert.deepEqual(missingBlocks, ["pago"]);
});

test("sustituye la marca de envio por la tarifa real", () => {
  const { text, missingBlocks } = renderFixedBlocks(`El envio cuesta ${SHIPPING_BLOCK_MARKER} y llega pronto.`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: { label: "Estandar", cost: "15000" },
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "El envio cuesta $15.000 y llega pronto.");
  assert.deepEqual(missingBlocks, []);
});

test("no inventa una tarifa de envio ambigua (2+ tarifas, ninguna resuelta por ciudad)", () => {
  const { text, missingBlocks } = renderFixedBlocks(`El envio cuesta ${SHIPPING_BLOCK_MARKER}.`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "El envio cuesta .");
  assert.deepEqual(missingBlocks, ["envio"]);
});

test("sustituye la marca de total por el total real de show_order_summary", () => {
  const { text, missingBlocks } = renderFixedBlocks(`Tu total es ${TOTAL_BLOCK_MARKER}. Confirmame para cerrar.`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: { items: [], shippingCost: 20900, total: 165900 },
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "Tu total es $165.900. Confirmame para cerrar.");
  assert.deepEqual(missingBlocks, []);
});

test("borra la marca de total si show_order_summary no corrio este turno - nunca deja pasar una cifra de memoria", () => {
  const { text, missingBlocks } = renderFixedBlocks(`Tu total es ${TOTAL_BLOCK_MARKER}.`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "Tu total es .");
  assert.deepEqual(missingBlocks, ["total"]);
});

test("arma el resumen completo con items, envio y total", () => {
  const { text } = renderFixedBlocks(ORDER_SUMMARY_BLOCK_MARKER, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: {
      items: [{ productName: "Smartwatch Serie 11 Mini", variantLabel: "plateado", quantity: 1, lineTotal: 145000 }],
      shippingCost: 20900,
      total: 165900,
    },
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(
    text,
    "1x Smartwatch Serie 11 Mini (plateado) — $145.000\nEnvío: $20.900\nTotal: $165.900"
  );
});

test("el resumen dice envio gratis cuando el costo es 0", () => {
  const { text } = renderFixedBlocks(ORDER_SUMMARY_BLOCK_MARKER, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: {
      items: [{ productName: "Aretes de perla cultivada", quantity: 1, lineTotal: 39000 }],
      shippingCost: 0,
      total: 39000,
    },
    catalog: null,
    saleBlocked: null,
  });
  assert.match(text, /Envío: gratis/);
});

test("sustituye la marca de venta bloqueada por el ofrecimiento fijo con lo que falta", () => {
  const { text, missingBlocks } = renderFixedBlocks(`Antes de seguir: ${SALE_BLOCKED_BLOCK_MARKER}`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: ["métodos de pago", "teléfono de contacto"],
  });
  assert.match(text, /métodos de pago, teléfono de contacto/);
  assert.match(text, /pedido anotado/);
  assert.deepEqual(missingBlocks, []);
});

test("borra la marca de venta bloqueada si ninguna herramienta quedo bloqueada este turno", () => {
  const { text, missingBlocks } = renderFixedBlocks(`Antes de seguir: ${SALE_BLOCKED_BLOCK_MARKER}`, {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "Antes de seguir: ");
  assert.deepEqual(missingBlocks, ["venta_bloqueada"]);
});

test("texto sin ninguna marca queda intacto", () => {
  const { text, missingBlocks } = renderFixedBlocks("Hola, ¿en que te ayudo?", {
    currency: "COP",
    locale: "es-CO",
    paymentMethods: null,
    shippingRate: null,
    orderSummary: null,
    catalog: null,
    saleBlocked: null,
  });
  assert.equal(text, "Hola, ¿en que te ayudo?");
  assert.deepEqual(missingBlocks, []);
});
