import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCatalog,
  presentedProductIds,
  stripNumberedLines,
  stripLinesAlreadyInBlocks,
  FEW_PRODUCTS_MAX,
  productFacts,
} from "./presenter";
import { resolveProductScopeFrom, type ScopeProduct } from "./scope";
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

// Incidente real 2026-09-16, conversacion cmu4dqbcx0001zi2kxxrf1ge3: el bot le dijo a una clienta que el
// Smartwatch Serie 12 Ultra 3 no tenia unidades. Tenia 15 (negro 7 + gris 8). El presenter leia
// `product.stock`, que es el campo BASE y queda en 0 para todo producto cuyo inventario se lleva por
// color: 12 de los 37 productos activos de ese negocio, 117 unidades, se mostraban "(sin stock)".
// El fixture no lo detectaba porque sus dos productos con variantes repetian el total en el campo base,
// una forma que no existe en produccion. Ahora tienen base 0, como los reales.
test("un producto con el inventario en variantes no se muestra sin stock", () => {
  const ultra = productNamed(magimp, "Serie 12 Ultra 3");
  assert.equal(ultra.stock, 0, "el fixture tiene que reproducir la forma real: base 0");
  const enVariantes = ultra.variants.filter((v) => v.active).reduce((s, v) => s + v.stock, 0);
  assert.equal(enVariantes, 15, "y el inventario real en las variantes");

  const enLista = allText(render("que relojes tienen")).split("\n");
  const linea = enLista.find((l) => l.includes("Serie 12 Ultra 3"));
  assert.ok(linea, `el producto tiene que aparecer en la lista; salio: "${enLista.join(" / ")}"`);
  assert.ok(!linea.includes("sin stock"), `no puede decir sin stock teniendo 15: "${linea}"`);
  assert.ok(linea.includes("15 disponibles"), `tiene que decir 15 disponibles: "${linea}"`);

  const ficha = allText(render("el Serie 12 Ultra 3"));
  assert.ok(!ficha.includes("sin stock"), `la ficha tampoco puede decir sin stock: "${ficha}"`);
  assert.ok(ficha.includes("15 disponibles"), `la ficha tiene que decir 15 disponibles: "${ficha}"`);
});

// ---------------------------------------------------------------------------------------------
// Incidentes reales del 2026-09-16, mismo turno de la Fase B:
//   - cmu4e3q9l001ozi2ka2x1t1b1: el cliente escribio "3" y recibio SEIS mensajes (el modelo escribio la
//     ficha entera y el servidor mando la misma ficha abajo, mas 949 caracteres de descripcion).
//   - cmu4dqbcx0001zi2kxxrf1ge3: "tienes disponible en Negro Matte y Titanio Plateado" cuando las
//     variantes reales son `negro` y `gris`. El bloque no nombraba los colores y el modelo relleno.
// ---------------------------------------------------------------------------------------------

const aurora = loadFixtureCatalog("Aurora Joyas");

function ocurrencias(texto: string, fragmento: string): number {
  let total = 0;
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(fragmento, desde);
    if (i === -1) return total;
    total++;
    desde = i + fragmento.length;
  }
}

/** Lo que el cliente REALMENTE recibe en el turno: la frase del modelo ya filtrada, mas los bloques. */
function loQueRecibeElCliente(fraseDelModelo: string, blocks: { text: string }[]): string[] {
  const frase = stripLinesAlreadyInBlocks(fraseDelModelo, blocks as never);
  return [...(frase.trim() ? [frase] : []), ...blocks.map((b) => b.text)];
}

