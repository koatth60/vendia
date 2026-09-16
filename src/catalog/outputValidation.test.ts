import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../search/text";
import { renderCatalog } from "./presenter";
import type { ProductScope, ScopeProduct } from "./scope";
import {
  collectCatalogClaims,
  extractPrices,
  validateAgainstCatalog,
  type CatalogFacts,
} from "./outputValidation";

// Pieza 5 del plan de catalogo y medios, MODO SOMBRA. Pruebas PURAS: el catalogo va en memoria, no hay
// base, ni red, ni modelo (regla 2 de src/ai/replay/README.md).
//
// El caso que originó esta pieza es real: conversacion cmu0ehwqx00076k2k64mjaats, 2026-09-15. El bot
// listo "Cargador iPhone $60.000", "Cargador Tipo C $50.000" y "Base de Carga Inalámbrica 3 en 1
// $90.000" en un turno con CERO llamadas a herramientas. La categoria de cargadores de ese negocio
// tiene un solo producto, la bateria portatil de $70.000.

// El catalogo real de MAGByLizN (src/ai/regression/fixtures/catalog.json), recortado a lo que hace
// falta para estas pruebas. Precios en COP, sin decimales.
const CATALOGO: { name: string; price: number }[] = [
  { name: "Batería portátil power bank 12000 mah", price: 70000 },
  { name: "AIRPODS PRO 2", price: 55000 },
  { name: "Bombox 4", price: 125000 },
  { name: "Reloj Inteligente Smartwatch Serie 11 Mini (Edición Compacta y Elegante)", price: 145000 },
  { name: "Audífonos Bluetooth con parlante integrado", price: 70000 },
];

// Las tarifas de envio configuradas tambien son precios reales del negocio: el bot las escribe en
// negrita y marcarlas seria un falso positivo.
const ENVIOS = [12000];

const FACTS: CatalogFacts = {
  priceDigits: new Set([...CATALOGO.map((p) => String(p.price)), ...ENVIOS.map(String)]),
  productNameTokens: CATALOGO.map((p) => new Set(tokenize(p.name))),
};

test("marca los tres cargadores inventados del caso real de produccion", () => {
  const texto = [
    "¡Claro! Estos son nuestros cargadores 😊",
    "",
    "*Cargadores y Cables*",
    "1. *Cargador iPhone* — $60.000",
    "2. *Cargador Tipo C* — $50.000",
    "3. *Base de Carga Inalámbrica 3 en 1* — $90.000",
  ].join("\n");

  const findings = validateAgainstCatalog([texto], FACTS);

  // Los tres precios inventados, marcados.
  const precios = findings.filter((f) => f.kind === "precio_inexistente").map((f) => f.value);
  assert.deepEqual(precios.sort(), ["$50.000", "$60.000", "$90.000"]);

  // Y los tres nombres, que tampoco existen.
  const nombres = findings.filter((f) => f.kind === "producto_inexistente").map((f) => f.value);
  assert.deepEqual(nombres.sort(), ["Base de Carga Inalámbrica 3 en 1", "Cargador Tipo C", "Cargador iPhone"]);

  // Cada hallazgo trae la linea entera: sin eso el dueño ve un numero y no puede juzgar si acerto.
  for (const finding of findings) assert.ok(finding.line.includes("$"), "el hallazgo tiene que traer la linea");
});

test("un mensaje con precios correctos de productos reales no se marca", () => {
  const texto = [
    "Tenemos estos dos:",
    "1. *AIRPODS PRO 2* — $55.000 (3 disponibles)",
    "2. *Bombox 4* — $125.000 (1 disponibles)",
    "El envío a tu ciudad son $12.000.",
  ].join("\n");

  assert.deepEqual(validateAgainstCatalog([texto], FACTS), []);
});

test("el modelo puede abreviar un nombre real sin que se marque", () => {
  // "Audífonos Bluetooth" cabe dentro de "Audífonos Bluetooth con parlante integrado": abreviar es
  // correcto. Agregar palabras que el catalogo no tiene es lo que no lo es.
  const texto = "1. *Audífonos Bluetooth* — $70.000";
  assert.deepEqual(validateAgainstCatalog([texto], FACTS), []);
});

test("un mensaje sin precios ni listas no se marca", () => {
  const texto = [
    "¡Hola! Claro que sí, con gusto te ayudo.",
    "¿Me confirmas para qué ciudad sería el envío?",
    "Trabajamos con 3 transportadoras y el tiempo de entrega es de 2 a 5 días.",
  ].join("\n");

  assert.deepEqual(collectCatalogClaims(texto), []);
  assert.deepEqual(validateAgainstCatalog([texto], FACTS), []);
});

