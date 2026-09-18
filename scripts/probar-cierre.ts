import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client";

// ¿CUÁNTAS VECES HAY QUE CONFIRMAR PARA QUE EL PEDIDO SE CREE? (2026-09-18).
//
// Los guiones de compra no cerraban ningún pedido, y el hilo mostraba al bot pidiendo confirmación una
// y otra vez con el `saleState` ya completo. Antes de proponer un arreglo hay que separar dos cosas que
// se parecen:
//
//   - el bot cierra, pero pide confirmación de más (molesto, no roto)
//   - el bot no cierra nunca por más que se le insista (roto)
//
// Esto lo mide: lleva la compra hasta el final y después manda confirmaciones, de a una, hasta que
// aparezca el pedido o hasta agotar el límite. La respuesta es un número, no una opinión.
//
//   NEGOCIO="Boutique Alondra" npx tsx scripts/probar-cierre.ts
//   INSISTENCIAS=12 npx tsx scripts/probar-cierre.ts

const URL_BASE = process.env.URL ?? "http://localhost:3000";
const NEGOCIO = process.env.NEGOCIO ?? "Boutique Alondra";
const INSISTENCIAS = Number(process.env.INSISTENCIAS ?? 8);
const TELEFONO = process.env.TELEFONO ?? "573000999001";
const ESPERA_MAXIMA_MS = 75_000;

const APERTURA = [
  "hola, quiero comprar",
  "quiero un smartwatch",
  "el mas economico esta bien",
  "soy Carlos Perez, cedula 1020304050, celular 3001112233, vivo en la Calle 10 #5-20, barrio Chapinero, Bogota",
  "quiero 1 solo, y todo contraentrega: producto y envio al recibir",
];

/** Se dicen distinto a propósito: si el bot se traba por la redacción y no por el estado, se nota. */
const CONFIRMACIONES = [
  "si, confirmo",
  "listo, cierra el pedido por favor",
  "si, todo correcto",
  "confirmado, hazlo",
  "dale, registra el pedido",
  "si señor, cierralo ya",
  "todo bien, procede",
  "confirmo el pedido, por favor registralo",
  "si",
  "cierra el pedido",
  "correcto",
  "hazlo ya por favor",
];

function cuerpoDeWebhook(phoneNumberId: string, desde: string, texto: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "cierre",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573000000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Prueba de cierre" }, wa_id: desde }],
              messages: [
                {
                  from: desde,
                  id: `wamid.CIERRE.${randomUUID()}`,
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
  const negocio = await prisma.business.findFirst({
    where: { name: NEGOCIO },
    select: { id: true, name: true, whatsappPhoneNumberId: true },
  });
  if (!negocio?.whatsappPhoneNumberId) {
    console.error(`No existe "${NEGOCIO}" o no tiene WhatsApp conectado.`);
    process.exit(65);
  }

  const cliente = await prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId: negocio.id, phoneNumber: TELEFONO } },
    create: { businessId: negocio.id, phoneNumber: TELEFONO, simulated: true },
    update: { simulated: true, name: null, idNumber: null, deliveryPhone: null, address: null },
    select: { id: true },
  });
  const conversaciones = (await prisma.conversation.findMany({ where: { customerId: cliente.id }, select: { id: true } })).map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversation: { customerId: cliente.id } } });
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customerId: cliente.id } } });
  await prisma.agentTurn.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.agentIncident.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.billableChat.deleteMany({ where: { customerId: cliente.id } });
  await prisma.saleState.deleteMany({ where: { conversation: { customerId: cliente.id } } });
  await prisma.order.deleteMany({ where: { customerId: cliente.id } });
  await prisma.conversation.deleteMany({ where: { customerId: cliente.id } });

  const enviar = async (texto: string) => {
    const antes = await prisma.message.count({ where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" } });
    await fetch(`${URL_BASE}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoDeWebhook(negocio.whatsappPhoneNumberId!, TELEFONO, texto)),
    });
    const limite = Date.now() + ESPERA_MAXIMA_MS;
    while (Date.now() < limite) {
      const ahora = await prisma.message.count({ where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" } });
      if (ahora > antes) {
        await new Promise((r) => setTimeout(r, 3000));
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  for (const texto of APERTURA) {
    process.stdout.write(`. `);
    await enviar(texto);
  }
  console.log("\nCompra armada. Ahora se insiste en confirmar:\n");

  for (let i = 0; i < Math.min(INSISTENCIAS, CONFIRMACIONES.length); i++) {
    await enviar(CONFIRMACIONES[i]);
    const pedido = await prisma.order.findFirst({ where: { customerId: cliente.id }, select: { summary: true, totalAmount: true } });
    const estado = await prisma.saleState.findFirst({ where: { conversation: { customerId: cliente.id } }, select: { blockedBy: true } });
    console.log(`confirmacion ${i + 1}: "${CONFIRMACIONES[i]}" -> pedido=${pedido ? "SI" : "no"} blockedBy=${estado?.blockedBy ?? "null"}`);
    if (pedido) {
      console.log(`\nEL PEDIDO SE CREO EN LA CONFIRMACION NUMERO ${i + 1}.`);
      console.log(`  ${pedido.summary.replace(/\n/g, " ").slice(0, 100)} | total ${pedido.totalAmount}`);
      process.exit(0);
    }
  }

  const turnos = await prisma.agentTurn.findMany({
    where: { conversationId: { in: conversaciones } },
    orderBy: { createdAt: "asc" },
    select: { toolsCalled: true },
  });
  console.log(`\nNINGUN PEDIDO despues de ${Math.min(INSISTENCIAS, CONFIRMACIONES.length)} confirmaciones.`);
  console.log(`herramientas por turno: ${JSON.stringify(turnos.map((t) => t.toolsCalled))}`);
  const ultimas = await prisma.message.findMany({
    where: { conversation: { customerId: cliente.id }, role: "ASSISTANT" },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { content: true },
  });
  for (const m of ultimas.reverse()) console.log(`  ONIX | ${String(m.content).replace(/\n+/g, " | ").slice(0, 200)}`);
  process.exit(1);
}

void main();