test("alcance 'one': el nombre y el precio le llegan al cliente UNA sola vez en todo el turno", () => {
  const blocks = render("el Serie 12 Ultra 3");
  assert.equal(blocks.length, 1);
  // El modelo copia la ficha entera, reescribiendo asteriscos y guiones - exactamente lo que hizo en
  // produccion. Ademas escribe una frase de introduccion, que es lo unico que le corresponde.
  const fraseDelModelo = [
    "¡Claro que sí! Mira este:",
    "Reloj Inteligente Smartwatch Serie 12 Ultra 3 (Edición Deportiva / Robusta) - $140.000 (15 disponibles)",
    "- Pantalla Ultra de 49 mm con isla de notificaciones y fondos personalizables",
  ].join("\n");

  const enviado = loQueRecibeElCliente(fraseDelModelo, blocks).join("\n");
  assert.equal(ocurrencias(enviado, "Serie 12 Ultra 3"), 1, `el nombre sale una vez; salio:\n${enviado}`);
  assert.equal(ocurrencias(enviado, "$140.000"), 1, `el precio sale una vez; salio:\n${enviado}`);
  assert.equal(ocurrencias(enviado, "Pantalla Ultra de 49 mm"), 1, `la vineta sale una vez; salio:\n${enviado}`);
  assert.ok(enviado.includes("¡Claro que sí! Mira este:"), "la frase de introduccion se conserva entera");
});

test("una frase de introduccion sola sale tal cual: no se le quita nada", () => {
  const blocks = render("el Serie 12 Ultra 3");
  const frase = "¡Claro! Aquí lo tienes 😊";
  assert.equal(stripLinesAlreadyInBlocks(frase, blocks), frase);
});

test("si al modelo no le queda nada propio, no se manda un mensaje vacio", () => {
  const blocks = render("el Serie 12 Ultra 3");
  const copiaLiteral = blocks[0].text;
  assert.equal(stripLinesAlreadyInBlocks(copiaLiteral, blocks), "");
  // Y tampoco si lo que sobra es puntuacion suelta.
  assert.equal(stripLinesAlreadyInBlocks(`${copiaLiteral}\n...\n•`, blocks), "");
});

test("alcance 'one' con variantes: el bloque nombra los colores reales con su stock", () => {
  const ultra = productNamed(magimp, "Serie 12 Ultra 3");
  assert.deepEqual(
    ultra.variants.map((v) => [v.color, v.stock]),
    [["negro", 7], ["gris", 8]],
    "el fixture tiene que traer las variantes reales de ese producto"
  );

  const ficha = render("el Serie 12 Ultra 3")[0].text;
  assert.ok(ficha.includes("negro (7 disponibles)"), `tiene que nombrar el negro con su stock: "${ficha}"`);
  assert.ok(ficha.includes("gris (8 disponibles)"), `tiene que nombrar el gris con su stock: "${ficha}"`);
});

test("con una variante ya elegida no se listan las demas", () => {
  const scope = resolveProductScopeFrom(magimp, NO_ALIASES, "el Serie 11 Mini negro", []);
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  const ficha = renderCatalog(scope, OPTS)[0].text;
  assert.ok(!ficha.includes("Disponible en:"), `ya eligio color, no se le ofrecen los otros: "${ficha}"`);
});

// 2026-09-16: MAX_DESCRIPTION_LINES se elimino. Cortaba CINCO LINEAS, no cinco caracteristicas, y
// medido en produccion ese mismo dia una descripcion de 34 lineas le dejaba al cliente DOS
// caracteristicas de 31 y un "¿Te cuento el resto?". No hay numero que calibrar: la descripcion va
// entera y cuantas caracteristicas nombrar lo decide el agente.
test("una descripcion larga sale ENTERA: no queda ningun corte fijo", () => {
  const larga = render("el Serie 12 Ultra 3")[0];
  const ultra = productNamed(magimp, "Serie 12 Ultra 3");
  const descripcion = ultra.description.split("\n").map((l) => l.trim()).filter(Boolean);

  assert.ok(descripcion.length > 5, "el fixture tiene que tener mas lineas que el viejo tope, si no la prueba no prueba nada");
  for (const linea of descripcion) {
    assert.ok(larga.text.includes(linea), `falta una linea de la descripcion: "${linea}"`);
  }
  assert.ok(!larga.text.includes("¿Te cuento"), `ya no existe el ofrecimiento del resto: "${larga.text}"`);

  const corta = renderCatalog({ kind: "one", product: aurora[0], variant: null }, OPTS)[0];
  assert.ok(corta.text.includes(aurora[0].description.trim()), "una descripcion corta tambien sale entera");
});

