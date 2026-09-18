import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client";

// GENERAR CONVERSACIONES DE PRUEBA CONTRA EL BOT, PARA MIRARLAS DESDE LA BANDEJA (2026-09-18).
//
// Pedido del dueño: poder ver cómo contesta el bot en el panel, con el catálogo, la personalidad y las
// instrucciones REALES del negocio, sin escribirle a ninguna clienta de verdad. Esto es esa herramienta,
// y es más útil que la regresión para encontrar fallas de conversación: se ve el hilo completo, con sus
// fotos y sus bloques, en la misma pantalla donde la dueña trabaja.
//
// CÓMO FUNCIONA. Se manda al webhook el mismo cuerpo que manda Meta, desde un número inventado. El
// cliente queda marcado `simulated`, y hacia un cliente simulado la capa de salida NO llama a la API de
// Meta (ver src/whatsapp/outbound.ts): guarda el mensaje y sigue. Todo lo demás es real -- la cola de
// entrada, el turno, el catálogo, los bloques del servidor, los incidentes.
//
// NO LE PUEDE LLEGAR A NADIE: el número no es de nadie y la llamada a Meta no se hace.
//
// COSTO: cada mensaje es un turno de verdad contra DeepSeek. Centavos, pero no es gratis.
//
// USO:
//   npx tsx scripts/simular-cliente.ts "hola" "que parlantes tienen?" "como te pago?"
//   NEGOCIO="MAGByLizN" npx tsx scripts/simular-cliente.ts "hola"        # por defecto, el único conectado
//   TELEFONO=573000000007 npx tsx scripts/simular-cliente.ts "y el envio?" # sigue una charla ya empezada
//   URL=http://localhost:3000 npx tsx scripts/simular-cliente.ts "hola"   # contra el servidor local
//
// En el servidor: `cd /opt/vendia && npx tsx scripts/simular-cliente.ts "hola"`.

const URL_BASE = process.env.URL ?? "http://localhost:3000";
const NOMBRE_DEL_NEGOCIO = process.env.NEGOCIO ?? "MAGByLizN";
/** Prefijo reservado para los números de prueba. Ningún cliente real empieza así. */
const PREFIJO_SIMULADO = "5730000000";
const ESPERA_ENTRE_MENSAJES_MS = 12_000;

/** El cuerpo tal como lo manda Meta (ver collectWebhookBatch en src/routes/whatsapp.ts). */
function cuerpoDeWebhook(phoneNumberId: string, desde: string, texto: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "simulacion",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573000000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Cliente de prueba" }, wa_id: desde }],
              messages: [
                {
                  from: desde,
                  id: `wamid.SIMULADO.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: texto },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function main() {
  const mensajes = process.argv.slice(2);
  if (mensajes.length === 0) {
    console.error('Uso: npx tsx scripts/simular-cliente.ts "hola" "que parlantes tienen?"');
    process.exit(64);
  }

  const negocio = await prisma.business.findFirst({
    where: { name: NOMBRE_DEL_NEGOCIO },
    select: { id: true, name: true, whatsappPhoneNumberId: true },
  });
  if (!negocio) {
    console.error(`No existe ningun negocio llamado "${NOMBRE_DEL_NEGOCIO}". Pasa NEGOCIO="..." con el nombre exacto.`);
    process.exit(65);
  }
  if (!negocio.whatsappPhoneNumberId) {
    console.error(`"${negocio.name}" no tiene WhatsApp conectado: el webhook no sabria a que negocio mandar el mensaje.`);
    process.exit(65);
  }

  // Un teléfono de prueba fijo continúa la MISMA conversación; sin él, cada corrida empieza una nueva.
  const telefono = process.env.TELEFONO ?? `${PREFIJO_SIMULADO}${Math.floor(Math.random() * 9) + 1}`;
  if (!telefono.startsWith(PREFIJO_SIMULADO)) {
    console.error(`El telefono de prueba tiene que empezar con ${PREFIJO_SIMULADO}: es lo que garantiza que no sea de nadie.`);
    process.exit(64);
  }

  // El cliente se marca `simulated` ANTES del primer mensaje. Si no existiera todavía, lo crea el
  // webhook y el marcado llegaría tarde: el primer envío saldría hacia Meta de verdad.
  const cliente = await prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId: negocio.id, phoneNumber: telefono } },
    create: { businessId: negocio.id, phoneNumber: telefono, simulated: true, name: "Cliente de prueba" },
    update: { simulated: true },
    select: { id: true },
  });

  console.log(`Negocio:  ${negocio.name}`);
  console.log(`Telefono: ${telefono}  (simulado)`);
  console.log(`Webhook:  ${URL_BASE}/webhook`);
  console.log(`Miralo en la Bandeja del panel, como cualquier otra conversacion.\n`);

  for (const [i, texto] of mensajes.entries()) {
    const respuesta = await fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoDeWebhook(negocio.whatsappPhoneNumberId, telefono, texto)),
    });
    console.log(`[${i + 1}/${mensajes.length}] ${respuesta.status} <- ${JSON.stringify(texto)}`);
    // El webhook contesta 200 al instante y procesa después (E20). Se espera a que el bot conteste antes
    // de mandar el siguiente, que es lo que hace una persona.
    if (i < mensajes.length - 1) await new Promise((r) => setTimeout(r, ESPERA_ENTRE_MENSAJES_MS));
  }

  // Se espera al turno, no a un reloj fijo.
  const limite = Date.now() + 90_000;
  let ultimoConteo = 0;
  while (Date.now() < limite) {
    const cuantos = await prisma.message.count({
      where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" },
    });
    if (cuantos > ultimoConteo) {
      ultimoConteo = cuantos;
      await new Promise((r) => setTimeout(r, 4000));
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const conversacion = await prisma.conversation.findFirst({
    where: { customerId: cliente.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!conversacion) {
    console.log("\n(todavia no hay conversacion: el webhook no llego a procesar)");
    process.exit(0);
  }

  const filas = await prisma.message.findMany({
    where: { conversationId: conversacion.id },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true, mediaType: true },
  });
  console.log(`\n--- La conversacion (${filas.length} mensajes) ---`);
  for (const m of filas) {
    const marca = m.mediaType ? `[${m.mediaType}] ` : "";
    console.log(`${m.createdAt.toISOString().slice(11, 19)} ${m.role.padEnd(9)} ${marca}${m.content.replace(/\n/g, " | ").slice(0, 120)}`);
  }

  const turnos = await prisma.agentTurn.findMany({
    where: { conversationId: conversacion.id },
    orderBy: { createdAt: "asc" },
    select: { scope: true, toolsCalled: true, iterations: true, mediaProductIds: true },
  });
  console.log(`\n--- Los turnos (${turnos.length}) ---`);
  for (const t of turnos) {
    console.log(`scope=${t.scope} tools=[${t.toolsCalled.join(", ")}] iteraciones=${t.iterations} fotos=${t.mediaProductIds.length}`);
  }

  const incidentes = await prisma.agentIncident.findMany({
    where: { conversationId: conversacion.id },
    select: { kind: true, detail: true },
  });
  console.log(`\n--- Incidentes (${incidentes.length}) ---`);
  for (const i of incidentes) console.log(`${i.kind}: ${i.detail.replace(/\n/g, " ").slice(0, 140)}`);

  console.log(`\nConversacion: ${conversacion.id}`);
  console.log(`Para seguir esta misma charla: TELEFONO=${telefono} npx tsx scripts/simular-cliente.ts "..."`);
  console.log(`Para borrarla despues:         npx tsx scripts/borrar-simulados.ts`);
  process.exit(0);
}

void main();
