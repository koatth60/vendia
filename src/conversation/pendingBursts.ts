import { randomUUID } from "node:crypto";
import type { PendingBurst } from "@prisma/client";
import { prisma } from "../db/client";

// E08 de ONIX-PLAN.md: la rafaga no muere con el proceso.
//
// QUE QUITA. Al operador, que un reinicio pierda los mensajes agrupados. Los mensajes que llegan
// juntos (el cliente escribiendo tres veces seguidas) esperaban su ventana de silencio en un
// `setTimeout` dentro de un `Map` -- el mensaje ya estaba grabado como `Message`, Meta ya habia
// recibido el 200 y nadie lo iba a reintentar, asi que un `pm2 restart` en esos 8 segundos se
// llevaba la rafaga entera y ese cliente se quedaba sin ninguna respuesta, sin dejar rastro.
//
// La ventana de silencio no cambia: cada mensaje nuevo empuja el `flushAt` de TODA la rafaga de esa
// conversacion, con un tope desde el primer mensaje para el cliente que nunca deja pasar la ventana
// entera. Lo unico que cambia es donde vive: una fila por mensaje en vez de memoria del proceso.
//
// EL RECLAMO. Drenar es un UPDATE condicionado a `claimedAt IS NULL`. Dos procesos que lo intenten a
// la vez no se reparten la rafaga: el segundo espera el lock de fila, vuelve a evaluar la condicion
// ya con `claimedAt` puesto y actualiza cero filas. Junto con el lock por conversacion de E07, dos
// procesos no pueden producir dos respuestas para la misma rafaga.

export const BURST_WINDOW_MS = Number(process.env.WHATSAPP_BURST_WINDOW_MS ?? "") || 8000;
// Tope desde el PRIMER mensaje de la rafaga: un cliente que manda mensajes mas rapido que la ventana
// nunca dejaria pasar la ventana entera, y se quedaria esperando indefinidamente.
export const BURST_MAX_WAIT_MS = Number(process.env.WHATSAPP_BURST_MAX_WAIT_MS ?? "") || 20000;

// Cada cuanto mira el reloj el job que drena. La ventana de silencio es de 8 s, asi que un segundo de
// resolucion no le agrega latencia perceptible a nadie y es una consulta indexada por pasada.
export const PENDING_BURST_INTERVAL_MS = 1000;

// Una rafaga reclamada que sigue reclamada despues de esto es de un proceso que se murio a mitad del
// turno. Se suelta para que alguien la vuelva a tomar. Coincide con STALE_REPLY_MINUTES a proposito:
// pasado ese punto, `runGenerateAndSend` descarta la respuesta por vieja y pasa la conversacion a una
// persona, que es exactamente lo que tiene que pasar con una rafaga que se quedo diez minutos tirada.
export const CLAIM_STALE_MS = 10 * 60 * 1000;

export interface PendingBurstInput {
  conversationId: string;
  businessId: string;
  customerId: string;
  customerPhone: string;
  rawText: string;
  selectedProductId?: string;
  customerSentAt: Date;
}

/**
 * Deja el mensaje esperando su ventana y recalcula el `flushAt` de toda la rafaga de esa conversacion.
 * Devuelve cuando la fila esta escrita: a partir de ahi, un reinicio ya no la pierde.
 */
