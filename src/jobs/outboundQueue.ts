import { drainOutboundQueue } from "../whatsapp/outbound";

// Fase 7 del plan maestro (2026-09-15). Hasta ahora la cola de salida solo se drenaba dentro del
// webhook, cuando el cliente escribia: si ese intento fallaba, el mensaje se quedaba ahi y nada volvia
// a tocarlo nunca - habia que esperar a que el cliente escribiera OTRA vez. Con reintentos y backoff
// persistidos (QueuedOutboundMessage.attempts/nextAttemptAt) hace falta alguien que mire el reloj.
//
// Cinco minutos alcanza: el primer reintento de un item es a 1 minuto, y la mayoria de lo que hay en
// cola espera a que el cliente vuelva a escribir, no a este job.
export const OUTBOUND_QUEUE_INTERVAL_MS = 5 * 60 * 1000;

export async function runOutboundQueueJob(): Promise<void> {
  const tally = await drainOutboundQueue();
  if (tally.sent > 0 || tally.dead > 0 || tally.retry > 0) {
    console.log(
      `Cola de salida drenada: ${tally.sent} entregados, ${tally.retry} para reintentar, ${tally.dead} agotados, ${tally.waiting} esperando al cliente.`
    );
  }
}
