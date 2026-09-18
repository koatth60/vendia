import "dotenv/config";
import { prisma } from "../src/db/client";

// Borra las conversaciones de prueba que dejó scripts/simular-cliente.ts.
//
// Existe para que la Bandeja de la dueña no se llene de charlas que no son de nadie. Borra SOLO los
// clientes marcados `simulated`: un cliente real no tiene esa marca y no se puede poner desde el panel.
//
//   npx tsx scripts/borrar-simulados.ts            # los lista y los borra
//   LISTAR=1 npx tsx scripts/borrar-simulados.ts   # solo los lista

async function main() {
  const simulados = await prisma.customer.findMany({
    where: { simulated: true },
    select: { id: true, phoneNumber: true, business: { select: { name: true } }, _count: { select: { conversations: true } } },
  });

  if (simulados.length === 0) {
    console.log("No hay clientes simulados.");
    process.exit(0);
  }

  for (const c of simulados) {
    console.log(`${c.business.name} · ${c.phoneNumber} · ${c._count.conversations} conversacion(es)`);
  }

  if (process.env.LISTAR) {
    console.log("\n(LISTAR=1: no se borro nada)");
    process.exit(0);
  }

  const ids = simulados.map((c) => c.id);
  const conversaciones = (
    await prisma.conversation.findMany({ where: { customerId: { in: ids } }, select: { id: true } })
  ).map((c) => c.id);
  // El orden es el de las llaves foraneas, igual que en teardownReplayBusiness.
  await prisma.message.deleteMany({ where: { conversation: { customerId: { in: ids } } } });
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversation: { customerId: { in: ids } } } });
  await prisma.agentTurn.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.agentIncident.deleteMany({ where: { conversationId: { in: conversaciones } } });
  await prisma.billableChat.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.saleState.deleteMany({ where: { conversation: { customerId: { in: ids } } } });
  await prisma.order.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });

  console.log(`\nBorrados ${simulados.length} clientes de prueba con todo lo suyo.`);
  process.exit(0);
}

void main();
