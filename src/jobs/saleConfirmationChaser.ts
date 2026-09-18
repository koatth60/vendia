import { prisma } from "../db/client";
import { sendAlertToOwner, sendToCustomer, type WhatsappCredentials } from "../whatsapp/outbound";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { recordAgentIncident } from "../ai/incidents";
import { retrySaleConfirmation } from "../whatsapp/ownerConfirmation";
import {
  clearPendingConfirmation,
  customerDisplayName,
  findOpenPendingConfirmationsForBusiness,
  getWindowState,
  setHumanControl,
  CUSTOMER_FOLLOWUP_TEXT,
} from "../conversation/service";

// PERSEGUIDOR DE CONFIRMACIONES DE VENTA (2026-09-16).
//
// Vivia dentro de jobs/escalationReminder.ts y se separo por el reloj, no por el codigo. Medido en
// produccion el 2026-09-16: el job de escalaciones corre cada 30 minutos, asi que
// `Business.ownerReminderMinutes` no se podia cumplir. El panel deja poner 5 minutos (MAGByLizN lo tiene
// asi) y el piso real era 30: los primeros CUATRO escalones de CONFIRMATION_REMINDER_STEPS (5, 10, 15 y
// 20 minutos sobre esa base) quedaban aplastados contra los 30 durante las primeras dos horas. La
// politica estaba bien; el reloj no le daba.
//
// El job de escalaciones hace cosas mas pesadas (conversaciones estancadas, vencimientos de
// PendingOwnerQuestion, timeouts de intent) y no necesita esta frecuencia. Esto, en cambio, es una
// consulta barata sobre los negocios activos, acotada por indice (Conversation_pendingConfirmationNextAttemptAt_idx).
//
// QUIEN DECIDE SI TOCA MANDAR sigue siendo `pendingConfirmationNextAttemptAt`, nunca el intervalo del
// reloj. Este numero solo tiene que ser MAS FINO que el escalon mas corto de la escalera, para que
// `ownerReminderMinutes` signifique lo que dice. Bajarlo no manda mas mensajes; subirlo por encima del
// escalon mas corto vuelve a mentir sobre la configuracion del dueno.
export const SALE_CONFIRMATION_CHASER_INTERVAL_MS =
  Number(process.env.SALE_CONFIRMATION_CHASER_INTERVAL_MS ?? "") || 60 * 1000;

// Mismo motivo que en escalationReminder.ts: la ventana de 24h del CLIENTE se verifica antes de
// escribirle, en vez de confiar en que la cuenta de horas siempre de bien.
async function canReachCustomer(conversationId: string): Promise<boolean> {
  return (await getWindowState(conversationId)).windowOpen;
}

/**
 * Una pasada: primero los vencimientos, despues los reintentos.
 *
 * Correrlo al arrancar el proceso es seguro y deliberado: no manda nada por el hecho de correr. Cada
 * confirmacion trae su propia fecha (`pendingConfirmationNextAttemptAt`, `pendingConfirmationAskedAt`) y
 * esta consulta solo devuelve las que YA estaban vencidas. Diez reinicios seguidos con una confirmacion
 * viva y no vencida mandan cero mensajes.
 */
