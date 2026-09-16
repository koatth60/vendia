import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCatalog, presentedProductIds, stripNumberedLines, FEW_PRODUCTS_MAX } from "./presenter";
import { resolveProductScopeFrom } from "./scope";
import { loadFixtureCatalog, productNamed } from "./fixtureCatalog";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 2). Puras: sin base de
// datos, sin red, sin modelo.

const NO_ALIASES = new Map<string, string>();
const magimp = loadFixtureCatalog("MAGByLizN");
const OPTS = { currency: "COP", locale: "es-CO" };

function render(text: string, lastPresented: string[] = []) {
  return renderCatalog(resolveProductScopeFrom(magimp, NO_ALIASES, text, lastPresented), OPTS);
}

function allText(blocks: { text: string }[]): string {
  return blocks.map((b) => b.text).join("\n");
}

test("un alcance 'none' no produce ningun bloque", () => {
  assert.deepEqual(render("hola buenas"), []);
});

test("un producto puntual sale con su precio real y con sus fotos pegadas al mensaje", () => {
  const blocks = render("K11 mini");
  assert.equal(blocks.length, 1, "un producto es un solo mensaje");
  assert.ok(blocks[0].text.includes("Combo k11 Mini"));
  assert.ok(blocks[0].text.includes("$98.000"), `precio real del catalogo; salio: "${blocks[0].text}"`);
  assert.equal(blocks[0].media.length, 1, "un grupo de medios, el del producto");
  assert.equal(blocks[0].media[0].items.length, 3, "las 3 fotos cargadas salen en el mismo turno");
  assert.ok(!blocks[0].text.includes("¿De cuál"), "con un producto no se pregunta cual, se manda");
});

test("con color nombrado, solo salen las fotos de esa variante", () => {
  const scope = resolveProductScopeFrom(magimp, NO_ALIASES, "el Serie 11 Mini negro", []);
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  const blocks = renderCatalog(scope, OPTS);
  assert.ok(blocks[0].text.includes("(Negro)"));
  // Esa variante no tiene medios propios en el fixture, asi que cae a los generales del producto -
  // nunca a los de OTRA variante, que seria mandarle el color equivocado.
  assert.equal(blocks[0].media[0].items.length, 3);
});

test("un grupo de categoria sale numerado, sin fotos, y ofrece elegir", () => {
  const blocks = render("que relojes tienen");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].media, [], "un grupo NO manda fotos");
  assert.ok(blocks[0].text.includes("1. "));
  assert.ok(blocks[0].text.includes("2. "));
  assert.ok(blocks[0].text.includes("¿De cuál te gustaría ver fotos?"));
});

test("el catalogo completo sale como un mensaje por categoria, con numeracion continua entre mensajes", () => {
  const blocks = render("muéstrame todo el catálogo completo con precios");
  assert.ok(blocks.length > 1, "un mensaje por categoria, no uno solo gigante");

  // La numeracion tiene que ser 1..N corrida a traves de TODOS los mensajes: la directiva SELECCION POR
  // NUMERO depende de que "el 3" resuelva contra la lista entera, no contra el ultimo grupo.
  const numbers: number[] = [];
  for (const block of blocks) {
    for (const line of block.text.split("\n")) {
      const dot = line.indexOf(". ");
      if (dot <= 0) continue;
      const head = line.slice(0, dot);
      const value = Number(head);
      if (Number.isInteger(value) && String(value) === head) numbers.push(value);
    }
  }
  assert.deepEqual(numbers, Array.from({ length: magimp.length }, (_, i) => i + 1));
  assert.equal(presentedProductIds(blocks).length, magimp.length);
  assert.ok(blocks.every((b) => b.media.length === 0), "el catalogo completo no manda fotos");
});

test("solo se ofrece elegir UNA vez, en el ultimo mensaje", () => {
  const blocks = render("muéstrame todo el catálogo completo con precios");
  const offers = blocks.filter((b) => b.text.includes("¿De cuál te gustaría ver fotos?"));
  assert.equal(offers.length, 1);
  assert.equal(offers[0], blocks[blocks.length - 1]);
});

test("nunca se emite un producto que no venga en la entrada", () => {
  const blocks = render("que relojes tienen");
  const texto = allText(blocks);
  for (const product of magimp) {
    const enAlcance = product.category?.includes("Relojes");
    if (!enAlcance) {
      assert.ok(!texto.includes(product.name), `"${product.name}" no esta en alcance y no debia aparecer`);
    }
  }
});

test("elegir dos numeros de la lista manda los dos productos con sus fotos", () => {
  const presented = [productNamed(magimp, "AIRPODS PRO 2").id, productNamed(magimp, "AIRPODS MAX").id];
  const blocks = render("el 1 y el 2", presented);
  assert.equal(blocks.length, FEW_PRODUCTS_MAX);
  assert.ok(blocks.every((b) => b.media.length === 1), "con pocos productos, las fotos van con el mensaje");
});

test("stripNumberedLines saca la lista que el modelo escriba de mas y deja la frase", () => {
  const texto = "¡Claro! Estos son nuestros relojes:\n1. Serie 11 — $145.000\n2. Serie 12 — $140.000\n¿Cuál te gusta?";
  assert.equal(stripNumberedLines(texto), "¡Claro! Estos son nuestros relojes:\n¿Cuál te gusta?");
});

test("stripNumberedLines no toca un precio ni una fecha que no sean una linea numerada", () => {
  assert.equal(stripNumberedLines("Cuesta $145.000 con envio"), "Cuesta $145.000 con envio");
  assert.equal(stripNumberedLines("Llega el 3. de octubre"), "Llega el 3. de octubre");
});