test("el corte nunca parte una linea por la mitad", () => {
  const ficha = render("el Serie 12 Ultra 3")[0].text;
  const completas = new Set(
    productNamed(magimp, "Serie 12 Ultra 3").description.split("\n").map((l) => l.trim()).filter(Boolean)
  );
  const deLaDescripcion = ficha
    .split("\n")
    .filter((l) => !l.startsWith("*") && !l.startsWith("Disponible en:") && !l.startsWith("¿Te cuento"));
  for (const linea of deLaDescripcion) {
    assert.ok(completas.has(linea), `"${linea}" no es una linea completa de la descripcion`);
  }
});

test("la ficha de respaldo trae la descripcion completa, la vea quien la vea", () => {
  const bloque = render("el Serie 12 Ultra 3")[0];
  const ultima = "Garantía: 3 meses por defectos de fábrica";
  assert.ok(bloque.text.includes(ultima), "sin corte, la ultima linea tambien sale");
  assert.ok(bloque.modelText.includes(ultima), "el modelo la ve igual, para poder contestar por ella");
  assert.ok(bloque.modelText.includes("Disponible en: negro (7 disponibles)"), "y ve los colores reales");
});

test("alcance 'group' y 'all': el recorte de descripcion no los toca", () => {
  for (const pedido of ["que relojes tienen", "muéstrame todo el catálogo completo con precios"]) {
    const texto = allText(render(pedido));
    assert.ok(!texto.includes("¿Te cuento"), `una lista no ofrece descripcion: "${pedido}"`);
    assert.ok(!texto.includes("Disponible en:"), `una lista no detalla variantes: "${pedido}"`);
  }
  // Y el texto que ve el modelo es el mismo que sale: solo la ficha de un producto puntual difiere.
  for (const block of render("muéstrame todo el catálogo completo con precios")) {
    assert.equal(block.modelText, block.text);
  }
});

// Incidente real 2026-09-16 (conversacion cmu4gniqe000se82kdrhvrw6d): el cliente pregunto por un
// producto, despues por otro, y volvio al primero. Recibio 4 fotos y 2 videos del primero y 2 fotos del
// segundo, porque el presentador adjuntaba los medios SIEMPRE, sin mirar el registro de lo ya enviado
// (Conversation.mediaSentProductIds), que el camino viejo de get_product_details si consultaba.
test("producto A, producto B, producto A otra vez: los medios de A salen UNA sola vez", () => {
  const yaEnviados: string[] = [];
  const conteoPorProducto = new Map<string, number>();

  // Cada turno se renderiza con el registro tal como quedo despues de los turnos anteriores, que es
  // exactamente lo que hace agent.ts.
  for (const texto of ["el Serie 12 Ultra 3", "el Serie 11 Mini", "volvamos al Serie 12 Ultra 3"]) {
    const scope = resolveProductScopeFrom(magimp, NO_ALIASES, texto, []);
    const blocks = renderCatalog(scope, { ...OPTS, alreadyPresentedProductIds: yaEnviados });
    for (const block of blocks) {
      for (const media of block.media) {
        conteoPorProducto.set(media.productId, (conteoPorProducto.get(media.productId) ?? 0) + media.items.length);
        if (!yaEnviados.includes(media.productId)) yaEnviados.push(media.productId);
      }
    }
  }

  const ultra = productNamed(magimp, "Serie 12 Ultra 3");
  const mini = productNamed(magimp, "Serie 11 Mini");
  assert.equal(
    conteoPorProducto.get(ultra.id),
    ultra.media.length + ultra.variants.flatMap((v) => v.media).length,
    "los medios del Ultra 3 salen una sola vez en toda la conversacion"
  );
  assert.ok((conteoPorProducto.get(mini.id) ?? 0) > 0, "el segundo producto si manda los suyos la primera vez");
});