export async function runSaleConfirmationChaserJob(): Promise<void> {
  const businesses = await prisma.business.findMany({
    where: { active: true, whatsappPhoneNumberId: { not: null }, whatsappAccessToken: { not: null } },
  });

  for (const business of businesses) {
    // E14: un negocio que revienta no puede dejar sin atender a los que siguen. Antes un solo
    // throw abortaba la pasada entera de este job, y como corre por temporizador nadie se entera:
    // los demas negocios simplemente no reciben su seguimiento de confirmacion de venta y no hay error visible en ningun lado.
    // El continue de adentro sigue funcionando porque el try esta DENTRO del bucle, no afuera.
    try {
      if (!business.contactPhone) continue;

      const credentials: WhatsappCredentials = {
        phoneNumberId: business.whatsappPhoneNumberId!,
        accessToken: business.whatsappAccessToken!,
      };

      // El vencimiento corre primero, para que una conversacion que ya vencio no reciba un recordatorio
      // mas en la misma pasada antes de pasar a control manual.
      const confirmationTimeoutBefore = new Date(Date.now() - business.ownerQuestionTimeoutHours * 60 * 60 * 1000);
      const timedOut = await findOpenPendingConfirmationsForBusiness(business.id, {
        askedBefore: confirmationTimeoutBefore,
      });
      const timedOutIds = new Set(timedOut.map((c) => c.id));
      for (const conversation of timedOut) {
        const customerLabel = customerDisplayName(conversation.customer);
        const text = `Se vencio el tiempo de espera (${business.ownerQuestionTimeoutHours}h) sin que confirmaras si te llego el pago de ${customerLabel}: "${conversation.pendingOrderSummary ?? "sin resumen"}". NO se creo ningun pedido. La conversacion paso a control manual - revisala en el panel.`;
        const alert = await sendAlertToOwner(business.id, credentials, business.contactPhone, text);
        await recordOwnerMessage(business.id, {
          direction: "OUT",
          conversationId: conversation.id,
          body: text,
          success: alert.delivered,
          errorMessage: alert.failure?.message ?? null,
          wamid: alert.delivered ? alert.wamid : null,
        });
        if (!alert.delivered) console.error(`No se pudo avisar del vencimiento de una confirmacion de venta (conversation=${conversation.id}):`, alert.failure?.message);

        await clearPendingConfirmation(conversation.id);
        await setHumanControl(business.id, conversation.id, true, "SALE_CONFIRMATION_TIMEOUT");
        await recordAgentIncident(business.id, "SALE_CONFIRMATION_TIMEOUT", text, conversation.id, "sale_confirmation_timeout");

        // El cliente pago y lleva horas oyendo "estoy confirmando tu pago". Una sola linea, la misma que ya
        // usan las otras escalaciones (y que la consulta de estancadas sabe que no cuenta como respuesta),
        // para que no quede mudo justo cuando la conversacion pasa a manos de una persona.
        if (await canReachCustomer(conversation.id)) {
          const nudge = await sendToCustomer({
            businessId: business.id,
            conversationId: conversation.id,
            credentials,
            to: conversation.customer.phoneNumber,
            content: { kind: "text", text: CUSTOMER_FOLLOWUP_TEXT },
            onWindowClosed: "fail",
            recordAs: { text: CUSTOMER_FOLLOWUP_TEXT },
          });
          if (!nudge.delivered) {
            console.error(`No se pudo avisar al cliente del pago en verificacion (conversation=${conversation.id}):`, nudge.failure?.message);
          }
        }
      }

      // El vencimiento del proximo intento lo lleva la propia confirmacion, no un umbral fijo del job: el
      // intervalo crece con el numero de intento (CONFIRMATION_REMINDER_STEPS).
      const due = await findOpenPendingConfirmationsForBusiness(business.id, { dueBefore: new Date() });
      for (const conversation of due) {
        if (timedOutIds.has(conversation.id)) continue;
        const outcome = await retrySaleConfirmation({
          businessId: business.id,
          conversationId: conversation.id,
          credentials,
          ownerPhone: business.contactPhone,
          contactName: business.contactName,
          customer: conversation.customer,
          summary: conversation.pendingOrderSummary,
          attempt: conversation.pendingConfirmationAttempts + 1,
          reminderMinutes: business.ownerReminderMinutes,
          budget: {
            templatesSent: conversation.pendingConfirmationTemplatesSent,
            lastTemplateAt: conversation.pendingConfirmationLastTemplateAt,
          },
        });
        if (outcome.channel === "NONE") {
          console.error(`No se pudo reintentar la confirmacion de venta (conversation=${conversation.id}):`, outcome.error);
        }
      }
    } catch (error) {
      console.error(`[ZAQI ALERT] saleConfirmationChaser: fallo el negocio ${business.id}, sigo con los demas:`, error);
    }
  }
}