test("un precio suelto en medio de una frase no es el objetivo de esta pieza", () => {
  // No es una lista ni una negrita: es prosa. Esta pieza no valida prosa libre a proposito.
  const texto = "Por $70.000 te llevas la batería portátil, y el envío te sale gratis desde $150.000.";
  assert.deepEqual(validateAgainstCatalog([texto], FACTS), []);
});

test("las lineas del resumen de pedido no se marcan aunque traigan cifras que no son del catalogo", () => {
  // Formato exacto de {{BLOQUE_RESUMEN}} (renderFixedBlocks en agent.ts). El total y los subtotales por
  // linea no son precios del catalogo por definicion, y sus lineas no son ni items de lista ni negrita.
  const texto = ["2x AIRPODS PRO 2 — $110.000", "Envío: $12.000", "Total: $122.000"].join("\n");
  assert.deepEqual(validateAgainstCatalog([texto], FACTS), []);
});

test("los bloques que compone el servidor nunca se marcan", () => {
  // El servidor saca los nombres y los precios de un SELECT, asi que su propia salida tiene que pasar la
  // validacion. Si esto falla, el defecto esta en el validador y no en el modelo.
  const productos: ScopeProduct[] = CATALOGO.map((p, i) => ({
    id: `p${i}`,
    name: p.name,
    description: "",
    category: "Tecnologia",
    color: null,
    size: null,
    price: p.price,
    currency: "COP",
    stock: 3,
    media: [],
    variants: [],
  }));
  const scope: ProductScope = { kind: "all", products: productos };
  const blocks = renderCatalog(scope, { currency: "COP", locale: "es-CO" });

  assert.ok(blocks.length > 0, "el fixture tiene que producir bloques");
  assert.deepEqual(validateAgainstCatalog(blocks.map((b) => b.text), FACTS), []);
});

// Los dos unicos hallazgos reales que dejo el modo sombra en 24 horas (4 turnos de 56, 2026-09-16), tal
// cual quedaron guardados en AgentTurn.shadowFindings. Los dos son FALSOS POSITIVOS: las dos lineas las
// compuso renderCatalog leyendo la base, y el validador las marcaba porque comparaba el nombre con las
// decoraciones que el mismo servidor le habia puesto - el prefijo de numeracion y el sufijo de variante.
//
// Mientras esto no este en cero, activar la Pieza 5 romperia los bloques del propio servidor.

test("no marca los bloques que compuso el servidor: las dos lineas reales del 2026-09-16", () => {
  const facts: CatalogFacts = {
    priceDigits: new Set(["145000", "125000"]),
    productNameTokens: [
      new Set(tokenize("Reloj Inteligente Smartwatch Serie 11 Mini (Edición Compacta y Elegante)")),
      new Set(tokenize("Smartwatch hello plum")),
    ],
  };

  const lineas = [
    "*5. Reloj Inteligente Smartwatch Serie 11 Mini* — $145.000",
    "2. *Smartwatch hello plum (Negro)* — $125.000 (1 disponibles)",
  ];

  assert.deepEqual(validateAgainstCatalog(lineas, facts), []);
});

test("sacarle la decoracion a un nombre inventado no lo vuelve real", () => {
  const facts: CatalogFacts = {
    priceDigits: new Set(["145000"]),
    productNameTokens: [new Set(tokenize("Reloj Inteligente Smartwatch Serie 11 Mini"))],
  };

  const findings = validateAgainstCatalog(["*5. Cargador iPhone Magnetico (Negro)* — $145.000"], facts);

  assert.deepEqual(
    findings.map((f) => f.value),
    ["5. Cargador iPhone Magnetico (Negro)"],
    "el hallazgo conserva el nombre tal cual estaba escrito, decoraciones incluidas"
  );
});

test("extractPrices corta la cifra donde termina y no se come el stock", () => {
  assert.deepEqual(extractPrices("1. *X* — $145.000 (3 disponibles)"), [{ raw: "145.000", digits: "145000" }]);
  assert.deepEqual(extractPrices("sin cifras"), []);
  // El signo solo, sin digitos detras, no es un precio.
  assert.deepEqual(extractPrices("cuesta $ y algo"), []);
});

test("el texto que se valida no se modifica", () => {
  // La garantia del modo sombra. validateAgainstCatalog devuelve hallazgos y nada mas: no hay forma de
  // que el texto salga distinto de como entro, ni siquiera cuando marca.
  const original = "1. *Cargador iPhone* — $60.000";
  const entrada = [original];
  const findings = validateAgainstCatalog(entrada, FACTS);

  assert.ok(findings.length > 0, "este texto tiene que marcar");
  assert.deepEqual(entrada, [original]);
  assert.equal(entrada[0], original);
});