test("la segunda presentacion de un producto es corta: nombre, precio y stock, sin descripcion ni medios", () => {
  const ultra = productNamed(magimp, "Serie 12 Ultra 3");
  const scope = resolveProductScopeFrom(magimp, NO_ALIASES, "el Serie 12 Ultra 3", []);

  const primera = renderCatalog(scope, OPTS)[0];
  assert.ok(primera.media.length > 0, "la primera vez no cambia nada: van los medios");
  assert.ok(primera.text.includes("Garantía: 3 meses"), "la primera vez sale la descripcion entera");

  const segunda = renderCatalog(scope, { ...OPTS, alreadyPresentedProductIds: [ultra.id] })[0];
  assert.deepEqual(segunda.media, [], "la segunda vez no se reenvia ni una foto");
  assert.ok(segunda.text.includes("$"), "el precio sigue saliendo");
  assert.ok(segunda.text.includes("Serie 12 Ultra 3"), "el nombre sigue saliendo");
  assert.ok(segunda.text.includes("disponibles"), "el stock sigue saliendo");

  const descripcion = ultra.description.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const linea of descripcion) {
    assert.ok(!segunda.text.includes(linea), `el cliente ya leyo la descripcion: "${linea}"`);
  }
  // El modelo si la sigue viendo entera: una pregunta puntual se contesta con el dato real aunque la
  // ficha original ya se haya ido de la ventana de historial.
  assert.ok(segunda.modelText.includes(descripcion[0]), "el modelo conserva la descripcion completa");
});

test("un registro de otro producto no acorta la ficha del que se esta presentando", () => {
  const mini = productNamed(magimp, "Serie 11 Mini");
  const scope = resolveProductScopeFrom(magimp, NO_ALIASES, "el Serie 12 Ultra 3", []);
  const blocks = renderCatalog(scope, { ...OPTS, alreadyPresentedProductIds: [mini.id] });
  assert.ok(blocks[0].media.length > 0, "los medios del Ultra 3 no los toca el registro del Mini");
  assert.ok(blocks[0].text.includes("Garantía: 3 meses"), "y la ficha sale entera");
});

// Un producto armado a mano: el catalogo anonimizado no tiene ninguna variante agotada ni ningun
// producto con una sola unidad, que es justo lo que estos dos casos necesitan.
function productoDePrueba(stock: number, variants: ScopeProduct["variants"]): ScopeProduct {
  return {
    id: "prod-prueba",
    name: "Gorra Tactica",
    description: "Gorra ajustable.",
    category: "Accesorios",
    color: null,
    size: null,
    price: 40000,
    currency: "COP",
    stock,
    media: [],
    variants,
  };
}

function variante(color: string, stock: number, active = true): ScopeProduct["variants"][number] {
  return { id: `var-${color}`, color, size: null, active, stock, media: [] };
}

test("una variante sin stock no se nombra: no se le ofrece al cliente un color que no hay", () => {
  // Caso real 2026-09-16: el bloque escribio "verde camuflado (sin stock)" y el modelo, en ese mismo
  // turno, habia nombrado solo los dos colores que si habia. El bloque empeoraba la respuesta.
  const producto = productoDePrueba(0, [variante("negro", 1), variante("verde camuflado", 0), variante("gris", 4)]);
  const blocks = renderCatalog({ kind: "one", product: producto, variant: null }, OPTS);

  assert.ok(!blocks[0].text.includes("verde camuflado"), `salio: "${blocks[0].text}"`);
  assert.ok(!blocks[0].text.toLowerCase().includes("sin stock"), "y tampoco la etiqueta");
  assert.ok(blocks[0].text.includes("negro"));
  assert.ok(blocks[0].text.includes("gris"));
});

test("con una sola unidad dice 'disponible', no 'disponibles'", () => {
  const producto = productoDePrueba(1, []);
  const blocks = renderCatalog({ kind: "one", product: producto, variant: null }, OPTS);
  assert.ok(blocks[0].text.includes("(1 disponible)"), `salio: "${blocks[0].text}"`);
  assert.ok(!blocks[0].text.includes("1 disponibles"));

  const conVariantes = productoDePrueba(0, [variante("negro", 1), variante("gris", 2)]);
  const variantes = renderCatalog({ kind: "one", product: conVariantes, variant: null }, OPTS)[0].text;
  assert.ok(variantes.includes("negro (1 disponible)"), `salio: "${variantes}"`);
  assert.ok(variantes.includes("gris (2 disponibles)"), "y el plural sigue en plural");
});

