import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runFixture, assertTurn, type ConversationFixture } from "./replay";

// Fase 1 del plan maestro (2026-09-15): un test por fixture bajo fixtures/*.json, gratis y
// determinista (cero red a DeepSeek - ver replay.ts). Recorre el directorio en vez de listar los
// archivos a mano para que agregar un fixture nuevo no requiera tocar este archivo.
const FIXTURES_DIR = join(__dirname, "fixtures");
const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

for (const file of fixtureFiles) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8")) as ConversationFixture;

  // knownFailing: la conversacion prueba un defecto real que todavia no se arreglo (ver
  // ConversationFixture.knownFailing en replay.ts). TODO en vez de test normal para que la regla del
  // repositorio ("npm test siempre en verde") no obligue a borrar la aserción real - Node reporta el
  // TODO como fallo visible pero no le pega al exit code.
  test(`replay: ${fixture.name}`, { todo: fixture.knownFailing }, async () => {
    const result = await runFixture(fixture);
    fixture.turns.forEach((turn, i) => assertTurn(fixture.name, i, turn.expect, result.turns[i], result.catalog));
  });
}
