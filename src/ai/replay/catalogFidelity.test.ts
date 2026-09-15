import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCatalogFidelity, type SeededCatalogProduct } from "./replay";

// Bloqueador de produccion (2026-09-15). assertCatalogFidelity es la que le da dientes al fixture
// catalogo-listado.json, asi que se prueba sola: contra el texto que recibio el cliente en el incidente
// tiene que fallar, y contra la lista que renderiza agent.ts desde la base tiene que pasar. Sin esta
// prueba, un cambio que afloje la asercion dejaria el fixture en verde sin medir nada.

const CATALOGO: SeededCatalogProduct[] = [
  { name: "AIRPODS SERIE 4", price: "65.000", stock: 11 },
  { name: "AIRPODS PRO 2", price: "55.000", stock: 10 },
  { name: "Bateria portatil power bank 12000 mah", price: "70.000", stock: 5 },
];

const LISTA_REAL = [
  "Estos son los productos disponibles:",
  "",
  "1. *AIRPODS SERIE 4* — $65.000 (11 disponibles)",
  "2. *AIRPODS PRO 2* — $55.000 (10 disponibles)",
  "3. *Bateria portatil power bank 12000 mah* — $70.000 (5 disponibles)",
  "",
  "Cual te gustaria ver?",
].join("\n");

test("acepta la lista renderizada desde el catalogo real", () => {
  assertCatalogFidelity("test", LISTA_REAL, CATALOGO);
});

test("falla si la respuesta nombra un producto que no esta en el catalogo sembrado", () => {
  const conInvento = LISTA_REAL + "\n" + "4. *Cargador iPhone* — $25.000 (5 disponibles)";
  assert.throws(() => assertCatalogFidelity("test", conInvento, CATALOGO), /Cargador iPhone/);
});

test("falla si le pone a un producto real un precio que no es el suyo", () => {
  // El caso exacto del incidente: AIRPODS SERIE 4 cotizado a $105.000 cuando vale $65.000.
  const conPrecioInflado = LISTA_REAL.split("$65.000").join("$105.000");
  assert.throws(() => assertCatalogFidelity("test", conPrecioInflado, CATALOGO), /105\.000/);
});

test("falla si omite un producto que si tiene stock", () => {
  const sinUno = LISTA_REAL.split("\n")
    .filter((line) => !line.includes("AIRPODS PRO 2"))
    .join("\n");
  assert.throws(() => assertCatalogFidelity("test", sinUno, CATALOGO), /AIRPODS PRO 2/);
});

test("deja pasar los numeros cortos de la redaccion y los digitos del nombre de un producto", () => {
  // "12000" sale del nombre real del power bank, y "2"/"3" son posiciones de la lista - ninguno es un
  // precio inventado.
  assertCatalogFidelity("test", LISTA_REAL + "\n" + "Te quedan 2 o 3 opciones mas si queres.", CATALOGO);
});
