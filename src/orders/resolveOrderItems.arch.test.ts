import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Bug de produccion (2026-09-15): src/routes/admin/conversations.ts llamaba a resolveOrderItems pero
// solo desestructuraba `items` y `unresolved` - `needsAttribute` (un producto con variantes sin
// color/talla resuelto, ver el comentario en orders/service.ts) se descartaba en silencio: ni entraba al
// pedido ni aparecia en ningun error, el pedido se creaba corto una linea sin que nadie se enterara. La
// ruta de la IA (src/ai/tools.ts) si lo maneja - la regla nunca estuvo escrita en ningun sitio que un
// tercer llamador pudiera copiar. Esta prueba la sostiene: falla si un llamador nuevo (o este mismo)
// vuelve a ignorar needsAttribute, sin depender de que alguien se acuerde.
//
// No basta con que `needsAttribute` aparezca en la desestructuracion (eso solo demuestra que el nombre
// esta escrito, no que se use) - exige que el token aparezca otra vez despues de la llamada, en la misma
// zona del archivo, senal de que algo lo lee y actua en consecuencia.
const SRC = path.join(process.cwd(), "src");
const SERVICE_MODULE = path.join(SRC, "orders", "service.ts");
const CALL = "resolveOrderItems(";

// El propio modulo que define resolveOrderItems, y los tests que la ejercitan en aislamiento (no son
// "llamadores" de un flujo real que pueda perder datos silenciosamente).
const EXCLUDED = new Set([SERVICE_MODULE]);

function typescriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...typescriptFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

// Ubica el "(" que abre la llamada y devuelve el indice del ")" que la cierra, contando profundidad de
// parentesis - una llamada multilinea con argumentos anidados (como los dos sitios reales de tools.ts)
// no se puede ubicar con un indexOf simple del proximo ")".
function findCallEnd(content: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < content.length; i++) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

test("todo llamador real de resolveOrderItems maneja needsAttribute", () => {
  const offenders: string[] = [];

  for (const file of typescriptFiles(SRC)) {
    if (EXCLUDED.has(file)) continue;
    const content = readFileSync(file, "utf8");

    let searchFrom = 0;
    while (true) {
      const callIdx = content.indexOf(CALL, searchFrom);
      if (callIdx === -1) break;
      const openParenIdx = callIdx + CALL.length - 1;
      const closeParenIdx = findCallEnd(content, openParenIdx);
      searchFrom = callIdx + CALL.length;
      if (closeParenIdx === -1) continue;

      // Ventana antes de la llamada: ahi vive la desestructuracion ("const { items, unresolved,
      // needsAttribute } = ..."), incluyendo la forma ternaria de tools.ts donde resolveOrderItems es
      // solo una de las dos ramas.
      const before = content.slice(Math.max(0, callIdx - 500), callIdx);
      // Ventana despues del cierre: ahi debe estar el chequeo que actua sobre needsAttribute (un
      // `if (needsAttribute.length > 0)` en los dos sitios reales hoy).
      const after = content.slice(closeParenIdx, closeParenIdx + 1500);

      const destructured = before.includes("needsAttribute");
      const handled = after.includes("needsAttribute");

      if (!destructured || !handled) {
        const reason = !destructured
          ? "no desestructura needsAttribute del resultado"
          : "desestructura needsAttribute pero nunca lo vuelve a usar despues de la llamada";
        offenders.push(`${path.relative(process.cwd(), file)}:${lineOf(content, callIdx)}: ${reason}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Estos llamadores de resolveOrderItems() no manejan needsAttribute - un producto con variantes sin color/talla resuelto se va a perder en silencio del pedido:\n  ${offenders.join("\n  ")}`
  );
});

test("el recorrido de archivos encuentra al menos un llamador real (la prueba anterior no pasa por estar vacia)", () => {
  const callers = typescriptFiles(SRC).filter((f) => !EXCLUDED.has(f) && readFileSync(f, "utf8").includes(CALL));
  assert.ok(callers.length >= 2, `se esperaban al menos 2 archivos que llaman resolveOrderItems(, se encontraron ${callers.length}`);
});