// UN SOLO AUTOR (2026-09-16, seccion 11 del plan). Los mismos datos que la ficha, SIN redactar: es lo
// que recibe el agente para escribir el mensaje entero con su voz.

test("productFacts entrega los datos del producto sin redactarlos", () => {
  const product = productNamed(magimp, "Serie 11 Mini");
  const facts = productFacts(product, null, OPTS);

  assert.equal(facts.nombre, product.name);
  assert.equal(facts.precio, "$145.000");
  assert.equal(facts.moneda, "COP");
  assert.equal(facts.varianteElegida, null);
  const lineasDeLaBase = product.description.split("\n").map((l) => l.trim()).filter(Boolean);
  const lineasEntregadas = [...facts.descripcion.presentacion, ...facts.descripcion.caracteristicas];
  assert.deepEqual(lineasEntregadas, lineasDeLaBase, "la descripcion va ENTERA, sin ningun corte");
  // Una variante sin stock no se nombra: nombrarla es ofrecerle al cliente un color que no hay.
  assert.ok(
    facts.variantes.every((v) => v.stock > 0),
    JSON.stringify(facts.variantes)
  );
});

test("productFacts con una variante elegida no ofrece las demas", () => {
  const scope = resolveProductScopeFrom(magimp, NO_ALIASES, "el Serie 11 Mini negro", []);
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;

  const facts = productFacts(scope.product, scope.variant ?? null, OPTS);
  assert.equal(facts.varianteElegida, "Negro");
  assert.deepEqual(facts.variantes, [], "el cliente ya eligio: listar las demas seria ofrecerle otro color");
  assert.equal(facts.stock, scope.variant?.stock);
});

test("productFacts dice lo mismo que la ficha del servidor: el fallback no puede contradecir al agente", () => {
  const product = productNamed(magimp, "Serie 11 Mini");
  const facts = productFacts(product, null, OPTS);
  const bloque = renderCatalog({ kind: "one", product, variant: null }, OPTS)[0];

  assert.ok(bloque.text.includes(facts.nombre));
  assert.ok(bloque.text.includes(facts.precio));
  for (const variante of facts.variantes) {
    assert.ok(bloque.text.includes(variante.nombre), `la ficha tambien nombra "${variante.nombre}"`);
  }
});

test("la descripcion se separa en presentacion y caracteristicas por el titulo, y no se pierde ni una linea", () => {
  // La forma real del producto que motivo el cambio (produccion 2026-09-16, "Smartwatch serie 12 mini"):
  // dos lineas de presentacion, un titulo "Características:" y la lista debajo. Con el tope de 5 lineas
  // al cliente le llegaban DOS caracteristicas de las 31.
  const producto: ScopeProduct = {
    id: "p-hw12",
    name: "Smartwatch serie 12 mini",
    description: [
      "¡Pequeño, pero poderoso! ⌚💚",
      "Conoce el HW12 Mini Smartwatch: diseño moderno, compacto y perfecto para llevar tu estilo a otro nivel.",
      "Características:",
      "Memoria interna de 1 Gb",
      "Siri",
      "Monitor de ritmo cardiaco",
      "Oxígeno en la sangre",
      "Modo deporte",
    ].join("\n"),
    category: "Relojes",
    color: null,
    size: null,
    price: 120000,
    currency: "COP",
    stock: 4,
    media: [],
    variants: [],
  };

  const facts = productFacts(producto, null, OPTS);
  assert.deepEqual(facts.descripcion.presentacion, [
    "¡Pequeño, pero poderoso! ⌚💚",
    "Conoce el HW12 Mini Smartwatch: diseño moderno, compacto y perfecto para llevar tu estilo a otro nivel.",
  ]);
  assert.deepEqual(facts.descripcion.caracteristicas, [
    "Memoria interna de 1 Gb",
    "Siri",
    "Monitor de ritmo cardiaco",
    "Oxígeno en la sangre",
    "Modo deporte",
  ]);
  assert.ok(facts.descripcion.caracteristicas.length > 2, "no hay ningun tope de 5 lineas que deje 2 caracteristicas");
});

