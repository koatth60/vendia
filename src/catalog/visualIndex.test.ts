import { test } from "node:test";
import assert from "node:assert/strict";
import { bestVisualMatch, visualScore, visualTokens, type VisualCandidate } from "./visualIndex";

// El caso real del 2026-09-18 01:59 UTC, con las descripciones que el modelo de vision produce de cada
// lado. La foto de la clienta era un reloj REDONDO, dorado, de correa de eslabones. El bot le mando dos
// relojes deportivos de 49 mm porque la comparacion se hacia contra el NOMBRE del producto, donde la
// palabra "redondo" no existe.

const FOTO_DE_LA_CLIENTA =
  "Reloj inteligente de caja redonda, dorado, con correa metalica de eslabones, esfera circular con agujas digitales, aspecto elegante y compacto";

const CATALOGO: VisualCandidate[] = [
  {
    productId: "serie-11-mini",
    productName: "Reloj Inteligente Smartwatch Serie 11 Mini",
    description:
      "Reloj inteligente de caja redonda y compacta, dorado, correa metalica de eslabones, esfera circular, aspecto elegante tipo joya",
  },
  {
    productId: "serie-12-ultra",
    productName: "Reloj Inteligente Smartwatch Serie 12 Ultra 3",
    description:
      "Reloj inteligente deportivo de caja rectangular grande, negro, correa de silicona perforada, bisel robusto, aspecto resistente",
  },
  {
    productId: "combo-t2000",
    productName: "COMBO SMARTWATCH T2000 ULTRA",
    description:
      "Reloj inteligente rectangular de 49 mm, negro, correa de silicona, viene en caja de combo con audifonos y correas de repuesto",
  },
];

test("el reloj redondo del caso real resuelve al Serie 11 Mini, no a los deportivos", () => {
  const resultado = bestVisualMatch(FOTO_DE_LA_CLIENTA, CATALOGO);
  assert.equal(resultado.ambiguous, false);
  assert.equal(resultado.match?.productId, "serie-11-mini");
});

test("dos productos casi identicos no se resuelven a cara o cruz: quedan en duda", () => {
  // Es lo que el bot hizo mal ese dia: mandar "los dos modelos que mas se parecen". Con dos candidatos
  // pegados, la respuesta correcta es preguntar, no elegir.
  const dosNegrosIguales: VisualCandidate[] = [
    { productId: "a", productName: "Ultra A", description: "Reloj inteligente rectangular negro, correa de silicona, bisel robusto, 49 mm" },
    { productId: "b", productName: "Ultra B", description: "Reloj inteligente rectangular negro, correa de silicona, bisel robusto, 49 mm" },
  ];
  const resultado = bestVisualMatch("Reloj inteligente rectangular negro con correa de silicona, bisel robusto", dosNegrosIguales);
  assert.equal(resultado.match, null);
  assert.equal(resultado.ambiguous, true);
  assert.equal(resultado.candidates.length, 2);
});

test("una foto que no se parece a nada del catalogo no fuerza un ganador", () => {
  const resultado = bestVisualMatch("Licuadora blanca de vidrio con base plastica y botones rojos", CATALOGO);
  assert.equal(resultado.match, null);
  assert.equal(resultado.ambiguous, false, "no hay duda: es que no esta");
});

test("tener cinco fotos cargadas no le da ventaja a un producto", () => {
  // Se toma la MEJOR foto de cada producto, no la suma: si no, el producto mas fotografiado ganaria
  // siempre.
  const conMuchasFotos: VisualCandidate[] = [
    ...CATALOGO,
    { productId: "serie-12-ultra", productName: "Serie 12 Ultra 3", description: "Reloj deportivo negro de perfil" },
    { productId: "serie-12-ultra", productName: "Serie 12 Ultra 3", description: "Reloj deportivo negro en la muñeca" },
    { productId: "serie-12-ultra", productName: "Serie 12 Ultra 3", description: "Caja del reloj deportivo negro" },
  ];
  assert.equal(bestVisualMatch(FOTO_DE_LA_CLIENTA, conMuchasFotos).match?.productId, "serie-11-mini");
});

test("las palabras que tiene toda ficha visual no cuentan como parecido", () => {
  // "producto", "foto", "color", "pantalla" aparecen en casi cualquier descripcion: si contaran, el
  // parecido lo definiria el largo del texto.
  const tokens = visualTokens("En la foto se ve un producto, color visible, pantalla y fondo");
  assert.equal(tokens.size, 0);
});

test("el puntaje mide cuanto de lo que muestra la clienta esta en el producto", () => {
  const cliente = visualTokens("reloj redondo dorado eslabones");
  assert.equal(visualScore(cliente, "reloj redondo dorado eslabones"), 1);
  assert.equal(visualScore(cliente, "reloj redondo"), 0.5);
  // Una ficha larguisima que no comparte nada sigue en cero: no gana por tamaño.
  assert.equal(visualScore(cliente, "licuadora blanca de vidrio con base plastica y botones rojos grandes"), 0);
});

// El dato que el servidor le agrega al turno. Es un HECHO ("corresponde a X"), no una instruccion: que
// hacer con una duda sigue siendo conversacion, y eso es del modelo.
test("con un solo ganador, el turno recibe el producto identificado", async () => {
  const { describeMatchForTurn } = await import("../ai/photoIndex");
  const texto = describeMatchForTurn(bestVisualMatch(FOTO_DE_LA_CLIENTA, CATALOGO));
  assert.ok(texto);
  assert.match(texto, /Serie 11 Mini/);
  assert.match(texto, /productId: serie-11-mini/);
});

test("con duda, el turno recibe la duda y los dos candidatos, no un ganador inventado", async () => {
  const { describeMatchForTurn } = await import("../ai/photoIndex");
  const dosIguales: VisualCandidate[] = [
    { productId: "a", productName: "Ultra A", description: "Reloj rectangular negro correa silicona bisel robusto" },
    { productId: "b", productName: "Ultra B", description: "Reloj rectangular negro correa silicona bisel robusto" },
  ];
  const texto = describeMatchForTurn(bestVisualMatch("Reloj rectangular negro correa silicona bisel robusto", dosIguales));
  assert.ok(texto);
  assert.match(texto, /NO pudo distinguir/);
  assert.match(texto, /Ultra A/);
  assert.match(texto, /Ultra B/);
});

test("sin parecido no se le agrega nada al turno", async () => {
  const { describeMatchForTurn } = await import("../ai/photoIndex");
  assert.equal(describeMatchForTurn(bestVisualMatch("Licuadora blanca de vidrio", CATALOGO)), null);
});
