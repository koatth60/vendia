import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCatalog } from "../catalog/presenter";
import { loadFixtureCatalog } from "../catalog/fixtureCatalog";
import { LIST_MAX_ROWS } from "./outbound";
import type { ScopeProduct } from "../catalog/scope";

// Elegir con el dedo en vez de escribir "el 5". La lista interactiva devuelve el id del producto, asi que
// la eleccion deja de pasar por la prosa - que es lo unico que hace imposible el defecto del 2026-09-16,
// donde "el numero 5 y el numero 6" resolvio a *Parlante Charge 6* por el 6 de su nombre.

const magimp = loadFixtureCatalog("MAGByLizN");
const OPTS = { currency: "COP", locale: "es-CO" };

function audifonos(): ScopeProduct[] {
  return magimp.filter((p) => (p.category ?? "").toLowerCase().includes("audifonos"));
}

test("un bloque de categoria trae las filas con el id real de cada producto", () => {
  const productos = audifonos();
  const [block] = renderCatalog({ kind: "group", category: "Tecnologia (Audifonos)", products: productos }, OPTS);

  assert.ok(block.rows, "un bloque de lista tiene que traer filas");
  assert.deepEqual(
    block.rows!.map((r) => r.id),
    productos.slice(0, block.rows!.length).map((p) => p.id),
    "el id de cada fila es el id del producto, en el mismo orden que la lista numerada"
  );
});

test("la descripcion de cada fila lleva el precio, no el nombre repetido", () => {
  const [block] = renderCatalog({ kind: "group", category: "Tecnologia (Audifonos)", products: audifonos() }, OPTS);
  const fila = block.rows![0];
  assert.match(fila.description, /\$/);
  assert.ok(!fila.description.includes(fila.title), "el titulo ya dice el nombre");
});

test("una ficha de producto no trae filas: no es una eleccion", () => {
  const [block] = renderCatalog({ kind: "one", product: magimp[0], variant: null }, OPTS);
  assert.equal(block.rows, undefined);
});

test("ningun bloque puede traer mas filas que el limite de WhatsApp", () => {
  // Meta rechaza el mensaje entero con mas de 10 filas. El catalogo completo se parte en bloques, y
  // ninguno puede pasarse - si alguno se pasara, el llamador cae al texto numerado, pero lo correcto es
  // que el corte del presentador ya respete el limite.
  const blocks = renderCatalog({ kind: "all", products: magimp }, OPTS);
  for (const block of blocks) {
    assert.ok((block.rows?.length ?? 0) <= LIST_MAX_ROWS, `un bloque quedo con ${block.rows?.length} filas`);
  }
});

test("el texto numerado sigue existiendo aunque haya filas", () => {
  // La lista interactiva es la forma de ELEGIR; el texto es lo que queda en el historial y lo que ve
  // quien abre la conversacion en el panel. Si un dia la lista falla, esto es lo que sale.
  const [block] = renderCatalog({ kind: "group", category: "Tecnologia (Audifonos)", products: audifonos() }, OPTS);
  assert.match(block.text, /1\. \*/);
  assert.ok(block.rows && block.rows.length > 0);
});
