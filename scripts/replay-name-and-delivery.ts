// Replay de turnos REALES contra la logica nueva de nombres y datos de entrega, sin llamar a DeepSeek
// y sin tocar produccion. Existe porque el primer intento de arreglar los nombres se desplego sin esta
// verificacion y rompio tres conversaciones en veinte minutos (2026-09-15).
//
//   node --import tsx scripts/replay-name-and-delivery.ts <archivo.json> [pais]
//
// <pais> es el codigo de pais del negocio cuyos turnos se replayan ("CO" o "MX"); decide la forma de la
// cedula, del celular y las palabras de via (src/config/countries.ts). El script no lee la base, asi que
// no tiene de donde deducirlo: se pasa a mano. Por defecto "CO", que es el pais del negocio piloto.
//
// El JSON es una lista de { conv, who, at, prior, customer }: el mensaje del cliente y el mensaje del
// bot inmediatamente anterior. Se saca con una consulta read-only a la base (ver el comando en el
// historial de la sesion del 2026-09-15).
import { readFileSync } from "node:fs";
import { COUNTRIES, type CountryCode } from "../src/config/countries";
import {
  ASK_NAME_PATTERN,
  extractNameFromAnswer,
  extractSelfIntroducedName,
  extractDeliveryDataFromAnswer,
  extractNameFromDeliveryAnswer,
  stripMarkdownEmphasis,
} from "../src/ai/agent";

type Turn = { conv: string; who: string | null; at: string; prior: string; customer: string };

const ASK_DELIVERY_DATA_PATTERN =
  /\b(datos de (entrega|env[ií]o)|nombre y apellido|nombre completo)\b|\bc[eé]dula\b|\bcelular\b|\bidentificaci[oó]n\b/i;

const file = process.argv[2];
if (!file) {
  console.error("Falta el archivo JSON de turnos.");
  process.exit(1);
}
const paisArg = (process.argv[3] ?? "CO").toUpperCase();
if (!(paisArg in COUNTRIES)) {
  console.error(`Pais desconocido: "${paisArg}". Valores validos: ${Object.keys(COUNTRIES).join(", ")}.`);
  process.exit(1);
}
const pais = paisArg as CountryCode;
const turns: Turn[] = JSON.parse(readFileSync(file, "utf8"));

let guardaNombre = 0;
let guardaDatos = 0;
let rechazos = 0;

console.log(`Turnos a revisar: ${turns.length}\n`);
console.log("=== LO QUE SE GUARDARIA COMO NOMBRE ===");
for (const t of turns) {
  const prior = stripMarkdownEmphasis(t.prior);
  const pidioNombre = ASK_NAME_PATTERN.test(prior);
  const pidioEntrega = ASK_DELIVERY_DATA_PATTERN.test(prior);
  if (!pidioNombre && !pidioEntrega) continue;

  const porRespuesta = pidioNombre ? extractNameFromAnswer(t.customer) : null;
  const porPresentacion = extractSelfIntroducedName(t.customer);
  const porEntrega = pidioEntrega ? extractNameFromDeliveryAnswer(t.customer, pais) : null;
  const nombre = porRespuesta ?? porPresentacion ?? porEntrega;

  const msg = t.customer.replace(/\n/g, " ").slice(0, 58);
  if (nombre) {
    guardaNombre++;
    console.log(`  GUARDA "${nombre}"  <-  "${msg}"  [${t.who}]`);
  } else if (pidioNombre) {
    rechazos++;
    console.log(`  rechaza          <-  "${msg}"  [${t.who}]`);
  }
}

console.log("\n=== LO QUE SE GUARDARIA COMO CEDULA / CELULAR ===");
for (const t of turns) {
  if (!ASK_DELIVERY_DATA_PATTERN.test(stripMarkdownEmphasis(t.prior))) continue;
  const found = extractDeliveryDataFromAnswer(t.customer, pais);
  if (!found.idNumber && !found.deliveryPhone) continue;
  guardaDatos++;
  const partes = [found.idNumber ? `cedula=${found.idNumber}` : null, found.deliveryPhone ? `celular=${found.deliveryPhone}` : null]
    .filter(Boolean)
    .join(" ");
  console.log(`  ${partes}  <-  "${t.customer.replace(/\n/g, " ").slice(0, 58)}"  [${t.who}]`);
}

console.log(`\nResumen: ${guardaNombre} nombres guardados, ${rechazos} respuestas rechazadas, ${guardaDatos} turnos con cedula/celular.`);
