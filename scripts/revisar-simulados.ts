import "dotenv/config";
import { prisma } from "../src/db/client";

// LEER TODAS LAS CONVERSACIONES DE PRUEBA DE CORRIDO (2026-09-18).
//
// El resumen de `guiones-de-prueba.ts` dice cuántas salieron mal contando incidentes. Eso encuentra lo
// que el servidor ya sabe que está mal, y no encuentra lo que sólo se ve leyendo: un precio inventado,
// una promesa que nadie va a cumplir, una respuesta que no contesta la pregunta.
//
// Esto vuelca los hilos enteros, en orden, recortados para que se puedan leer cien de una sentada.
//
//   npx tsx scripts/revisar-simulados.ts                      # todos
//   GUION=compra npx tsx scripts/revisar-simulados.ts         # solo un tipo (por el nombre del cliente)
//   SOSPECHOSAS=1 npx tsx scripts/revisar-simulados.ts        # solo las que tienen algo raro
//   LARGO=400 npx tsx scripts/revisar-simulados.ts            # cuánto de cada mensaje se muestra

const NEGOCIO = process.env.NEGOCIO ?? "Boutique Alondra";
const LARGO = Number(process.env.LARGO ?? 220);

/**
 * Señales que se calculan, no se opinan.
 *
 * Ninguna es por sí sola un defecto: son las cosas que, si aparecen, hay que ir a leer. Un hueco de
 * bloque fijo o una cifra que no salió son defectos seguros; "prometió consultar" puede ser correcto
 * si de verdad se abrió la consulta, y por eso se mira contra PendingOwnerQuestion y no contra el texto.
 */
const SENALES: { nombre: string; mira: (texto: string) => boolean }[] = [
  { nombre: "HUECO_DE_BLOQUE", mira: (t) => /\{\{[A-Z_]+\}\}/.test(t) },
  { nombre: "CIFRA_VACIA", mira: (t) => /\b(COP|\$)\s*(\.|,|$|\s[a-zA-Z])/.test(t) },
  { nombre: "PRECIO_CERO", mira: (t) => /\$\s?0([^0-9]|$)/.test(t) },
  { nombre: "NaN_O_UNDEFINED", mira: (t) => /\bNaN\b|\bundefined\b|\bnull\b|\[object Object\]/.test(t) },
  { nombre: "PROMETE_CONSULTAR", mira: (t) => /\b(consult|confirm|pregunt|revis)\w*\b.{0,30}\b(equipo|due[ñn][oa]s?)\b|\b(equipo|due[ñn][oa]s?)\b.{0,30}\b(consult|confirm|pregunt|revis)/i.test(t) },
  { nombre: "PROMETE_VOLVER", mira: (t) => /\b(ya (te )?(te )?)?(te )?(escribo|aviso|respondo|confirmo)\b.{0,20}\b(en un momento|enseguida|ahorita|ya mismo|en breve)/i.test(t) },
  { nombre: "DICE_NO_TENER_CATALOGO", mira: (t) => /no (tengo|tenemos) (acceso|el catalogo|catalogo)/i.test(t) },
  { nombre: "SE_DISCULPA_POR_ERROR", mira: (t) => /\b(disculpa|perdon|lo siento)\b.{0,40}\b(error|confusion|equivoqu)/i.test(t) },
];

