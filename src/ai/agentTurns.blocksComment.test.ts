import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guarda contra la deriva de un comentario que ya mintio una vez. Hasta 282c8f1, AgentTurn.blocks
// siempre correspondia a un mensaje aparte que el cliente habia recibido, y el comentario del schema lo
// decia asi ("Es la respuesta real del bot"). Desde que existe la marca {{BLOQUE_CATALOGO}}, el bloque
// se guarda igual pero puede no haber salido como mensaje: quien lea esa columna para auditar tiene que
// mirar catalogInlined o va a contar mensajes que nunca existieron.
//
// Es una prueba de documentacion, no de comportamiento: el comportamiento (que el bloque se guarde en
// los dos casos) lo prueban los dos tests de catalogInlined en agent.catalogScope.test.ts.

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

function comentarioDe(campo: string): string {
  const modelo = schema.slice(schema.indexOf("model AgentTurn {"));
  const lineas = modelo.slice(0, modelo.indexOf("\n}")).split("\n");
  const indice = lineas.findIndex((l) => l.trim().startsWith(`${campo} `));
  assert.ok(indice > 0, `no se encontro el campo ${campo} en model AgentTurn`);
  const comentario: string[] = [];
  for (let i = indice - 1; i >= 0 && lineas[i].trim().startsWith("//"); i--) {
    comentario.unshift(lineas[i].trim().replace(/^\/\/\s?/, ""));
  }
  return comentario.join(" ");
}

test("el comentario de AgentTurn.blocks no promete que el bloque haya salido como mensaje", () => {
  const comentario = comentarioDe("blocks");

  assert.ok(
    !/respuesta real del bot/i.test(comentario),
    `desde 282c8f1 el bloque puede no haber salido como mensaje propio, asi que no es "la respuesta real del bot": "${comentario}"`
  );
  assert.ok(
    /catalogInlined/.test(comentario),
    `el comentario tiene que mandar a catalogInlined para distinguir los dos casos: "${comentario}"`
  );
});
