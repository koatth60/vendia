import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFaqForModel, FAQ_BLOCK_MAX_ENTRIES, type FaqFact } from "./faq";

// Las preguntas frecuentes entran al turno como dato. Todo puro: no toca base, no llama a DeepSeek.
//
// La entrada de abajo es la real de MAGByLizN, la que el bot NO leyo el 2026-09-17 cuando el cliente
// pregunto "Donde se ubican" y contesto "esa informacion no esta disponible por el momento".
const UBICACION: FaqFact = {
  pregunta: "¿De qué ciudad son ustedes? ¿Tienen tienda física?",
  respuesta: "Somos una tienda 100% virtual ubicada en Bogotá. Hacemos envíos a todo el país por Interrapidísimo.",
};

test("la respuesta que el bot no encontro viaja en el bloque", () => {
  const texto = formatFaqForModel([UBICACION]);
  assert.ok(texto);
  assert.match(texto, /PREGUNTAS FRECUENTES DE ESTE NEGOCIO/);
  assert.match(texto, /tienda 100% virtual ubicada en Bogotá/);
});

test("un negocio sin preguntas frecuentes no paga ni un token", () => {
  assert.equal(formatFaqForModel([]), null);
});

test("el bloque es dato: no lleva ninguna instruccion de que contestar", () => {
  const texto = formatFaqForModel([UBICACION])!;
  // Sin verbos de instruccion sobre la conversacion: que decir y como decirlo sigue siendo del agente.
  assert.doesNotMatch(texto, /\b(nunca|siempre|no inventes|no niegues|usa ask_owner|revisa si)\b/i);
});

test("una FAQ que crecio sin control no puede inflar el prompt sin tope", () => {
  const muchas: FaqFact[] = Array.from({ length: FAQ_BLOCK_MAX_ENTRIES + 25 }, (_, i) => ({
    pregunta: `pregunta ${i}`,
    respuesta: `respuesta ${i}`,
  }));
  const texto = formatFaqForModel(muchas)!;
  assert.match(texto, /"pregunta 0"/);
  assert.match(texto, new RegExp(`"pregunta ${FAQ_BLOCK_MAX_ENTRIES - 1}"`));
  assert.doesNotMatch(texto, new RegExp(`"pregunta ${FAQ_BLOCK_MAX_ENTRIES}"`));
});

test("las 16 entradas reales de MAGByLizN caben holgadas en el turno", () => {
  // El costo que decidio esta etapa: ~600 tokens, identicos turno a turno, o sea cacheados. Una sola
  // llamada a la herramienta que se borro costaba una iteracion entera del loop, que es mas.
  const dieciseis: FaqFact[] = Array.from({ length: 16 }, () => ({
    pregunta: UBICACION.pregunta,
    respuesta: UBICACION.respuesta,
  }));
  const texto = formatFaqForModel(dieciseis)!;
  assert.ok(texto.length < 4000, `el bloque de 16 entradas no deberia pasar de 4.000 caracteres, mide ${texto.length}`);
});
