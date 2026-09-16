import { runFollowUpJob } from "./followUp";
import { runEscalationReminderJob } from "./escalationReminder";
import { runSaleConfirmationChaserJob } from "./saleConfirmationChaser";
import { runConversationHealthJob } from "./conversationHealth";
import { runOutboundQueueJob } from "./outboundQueue";
import { runTokenExpiryJob } from "./tokenExpiry";
import { runAbandonmentJob } from "./abandonment";

// CORRER LOS JOBS UNA VEZ AL ARRANCAR (2026-09-16).
//
// `setInterval` no dispara al arrancar, solo despues del primer intervalo completo. Cada reinicio
// empujaba TODO lo pendiente hasta un intervalo entero mas adelante. Medido en produccion el 2026-09-16:
// proceso reiniciado 16:32 UTC, confirmacion de venta vencida a las 16:34, primera pasada del job recien
// a las 17:02. Un dia con varios despliegues atrasaba cada recordatorio otro tanto, cada vez.
//
// POR QUE ESTO NO DISPARA UNA RAFAGA EN CADA DESPLIEGUE. Ninguno de estos jobs decide a quien tocar por
// el hecho de correr: los siete se apoyan en una fecha guardada en la base, y correrlos de mas solo
// vuelve a encontrar lo que ya estaba vencido. Verificado uno por uno el 2026-09-16:
//
//   followUp                 -> Conversation.followUpSentAt (markFollowUpSent) + followUpDelayHours.
//   escalationReminder       -> PendingOwnerQuestion.remindedAt, Conversation.stalledReminderSentAt /
//                               stalledReminderStage, y los vencimientos que borran su propia fila.
//   saleConfirmationChaser   -> Conversation.pendingConfirmationNextAttemptAt / pendingConfirmationAskedAt.
//   conversationHealth       -> AgentIncident ya registrados en la ventana de revision: un hallazgo
//                               repetido se deduplica y el WhatsApp sale solo por los hallazgos NUEVOS.
//   outboundQueue            -> QueuedOutboundMessage.nextAttemptAt / sentAt / failedAt.
//   tokenExpiry              -> Business.whatsappTokenExpiryNotifiedAt (un aviso por token, nunca dos).
//   abandonment              -> abandonedAfterHours para el paso 1, Conversation.cartRecoverySentAt para
//                               la plantilla de recuperacion.
//
// Si alguno dejara de tener esa proteccion, sacarlo de esta lista es el arreglo - no quitar el arranque.
export interface StartupJob {
  name: string;
  run: () => Promise<void>;
}

export const STARTUP_JOBS: StartupJob[] = [
  // El perseguidor primero: es el unico con plata de un cliente esperando del otro lado.
  { name: "perseguidor de confirmaciones de venta", run: runSaleConfirmationChaserJob },
  { name: "cola de salida", run: runOutboundQueueJob },
  { name: "recordatorio de escalaciones", run: runEscalationReminderJob },
  { name: "seguimiento post-venta", run: runFollowUpJob },
  { name: "abandono de conversaciones", run: runAbandonmentJob },
  { name: "chequeo de conversaciones", run: runConversationHealthJob },
  { name: "vencimiento de token de WhatsApp", run: runTokenExpiryJob },
];

/**
 * Una pasada de cada job al arrancar. En serie y no en paralelo: comparten la misma base y los mismos
 * limites de tasa de Meta, y no hay ninguna prisa - lo que importa es que corran antes del primer
 * intervalo, no que terminen todos en el mismo segundo.
 *
 * Un job que falla no puede impedir que corran los demas ni tumbar el arranque del servidor.
 */
export async function runStartupJobs(): Promise<void> {
  for (const job of STARTUP_JOBS) {
    try {
      await job.run();
    } catch (error) {
      console.error(`Error corriendo al arranque el job de ${job.name}:`, error);
    }
  }
}
