import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { maskPhone } from "./logging";

// Fase 8, punto 9 del plan maestro (2026-09-15).

test("maskPhone deja solo los ultimos cuatro digitos", () => {
  assert.equal(maskPhone("573001234567"), "***4567");
  assert.equal(maskPhone("+57 300 123 4567"), "***4567");
  assert.equal(maskPhone(null), "(sin numero)");
  assert.equal(maskPhone(undefined), "(sin numero)");
  assert.equal(maskPhone(""), "(sin numero)");
  // Un valor corto no se puede enmascarar a medias sin quedar entero: se tapa completo.
  assert.equal(maskPhone("1234"), "***");
});

test("con cuatro digitos no se puede llamar a nadie, pero si distinguir dos conversaciones", () => {
  assert.notEqual(maskPhone("573001234567"), maskPhone("573009999999"));
  assert.equal(maskPhone("573001234567").includes("30012"), false);
});

// La regla vale mientras nadie escriba la siguiente linea de registro con el telefono crudo. Estas
// eran las tres del webhook que lo hacian.
test("el webhook no vuelca telefonos crudos ni el mensaje entero en los registros", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "routes", "whatsapp.ts"), "utf8");
  const logLines = source
    .split("\n")
    .filter((line) => line.includes("console.log(") || line.includes("console.error("));

  for (const line of logLines) {
    assert.equal(
      line.includes("status.recipient_id") && !line.includes("maskPhone"),
      false,
      `registra el telefono del destinatario sin enmascarar: ${line.trim()}`
    );
    assert.equal(
      line.includes("JSON.stringify(message)"),
      false,
      `vuelca el mensaje entero, que lleva el telefono y el texto del cliente: ${line.trim()}`
    );
  }
});