test("sin ningun titulo, la descripcion entera va a presentacion y no se inventa una lista", () => {
  const producto: ScopeProduct = {
    id: "p-simple",
    name: "Producto simple",
    description: "Una sola linea de descripcion, sin titulos.",
    category: null,
    color: null,
    size: null,
    price: 1000,
    currency: "COP",
    stock: 1,
    media: [],
    variants: [],
  };

  const facts = productFacts(producto, null, OPTS);
  assert.deepEqual(facts.descripcion.presentacion, ["Una sola linea de descripcion, sin titulos."]);
  assert.deepEqual(facts.descripcion.caracteristicas, []);
});

// ---------------------------------------------------------------------------
// VITRINA DE CATEGORIA (2026-09-17). Business.catalogPhotoScope.
// ---------------------------------------------------------------------------

const CATEGORIA = { ...OPTS, photoScope: "CATEGORY" as const };
const CATALOGO = { ...OPTS, photoScope: "CATALOG" as const };

function scopeDe(text: string) {
  return resolveProductScopeFrom(magimp, NO_ALIASES, text, []);
}

test("con el nivel en producto, una categoria sigue sin mandar una sola foto", () => {
  // El default no cambia el comportamiento de ningun negocio existente: es la razon de que exista.
  const blocks = renderCatalog(scopeDe("que relojes tienen"), OPTS);
  assert.ok(blocks.every((b) => b.media.length === 0));
  assert.ok(allText(blocks).includes("¿De cuál te gustaría ver fotos?"));
});

test("con el nivel en categoria, cada producto de la categoria sale con UNA foto y su pie", () => {
  const scope = scopeDe("que relojes tienen");
  assert.equal(scope.kind, "group");
  if (scope.kind !== "group") return;

  const blocks = renderCatalog(scope, CATEGORIA);
  const media = blocks.flatMap((b) => b.media);
  const conFoto = scope.products.filter((p) => p.media.some((m) => m.type === "IMAGE") || p.variants.some((v) => v.active && v.media.some((m) => m.type === "IMAGE")));

  assert.equal(media.length, conFoto.length, "una entrada de medios por producto que tenga foto");
  assert.ok(media.length > 1, "la categoria del fixture tiene varios productos con foto");
  for (const m of media) {
    assert.equal(m.items.length, 1, "UNA foto por producto, no todo su carrete");
    assert.equal(m.items[0].type, "IMAGE", "la vitrina son fotos, nunca video");
    assert.ok(m.caption, "cada foto lleva pie, o el cliente no sabe cual es cual");
  }
  assert.ok(allText(blocks).includes("Responde a la del que te guste"));
  assert.ok(!allText(blocks).includes("¿De cuál te gustaría ver fotos?"), "ya no se ofrece lo que ya salio");
});

test("el pie de cada foto es EXACTAMENTE la linea numerada que el cliente ya vio", () => {
  // Es lo que hace que "el 3" y la foto que dice "3." no puedan referirse a productos distintos.
  const blocks = renderCatalog(scopeDe("que relojes tienen"), CATEGORIA);
  const lineas = allText(blocks).split("\n");
  for (const m of blocks.flatMap((b) => b.media)) {
    assert.ok(lineas.includes(m.caption ?? ""), `el pie "${m.caption}" no es ninguna linea de la lista`);
  }
});

test("el nivel categoria NO manda fotos del catalogo completo", () => {
  // Pedido explicito del dueno: subir el alcance hasta categoria, no hasta el catalogo entero.
  const scope = scopeDe("que productos tienen");
  assert.equal(scope.kind, "all");
  const blocks = renderCatalog(scope, CATEGORIA);
  assert.ok(blocks.every((b) => b.media.length === 0));
});

test("el nivel catalogo si manda las fotos del catalogo completo", () => {
  const blocks = renderCatalog(scopeDe("que productos tienen"), CATALOGO);
  assert.ok(blocks.flatMap((b) => b.media).length > 0);
});

