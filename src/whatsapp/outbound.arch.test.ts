import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Criterio de aceptacion de la Fase 7 (ONIX-PLAN-MAESTRO.md): cero llamadas directas a
// src/whatsapp/client.ts fuera de src/whatsapp/outbound.ts. La regla solo vale si algo la sostiene: sin
// esta prueba, el proximo sitio que necesite mandar un mensaje vuelve a importar el cliente crudo y se
// salta la ventana de 24h, los reintentos y el registro del fallo - que es exactamente como se
// acumularon los 15 puntos de perdida silenciosa que esta fase vino a cerrar.
//
// Por eso outbound.ts reexporta tambien lo que no es envio (descarga de medios, plantillas, foto de
// perfil): la regla es literal, no una lista de excepciones que se estira sola.
const SRC = path.join(process.cwd(), "src");
const CLIENT_MODULE = path.join(SRC, "whatsapp", "client.ts");

// Los unicos dos archivos que pueden nombrar al cliente: la capa que lo envuelve, y la prueba del
// propio cliente.
const ALLOWED = new Set([path.join(SRC, "whatsapp", "outbound.ts"), path.join(SRC, "whatsapp", "client.test.ts")]);

function typescriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...typescriptFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

// Saca el especificador de modulo de una linea de import/export, sin expresiones regulares: busca
// `from "` y se queda con lo que hay hasta la comilla de cierre.
function importedModule(line: string): string | null {
  const marker = line.indexOf('from "');
  if (marker === -1) return null;
  const start = marker + 'from "'.length;
  const end = line.indexOf('"', start);
  if (end === -1) return null;
  return line.slice(start, end);
}

test("nada fuera de outbound.ts importa src/whatsapp/client.ts", () => {
  const offenders: string[] = [];

  for (const file of typescriptFiles(SRC)) {
    if (ALLOWED.has(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const specifier = importedModule(line);
      if (!specifier || !specifier.startsWith(".")) return;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (`${resolved}.ts` === CLIENT_MODULE || resolved === CLIENT_MODULE) {
        offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Estos archivos importan whatsapp/client.ts directamente y se saltan la capa de salida (ventana de 24h, reintentos, registro del fallo). Importa desde whatsapp/outbound.ts:\n  ${offenders.join("\n  ")}`
  );
});

test("el recorrido de archivos encuentra algo (la prueba anterior no pasa por estar vacia)", () => {
  const files = typescriptFiles(SRC);
  assert.ok(files.length > 50, `se esperaban muchos archivos .ts bajo src/, se encontraron ${files.length}`);
  assert.ok(files.includes(CLIENT_MODULE), "src/whatsapp/client.ts tiene que estar entre los archivos recorridos");
});