async function main() {
  const negocio = await prisma.business.findFirst({ where: { name: NEGOCIO }, select: { id: true, name: true } });
  if (!negocio) {
    console.error(`No existe "${NEGOCIO}".`);
    process.exit(65);
  }

  const clientes = await prisma.customer.findMany({
    where: { businessId: negocio.id, simulated: true },
    orderBy: { phoneNumber: "asc" },
    select: {
      id: true,
      phoneNumber: true,
      name: true,
      conversations: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          intent: true,
          messages: {
            orderBy: { createdAt: "asc" },
            select: { role: true, content: true, mediaType: true, createdAt: true },
          },
          order: { select: { summary: true, totalAmount: true, shippingCost: true, paymentMethodLabel: true, fulfillmentStatus: true } },
          pendingOwnerQuestions: { select: { kind: true, resolvedAt: true } },
        },
      },
    },
  });

  // AgentTurn y AgentIncident guardan `conversationId` pero Conversation no tiene la relacion inversa,
  // asi que no se pueden pedir con un include: se traen de una sola consulta y se reparten por id.
  const idsDeConversacion = clientes.flatMap((c) => c.conversations.map((v) => v.id));
  const [turnos, incidentes] = await Promise.all([
    prisma.agentTurn.findMany({
      where: { conversationId: { in: idsDeConversacion } },
      select: { conversationId: true, toolsCalled: true, scope: true, effectAuthor: true },
    }),
    prisma.agentIncident.findMany({
      where: { conversationId: { in: idsDeConversacion } },
      select: { conversationId: true, kind: true, detail: true },
    }),
  ]);
  const turnosPorConversacion = new Map<string, typeof turnos>();
  for (const t of turnos) {
    if (!t.conversationId) continue;
    turnosPorConversacion.set(t.conversationId, [...(turnosPorConversacion.get(t.conversationId) ?? []), t]);
  }
  const incidentesPorConversacion = new Map<string, typeof incidentes>();
  for (const i of incidentes) {
    if (!i.conversationId) continue;
    incidentesPorConversacion.set(i.conversationId, [...(incidentesPorConversacion.get(i.conversationId) ?? []), i]);
  }

  let total = 0;
  let mostradas = 0;
  const conteoDeSenales = new Map<string, number>();

  for (const cliente of clientes) {
    for (const conv of cliente.conversations) {
      total++;
      const respuestas = conv.messages.filter((m) => m.role === "ASSISTANT");
      const textoDelBot = respuestas.map((m) => m.content).join("\n");

      const turnosDeEsta = turnosPorConversacion.get(conv.id) ?? [];
      const incidentesDeEsta = incidentesPorConversacion.get(conv.id) ?? [];

      const senales = SENALES.filter((s) => s.mira(textoDelBot)).map((s) => s.nombre);
      // "Prometió consultar" sólo es señal si NO hay consulta real que la respalde. Con una
      // PendingOwnerQuestion abierta, la frase es verdad y no hay nada que revisar.
      const conConsultaReal = conv.pendingOwnerQuestions.length > 0;
      const senalesReales = senales.filter((s) => !(s === "PROMETE_CONSULTAR" && conConsultaReal));
      if (respuestas.length === 0) senalesReales.push("SIN_RESPUESTA");
      for (const s of senalesReales) conteoDeSenales.set(s, (conteoDeSenales.get(s) ?? 0) + 1);

      const sospechosa = senalesReales.length > 0 || incidentesDeEsta.length > 0;
      if (process.env.SOSPECHOSAS && !sospechosa) continue;
      if (process.env.GUION && !(cliente.name ?? "").includes(process.env.GUION)) continue;
      mostradas++;

      console.log(`\n${"=".repeat(100)}`);
      console.log(`${cliente.phoneNumber}  ${cliente.name ?? "(sin nombre)"}  estado=${conv.status}${conv.intent ? ` intent=${conv.intent}` : ""}`);
      if (senalesReales.length > 0) console.log(`SEÑALES: ${senalesReales.join(", ")}`);
      for (const i of incidentesDeEsta) console.log(`INCIDENTE ${i.kind}: ${i.detail.replace(/\n/g, " ").slice(0, 160)}`);
      const herramientas = [...new Set(turnosDeEsta.flatMap((t) => t.toolsCalled))];
      console.log(`herramientas: ${herramientas.length > 0 ? herramientas.join(", ") : "NINGUNA"}`);
      if (conv.order) {
        console.log(
          `PEDIDO: ${conv.order.summary.replace(/\n/g, " ").slice(0, 90)} | total ${conv.order.totalAmount} | envio ${conv.order.shippingCost ?? "-"} | pago ${conv.order.paymentMethodLabel ?? "-"}`,
        );
      }
      console.log("-".repeat(100));
      for (const m of conv.messages) {
        const quien = m.role === "USER" ? "CLIENTE" : m.role === "ASSISTANT" ? "  ONIX " : `  ${m.role}`;
        const cuerpo = m.mediaType ? `[${m.mediaType}] ${m.content ?? ""}` : m.content ?? "";
        console.log(`${quien} | ${cuerpo.replace(/\n+/g, " | ").slice(0, LARGO)}`);
      }
    }
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`${total} conversaciones simuladas en ${negocio.name}; ${mostradas} mostradas.`);
  if (conteoDeSenales.size === 0) {
    console.log("Ninguna señal.");
  } else {
    for (const [s, n] of [...conteoDeSenales].sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
  }
  process.exit(0);
}

void main();
