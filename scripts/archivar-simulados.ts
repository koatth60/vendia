import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "../src/db/client";

// GUARDAR LAS CONVERSACIONES DE PRUEBA ANTES DE BORRARLAS (2026-09-18).
//
// Pedido del dueño: "archívalas en algún lugar donde tengas acceso, y vamos a ir uno por uno". Cada
// tanda nueva borra la anterior (los números simulados se reusan), así que sin esto la evidencia de un
// defecto desaparece en cuanto se corre la siguiente prueba -- y la prueba de que se arregló también.
//
// Queda un archivo por corrida, con fecha, y adentro TODO lo que hace falta para entender un defecto sin
// volver a la base: los mensajes en orden, las herramientas de cada turno, los incidentes, el estado de
// la venta y el pedido si lo hubo.
//
//   npx tsx scripts/archivar-simulados.ts
//   DIRECTORIO=/otro/lado npx tsx scripts/archivar-simulados.ts

const NEGOCIO = process.env.NEGOCIO ?? "Boutique Alondra";
const DIRECTORIO = process.env.DIRECTORIO ?? "conversaciones-archivadas";

async function main() {
  const negocio = await prisma.business.findFirst({ where: { name: NEGOCIO }, select: { id: true, name: true } });
  if (!negocio) {
    console.error(`No existe "${NEGOCIO}".`);
    process.exit(65);
  }

  const clientes = await prisma.customer.findMany({
    where: { businessId: negocio.id, simulated: true },
    orderBy: { phoneNumber: "asc" },
    select: { id: true, phoneNumber: true, name: true, idNumber: true, deliveryPhone: true, address: true },
  });

  const archivo: { mensajes: unknown[] }[] = [];
  for (const cliente of clientes) {
    const conversaciones = await prisma.conversation.findMany({
      where: { customerId: cliente.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, intent: true, humanControl: true, humanControlReason: true, pendingConfirmationAskedAt: true },
    });
    const ids = conversaciones.map((c) => c.id);

    const [mensajes, turnos, incidentes, pedidos, estado, preguntas] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: { in: ids } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, role: true, content: true, mediaType: true, humanAuthor: true },
      }),
      prisma.agentTurn.findMany({
        where: { conversationId: { in: ids } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, toolsCalled: true, scope: true, effectAuthor: true },
      }),
      prisma.agentIncident.findMany({ where: { conversationId: { in: ids } }, select: { kind: true, detail: true, createdAt: true } }),
      prisma.order.findMany({
        where: { customerId: cliente.id },
        select: { createdAt: true, summary: true, totalAmount: true, shippingCost: true, paymentMethodLabel: true, shippingModality: true, fulfillmentStatus: true, paymentStatus: true },
      }),
      prisma.saleState.findFirst({ where: { conversationId: { in: ids } } }),
      prisma.pendingOwnerQuestion.findMany({ where: { conversationId: { in: ids } }, select: { kind: true, question: true, resolvedAt: true } }),
    ]);

    archivo.push({ cliente, conversaciones, mensajes, turnos, incidentes, pedidos, estado, preguntas });
  }

  mkdirSync(DIRECTORIO, { recursive: true });
  const sello = new Date().toISOString().replace(/[:.]/g, "-");
  const ruta = `${DIRECTORIO}/${sello}.json`;
  writeFileSync(ruta, JSON.stringify({ negocio: negocio.name, guardado: new Date().toISOString(), clientes: archivo }, null, 2));

  const mensajes = archivo.reduce((n: number, c) => n + c.mensajes.length, 0);
  console.log(`Archivadas ${archivo.length} conversaciones (${mensajes} mensajes) en ${ruta}`);
  process.exit(0);
}

void main();
