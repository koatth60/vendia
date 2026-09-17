import { test } from "node:test";
import assert from "node:assert/strict";
import { LIST_MAX_ROWS } from "./outbound";
import { MAX_LINES_PER_BLOCK, renderCatalog, rowsAreListable, listBodyText, startsAsNumberedItem } from "../catalog/presenter";
import { loadFixtureCatalog } from "../catalog/fixtureCatalog";

// 2026-09-17. La lista TOCABLE de WhatsApp es la unica forma de elegir que no pasa por la prosa del
// cliente, asi que toda lista que el servidor componga tiene que poder salir tocable. Lo que lo impedia
// no era una decision: era que dos numeros que tienen que ser iguales vivian en dos archivos.

const magimp = loadFixtureCatalog("MAGByLizN");
const OPTS = { currency: "COP", locale: "es-CO", interactiveLists: true };

test("ningun bloque que compone el presentador puede tener mas filas de las que Meta admite", () => {
  // Con MAX_LINES_PER_BLOCK en 12 y LIST_MAX_ROWS en 10, toda categoria de 11 o 12 productos salia como
  // texto numerado y nadie se enteraba: el unico sintoma era que no aparecia el boton.
  assert.ok(
    MAX_LINES_PER_BLOCK <= LIST_MAX_ROWS,
    `MAX_LINES_PER_BLOCK (${MAX_LINES_PER_BLOCK}) no puede superar LIST_MAX_ROWS (${LIST_MAX_ROWS}): esos bloques nunca podrian salir tocables`
  );
});

test("el catalogo completo sale entero en bloques que TODOS pueden ser tocables", () => {
  const blocks = renderCatalog({ kind: "all", products: magimp }, OPTS);
  const conVariasFilas = blocks.filter((b) => (b.rows?.length ?? 0) >= 2);
  assert.ok(conVariasFilas.length > 0, "el fixture tiene categorias de dos o mas productos");
  for (const b of conVariasFilas) {
    assert.ok(rowsAreListable(b.rows), `un bloque de ${b.rows?.length} filas no puede salir tocable`);
  }
  // Y ningun producto se perdio por el corte mas chico.
  const ids = new Set(blocks.flatMap((b) => b.productIds));
  assert.equal(ids.size, magimp.length);
});

test("el cuerpo de la lista tocable no repite los productos ni supera el tope de Meta", () => {
  // Meta rechaza el mensaje entero con un cuerpo de mas de 1024 caracteres. Diez lineas con nombres
  // largos lo superan, y el rechazo caia al texto numerado justo en las categorias mas largas.
  const blocks = renderCatalog({ kind: "all", products: magimp }, OPTS);
  for (const b of blocks) {
    const body = listBodyText(b);
    assert.ok(body.length > 0, "Meta no admite un cuerpo vacio");
    assert.ok(body.length <= 1024, `cuerpo de ${body.length} caracteres`);
    for (const line of body.split("\n")) {
      assert.ok(!startsAsNumberedItem(line.trim()), `el cuerpo todavia repite una linea numerada: "${line}"`);
    }
  }
});

test("el titulo de la seccion es la categoria real cuando el bloque agrupa una", () => {
  const blocks = renderCatalog({ kind: "all", products: magimp }, OPTS);
  const conTitulo = blocks.filter((b) => b.sectionTitle);
  assert.ok(conTitulo.length > 0, "el catalogo completo separa por categoria y cada bloque la nombra");
  // Y con UNA sola categoria el mensaje no repite el encabezado, pero la seccion tocable igual la nombra:
  // el titulo vive dentro del selector, no en el mensaje.
  const unaSola = renderCatalog({ kind: "group", category: "Tecnologia (Audifonos)", products: magimp.slice(0, 3) }, OPTS);
  assert.equal(unaSola[0].sectionTitle, "Tecnologia (Audifonos)");
  assert.ok(!unaSola[0].text.includes("*Tecnologia (Audifonos)*"), "el mensaje no repite lo que el cliente acaba de preguntar");
});

test("con lista tocable se le pide un toque, no que escriba el numero", () => {
  const conBoton = renderCatalog({ kind: "group", category: "audifonos", products: magimp.slice(0, 4) }, OPTS);
  assert.ok(conBoton[conBoton.length - 1].text.includes("Ver opciones"));

  const sinBoton = renderCatalog(
    { kind: "group", category: "audifonos", products: magimp.slice(0, 4) },
    { ...OPTS, interactiveLists: false }
  );
  assert.ok(!sinBoton[sinBoton.length - 1].text.includes("Ver opciones"));
});
