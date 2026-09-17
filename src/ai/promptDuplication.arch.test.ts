import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// UNA REGLA DE CONVERSACION SE ESCRIBE UNA SOLA VEZ (2026-09-17).
//
// El defecto que esta prueba existe para atrapar, cometido y detectado el mismo dia: se agrego a un
// mensaje de sistema compuesto por el SERVIDOR la frase "producto, direccion y forma de pago se
// confirman con el cliente, uno por uno". El prompt base dice, desde el 2026-09-13 y a pedido de la
// duena, que todos los datos de entrega se piden JUNTOS en un solo mensaje. Dos textos distintos
// diciendole al modelo como preguntar.
//
// Ninguna prueba podia verlo: los dos son prosa valida, los dos compilan, y el conflicto solo aparece
// en la respuesta que le llega a un cliente. Lo encontro el dueno leyendo el mensaje de vuelta.
//
// COMO LO DETECTA, sin una lista de reglas escrita a mano (que se desactualizaria sola): se extraen las
// frases del prompt base y los textos de los mensajes de sistema del servidor, y se busca cualquier
// secuencia larga de palabras que aparezca en los DOS. Una coincidencia de esa longitud no es
// casualidad del idioma: es la misma instruccion escrita dos veces.
//
// La regla de fondo esta en el CLAUDE.md del repositorio: los hechos y los efectos se fuerzan, la
// conversacion no. Un mensaje que escribe el servidor lleva DATOS.

/**
 * Secuencias que coinciden pero NO son una regla de conversacion repetida. Cada una lleva por que.
 *
 * Una entrada aca es una decision, no un atajo para poner la prueba en verde: si lo que se repite es una
 * instruccion sobre como hablarle al cliente, se borra de uno de los dos lados - no se agrega aca.
 */
const NO_SON_REGLAS: { frase: string; porque: string }[] = [
  {
    frase: "direccion de envio forma de pago",
    porque:
      "Son ETIQUETAS de campos del pedido, no una instruccion. En systemPrompt.ts enumeran que datos " +
      "faltan; en agent.ts son los renglones de la ficha que se le pasa al generador del mensaje de " +
      "cierre ('- Direccion de envio: ...', '- Forma de pago: ...'). Los dos nombran el mismo dato, " +
      "ninguno dice como pedirlo.",
  },
];

const SRC = path.join(process.cwd(), "src");
const PROMPT_FILE = path.join(SRC, "ai", "prompts", "systemPrompt.ts");
const AGENT_FILE = path.join(SRC, "ai", "agent.ts");

/** Largo de la secuencia compartida a partir del cual deja de ser casualidad del idioma. */
const SHINGLE_WORDS = 6;

/** Texto plano de un archivo fuente: se quitan comentarios e interpolaciones, queda la prosa. */
function proseOf(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join(" ")
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ");
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(words: string[], size: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/**
 * Los textos que el SERVIDOR le pasa al modelo como `role: "system"` dentro de agent.ts. No se parsea
 * TypeScript: se toma la prosa de las plantillas del archivo, que es donde viven esos mensajes. Alcanza
 * porque lo que se busca es una repeticion literal larga, no una estructura.
 */
function serverSystemMessages(): string {
  const source = proseOf(AGENT_FILE);
  const trozos: string[] = [];
  // Cada literal de plantilla del archivo. Los mensajes de sistema son varios de ellos; incluir alguno
  // de mas no genera falsos positivos, porque lo que se compara despues es contra el prompt base.
  for (const match of source.matchAll(/`([^`]{40,})`/g)) trozos.push(match[1]);
  return trozos.join(" \n ");
}

test("una regla de conversacion no esta escrita en el prompt base Y en un mensaje del servidor", () => {
  const basePrompt = shingles(normalize(proseOf(PROMPT_FILE)), SHINGLE_WORDS);
  const servidor = normalize(serverSystemMessages());

  const permitidas = new Set(NO_SON_REGLAS.map((e) => e.frase));
  const repetidas: string[] = [];
  for (const s of shingles(servidor, SHINGLE_WORDS)) {
    if (basePrompt.has(s) && !permitidas.has(s)) repetidas.push(s);
  }
  repetidas.sort();

  assert.deepEqual(
    repetidas,
    [],
    "Estas secuencias estan escritas en src/ai/prompts/systemPrompt.ts Y en un mensaje de sistema de " +
      "src/ai/agent.ts. Una instruccion sobre COMO conversar se escribe una sola vez, en el prompt base; " +
      "los mensajes del servidor llevan datos. Si lo que se repite es un dato y no una regla, movelo o " +
      "reformulalo:\n  " +
      repetidas.join("\n  ")
  );
});

test("cada excepcion sigue siendo una coincidencia real: una lista que se pudre sola no sirve", () => {
  // Si una frase permitida deja de aparecer en los dos lados, la excepcion sobra y hay que borrarla -
  // si no, la lista crece con entradas muertas y un dia tapa una repeticion de verdad.
  const basePrompt = shingles(normalize(proseOf(PROMPT_FILE)), SHINGLE_WORDS);
  const servidor = shingles(normalize(serverSystemMessages()), SHINGLE_WORDS);
  for (const entrada of NO_SON_REGLAS) {
    assert.ok(
      basePrompt.has(entrada.frase) && servidor.has(entrada.frase),
      `La excepcion "${entrada.frase}" ya no aparece en los dos archivos: sacala de NO_SON_REGLAS.`
    );
    assert.ok(entrada.porque.length > 40, `La excepcion "${entrada.frase}" tiene que explicar por que no es una regla.`);
  }
});

test("el detector mira archivos reales y no pasa por estar vacio", () => {
  // Sin esto, cualquier cambio que rompa la extraccion dejaria la prueba anterior en verde para siempre.
  assert.ok(shingles(normalize(proseOf(PROMPT_FILE)), SHINGLE_WORDS).size > 200, "el prompt base tiene que aportar frases");
  assert.ok(shingles(normalize(serverSystemMessages()), SHINGLE_WORDS).size > 50, "agent.ts tiene que aportar frases");
});
