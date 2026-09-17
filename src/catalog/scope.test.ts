import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProductScopeFrom, numericSelection, suppressBrowsingScope, type ScopeProduct } from "./scope";
import { loadFixtureCatalog, productNamed } from "./fixtureCatalog";

// Fase B del plan de catalogo y medios (ONIX-PLAN-CATALOGO-Y-MEDIOS.md, pieza 1). Funciones puras: el
// catalogo sale del fixture anonimizado de produccion, no hay base de datos, red ni modelo.

const NO_ALIASES = new Map<string, string>();
const magimp = loadFixtureCatalog("MAGByLizN");
const aurora = loadFixtureCatalog("Aurora Joyas");

function scopeOf(text: string, lastPresented: string[] = [], products: ScopeProduct[] = magimp) {
  return resolveProductScopeFrom(products, NO_ALIASES, text, lastPresented);
}

test("un mensaje que no es de presentacion no resuelve ningun alcance", () => {
  assert.equal(scopeOf("hola buenas tardes").kind, "none");
  assert.equal(scopeOf("gracias!").kind, "none");
  assert.equal(scopeOf("hago la transferencia hoy mismo").kind, "none");
  assert.equal(scopeOf("").kind, "none");
});

test("un producto nombrado resuelve a ese producto y a ninguno mas", () => {
  // Caso real de produccion (2026-09-15/16): "K11 mini" despues de una lista. El bot contestaba "Aqui
  // te muestro el Combo k11 Mini:" y CERO fotos, aunque el producto tiene 3 cargadas.
  const scope = scopeOf("K11 mini");
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  assert.equal(scope.product.name, "Combo k11 Mini");
  assert.equal(scope.product.media.length, 3, "el producto real tiene 3 fotos cargadas");
  assert.equal(scope.variant, null, "no se nombro color, asi que no hay variante elegida");
});

test("un color nombrado junto al producto elige la variante de ese color", () => {
  const scope = scopeOf("quiero el Serie 11 Mini en negro");
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  assert.ok(scope.product.name.includes("Serie 11 Mini"));
  assert.equal(scope.variant?.color, "Negro");
});

test("una categoria configurada del negocio resuelve a grupo, con TODOS sus productos y ninguno de otra", () => {
  const scope = scopeOf("que relojes tienen");
  assert.equal(scope.kind, "group");
  if (scope.kind !== "group") return;
  const names = scope.products.map((p) => p.name);
  assert.ok(names.every((n) => n.includes("Serie 11 Mini") || n.includes("Serie 12 Ultra")));
  assert.ok(!names.some((n) => n.includes("AIRPODS")), "un reloj pedido no puede traer audifonos");
});

test("una categoria con un solo producto se trata como producto puntual: no hay nada que elegir", () => {
  // "Anillos" tiene un solo producto en el catalogo de Aurora Joyas. Listarlo numerado y preguntar
  // "¿de cual querés ver fotos?" ante una lista de uno no tiene sentido.
  const scope = scopeOf("tienen anillos?", [], aurora);
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  assert.equal(scope.product.name, "Anillo Aurora en plata 925 con circonia");
});

test("pedir el catalogo completo resuelve a 'all' con el catalogo activo entero", () => {
  // Caso real de produccion (2026-09-15): "muestrame todo el catalogo completo con precios". El modelo
  // contesto sin llamar ninguna herramienta e invento una categoria entera de cargadores.
  const scope = scopeOf("muéstrame todo el catálogo completo con precios");
  assert.equal(scope.kind, "all");
  if (scope.kind !== "all") return;
  assert.equal(scope.products.length, magimp.length);
});

test("'el 3' resuelve contra la ultima lista presentada, nunca adivinando", () => {
  const presented = [
    productNamed(magimp, "AIRPODS PRO 2").id,
    productNamed(magimp, "PARLANTE TIPO ALEXA").id,
    productNamed(magimp, "Combo k11 Mini").id,
  ];
  const scope = scopeOf("el 3", presented);
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  assert.equal(scope.product.name, "Combo k11 Mini");
});

test("'el 3' sin lista previa no resuelve nada: no se inventa a que se referia", () => {
  assert.equal(scopeOf("el 3").kind, "none");
});

test("un numero fuera del rango de la lista presentada no resuelve a ningun producto", () => {
  const presented = [productNamed(magimp, "AIRPODS PRO 2").id];
  assert.equal(scopeOf("el 7", presented).kind, "none");
});

test("dos numeros eligen dos productos de la lista", () => {
  const presented = [
    productNamed(magimp, "AIRPODS PRO 2").id,
    productNamed(magimp, "PARLANTE TIPO ALEXA").id,
    productNamed(magimp, "Combo k11 Mini").id,
  ];
  const scope = scopeOf("el 1 y el 2", presented);
  assert.equal(scope.kind, "few");
  if (scope.kind !== "few") return;
  assert.deepEqual(scope.products.map((p) => p.name), ["AIRPODS PRO 2", "PARLANTE TIPO ALEXA"]);
});

test("un numero dentro de una frase no se lee como seleccion (numericSelection exige que todo sea numero)", () => {
  assert.deepEqual(numericSelection("el 3"), [3]);
  assert.deepEqual(numericSelection("el 1 y el 2"), [1, 2]);
  assert.deepEqual(numericSelection("quiero 3 relojes"), [], "hay una palabra ademas del numero");
  assert.deepEqual(numericSelection("mi cedula es 1098765432"), []);
  assert.deepEqual(numericSelection("hola"), []);
});