export async function enqueuePendingBurst(input: PendingBurstInput): Promise<void> {
  const ahora = Date.now();
  await prisma.pendingBurst.create({
    data: {
      conversationId: input.conversationId,
      businessId: input.businessId,
      customerId: input.customerId,
      customerPhone: input.customerPhone,
      rawText: input.rawText,
      selectedProductId: input.selectedProductId ?? null,
      customerSentAt: input.customerSentAt,
      flushAt: new Date(ahora + BURST_WINDOW_MS),
    },
  });

  const primero = await prisma.pendingBurst.findFirst({
    where: { conversationId: input.conversationId, claimedAt: null },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const tope = (primero?.createdAt.getTime() ?? ahora) + BURST_MAX_WAIT_MS;
  const flushAt = new Date(Math.min(ahora + BURST_WINDOW_MS, tope));

  // El mismo `flushAt` para toda la rafaga: si no, cada fila tendria el suyo y la rafaga se drenaria
  // de a pedazos, que es justo lo que agrupar vino a evitar.
  await prisma.pendingBurst.updateMany({
    where: { conversationId: input.conversationId, claimedAt: null },
    data: { flushAt },
  });
}

/** Adelanta a ahora lo que este esperando su ventana. Lo usa el apagado ordenado. */
export async function flushPendingBurstsNow(): Promise<number> {
  const ahora = new Date();
  const { count } = await prisma.pendingBurst.updateMany({
    where: { claimedAt: null, flushAt: { gt: ahora } },
    data: { flushAt: ahora },
  });
  return count;
}

export function countPendingBursts(): Promise<number> {
  return prisma.pendingBurst.count({ where: { claimedAt: null } });
}

/** Suelta las rafagas de un proceso que se murio con el reclamo puesto. Devuelve cuantas soltó. */
export async function releaseAbandonedClaims(): Promise<number> {
  const { count } = await prisma.pendingBurst.updateMany({
    where: { claimedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } },
    data: { claimedAt: null, claimedBy: null },
  });
  return count;
}

/**
 * Reclama la rafaga vencida de una conversacion. Devuelve sus filas en orden de llegada, o vacio si
 * otro proceso llego primero (o si todavia no vencio).
 */
export async function claimPendingBurst(conversationId: string): Promise<PendingBurst[]> {
  const claimedBy = randomUUID();
  const { count } = await prisma.pendingBurst.updateMany({
    where: { conversationId, claimedAt: null, flushAt: { lte: new Date() } },
    data: { claimedAt: new Date(), claimedBy },
  });
  if (count === 0) return [];
  return prisma.pendingBurst.findMany({ where: { claimedBy }, orderBy: { createdAt: "asc" } });
}

export async function deletePendingBurst(filas: PendingBurst[]): Promise<void> {
  if (filas.length === 0) return;
  await prisma.pendingBurst.deleteMany({ where: { id: { in: filas.map((fila) => fila.id) } } });
}

/**
 * Una pasada del drenaje. Reclama cada conversacion vencida y ARRANCA su turno sin esperarlo:
 * conversaciones distintas tienen que seguir corriendo en paralelo, igual que cuando cada rafaga
 * tenia su propio `setTimeout` -- si se esperara una por una, un turno lento de un cliente dejaria a
 * todos los demas negocios esperando detras.
 *
 * Devuelve las promesas de los turnos que arranco, para que el llamador (o una prueba) pueda
 * esperarlas si quiere. Las filas se borran cuando el turno termina, salga bien o mal: un turno que
 * revienta no se reintenta solo, igual que antes de E08, porque reintentar despues de un envio a
 * medias es como se le manda dos veces lo mismo a un cliente.
 */
export async function drainDuePendingBursts(
  runTurn: (conversationId: string, filas: PendingBurst[]) => Promise<void>,
  onError: (conversationId: string, error: unknown) => void = () => {}
): Promise<Promise<void>[]> {
  await releaseAbandonedClaims();

  const vencidas = await prisma.pendingBurst.findMany({
    where: { claimedAt: null, flushAt: { lte: new Date() } },
    select: { conversationId: true },
    distinct: ["conversationId"],
    orderBy: { conversationId: "asc" },
  });

  const enCurso: Promise<void>[] = [];
  for (const { conversationId } of vencidas) {
    const filas = await claimPendingBurst(conversationId);
    if (filas.length === 0) continue;
    const turno = (async () => {
      try {
        await runTurn(conversationId, filas);
      } catch (error) {
        onError(conversationId, error);
      } finally {
        await deletePendingBurst(filas);
      }
    })();
    enCurso.push(turno);
  }
  return enCurso;
}