test("una foto de vitrina no se repite en la misma conversacion", () => {
  const scope = scopeDe("que relojes tienen");
  if (scope.kind !== "group") return assert.fail("se esperaba un grupo");
  const yaVistos = scope.products.map((p) => p.id);
  const blocks = renderCatalog(scope, { ...CATEGORIA, browsePhotoSentProductIds: yaVistos });
  assert.ok(blocks.every((b) => b.media.length === 0), "ninguna foto se manda dos veces");
  assert.ok(allText(blocks).includes("¿De cuál te gustaría ver fotos?"), "sin fotos, vuelve el ofrecimiento");
});

test("elegir un producto de la vitrina da INFORMACION, no mas fotos", () => {
  // Las dos mitades de la misma decision, y por eso van en la misma prueba:
  //  - la ficha sale ENTERA (el cliente nunca leyo la descripcion, solo vio una foto), asi que la
  //    vitrina no puede marcar el producto como "ya presentado";
  //  - y sale SIN un solo medio: eligio POR esa foto, la tiene arriba en el chat, y lo que le falta es
  //    el dato, no otra imagen del mismo aparato.
  const uno = productNamed(magimp, "Combo k11 Mini");
  const blocks = renderCatalog({ kind: "one", product: uno, variant: null }, { ...CATEGORIA, browsePhotoSentProductIds: [uno.id] });

  assert.ok(blocks[0].text.includes("El combo tecnologico mini incluye"), "la descripcion sale entera igual");
  assert.deepEqual(blocks[0].media, [], "no se reenvia ninguna foto del producto que acaba de elegir");
});

test("sin vitrina previa, la ficha de ese mismo producto sigue mandando todas sus fotos", () => {
  // El contraste que prueba que lo de arriba es la vitrina y no un apagado general de medios.
  const uno = productNamed(magimp, "Combo k11 Mini");
  const blocks = renderCatalog({ kind: "one", product: uno, variant: null }, CATEGORIA);
  assert.equal(blocks[0].media[0].items.length, 3);
});

test("los bloques dicen que clase de mensaje son: de ahi sale donde se registra lo enviado", () => {
  assert.equal(renderCatalog(scopeDe("K11 mini"), CATEGORIA)[0].kind, "ficha");
  assert.ok(renderCatalog(scopeDe("que relojes tienen"), CATEGORIA).every((b) => b.kind === "lista"));
});

test("la vitrina no se saltea un producto porque el cliente haya visto su ficha antes", () => {
  // Caso real de produccion, conversacion cmu4e3q9l001ozi2ka2x1t1b1, turno 16:45:54: el cliente pidio
  // los parlantes, el servidor numero 5 y mando 4 fotos. Falto la del numero 2 - tenia dos fotos
  // cargadas y el envio no fallo: el dia anterior habia recibido su ficha completa, quedo anotado en
  // mediaSentProductIds, y la vitrina lo salteo. El cliente veia 1, 3, 4 y 5.
  const scope = scopeDe("que relojes tienen");
  if (scope.kind !== "group") return assert.fail("se esperaba un grupo");
  const segundo = scope.products[1];

  const blocks = renderCatalog(scope, { ...CATEGORIA, alreadyPresentedProductIds: [segundo.id] });
  const conFoto = new Set(blocks.flatMap((b) => b.media).map((m) => m.productId));
  assert.ok(conFoto.has(segundo.id), "la fila de fotos no puede salir con un hueco mudo en el medio");
});

test("pero la MISMA foto de vitrina sigue sin repetirse en la misma conversacion", () => {
  // El contraste: lo que frena una foto es haberla mandado ya, no haber cotizado el producto.
  const scope = scopeDe("que relojes tienen");
  if (scope.kind !== "group") return assert.fail("se esperaba un grupo");
  const segundo = scope.products[1];

  const blocks = renderCatalog(scope, { ...CATEGORIA, browsePhotoSentProductIds: [segundo.id] });
  const conFoto = new Set(blocks.flatMap((b) => b.media).map((m) => m.productId));
  assert.ok(!conFoto.has(segundo.id));
});