test("un catalogo vacio nunca resuelve alcance, ni siquiera ante un pedido de catalogo explicito", () => {
  assert.equal(resolveProductScopeFrom([], NO_ALIASES, "muéstrame el catálogo", []).kind, "none");
});

test("los alias de categoria del propio negocio resuelven la categoria", () => {
  // "smartwatch" -> "reloj" configurado por el negocio en CategoryAlias: un cliente que escribe
  // "smartwatch" cae en la misma categoria que quien escribe "relojes", sin vocabulario cableado.
  const aliases = new Map([["smartwatch", "reloj"]]);
  const scope = resolveProductScopeFrom(magimp, aliases, "tienen smartwatches?", []);
  assert.equal(scope.kind, "group", "una categoria configurada le gana a un puntaje por palabras sueltas");
  if (scope.kind !== "group") return;
  assert.ok(scope.products.length > 1);
});

test("un producto nombrado le gana a la categoria cuando el cliente uso una palabra de su NOMBRE", () => {
  // "smartwatch" es palabra de categoria Y de varios nombres; "v20" solo esta en un nombre.
  const scope = scopeOf("quiero el Smartwatch V20");
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  assert.equal(scope.product.name, "Smartwatch V20 Caballero");
});

test("un numero suelto en una frase no elige el producto que lo tiene en el nombre", () => {
  // Defecto real de produccion (2026-09-16, turno 19:02:06): el servidor habia presentado una lista
  // numerada de 7 audifonos y el cliente contesto "El número 5 y el número 6". numericSelection no lo
  // toma (la palabra "numero" rompe la condicion de "todo el mensaje es numero"), asi que bajaba al
  // match por texto y el "6" coincidia con el nombre de *Parlante Charge 6*: al cliente le salieron la
  // ficha y las fotos de un parlante mientras el agente le comparaba los dos audifonos.
  //
  // En este catalogo el equivalente es "9", que solo aparece en el nombre de "Smartwatch gen 9".
  assert.equal(scopeOf("El número 9").kind, "none", "un digito no identifica un producto por nombre");
  assert.equal(scopeOf("el número 5 y el número 6").kind, "none");
});

test("sacarle el digito al match por nombre no rompe los nombres que lo llevan", () => {
  // La palabra de verdad del nombre sigue mandando: lo que se ignora es el numero de modelo suelto.
  const bombox = scopeOf("tienen el bombox 4?");
  assert.equal(bombox.kind, "one");
  if (bombox.kind !== "one") return;
  assert.equal(bombox.product.name, "Bombox 4");

  const gen9 = scopeOf("me interesa el smartwatch gen 9");
  assert.equal(gen9.kind, "one");
  if (gen9.kind !== "one") return;
  assert.equal(gen9.product.name, "Smartwatch gen 9");
});

test("la seleccion por posicion sigue saliendo de la ultima lista presentada, no del nombre", () => {
  // El camino correcto para un numero suelto: ids reales de lo que se presento, nunca el nombre.
  const presented = [productNamed(magimp, "AIRPODS MAX").id, productNamed(magimp, "Smartwatch gen 9").id];
  const scope = scopeOf("el 1", presented);
  assert.equal(scope.kind, "one");
  if (scope.kind !== "one") return;
  assert.equal(scope.product.name, "AIRPODS MAX", "gana la posicion de la lista, no el digito del nombre");
});

// ==============================================================================================
// El cliente que ya compro no esta navegando el catalogo (2026-09-17)
// ==============================================================================================

test("con el cliente en post-venta, una categoria nombrada al pasar no dispara la vidriera", () => {
  // El turno exacto de produccion (00:59:11): Andres ya tenia su reloj comprado y cerrado, escribio
  // "Oye confirmado lo del reloj, mañana a que horas llegaria", y el servidor le mando los 6 smartwatches
  // con precios y stock preguntandole de cual queria ver fotos.
  const texto = "Oye confirmado lo del reloj, mañana a qué horas más o menos llegaría";
  const navegando = scopeOf(texto);
  assert.equal(navegando.kind, "group", "sin post-venta el alcance de categoria sigue igual que hoy");

  assert.equal(suppressBrowsingScope(navegando, texto, true).kind, "none");
  assert.equal(suppressBrowsingScope(navegando, texto, false).kind, "group", "sin post-venta no se suprime nada");
});

test("en post-venta, un pedido explicito de catalogo SI se responde", () => {
  // El error opuesto seria negarle la vidriera a quien la pide con todas las letras.
  const texto = "muéstrame todo el catálogo completo con precios";
  const scope = scopeOf(texto);
  assert.equal(scope.kind, "all");
  assert.equal(suppressBrowsingScope(scope, texto, true).kind, "all");
});

test("en post-venta, nombrar un producto concreto sigue resolviendo a ese producto", () => {
  // Un cliente que ya compro y pregunta por OTRA cosa tiene que poder verla.
  const texto = "y el Smartwatch V20 cuanto sale?";
  const scope = scopeOf(texto);
  assert.equal(scope.kind, "one");
  assert.equal(suppressBrowsingScope(scope, texto, true).kind, "one");
});

test("suprimir la vidriera nunca toca un alcance que ya era 'none' ni uno de pocos productos", () => {
  const pocos = scopeOf("el 1 y el 2", [
    productNamed(magimp, "AIRPODS PRO 2").id,
    productNamed(magimp, "PARLANTE TIPO ALEXA").id,
  ]);
  assert.equal(pocos.kind, "few");
  assert.equal(suppressBrowsingScope(pocos, "el 1 y el 2", true).kind, "few");
  assert.equal(suppressBrowsingScope({ kind: "none" }, "gracias", true).kind, "none");
});
