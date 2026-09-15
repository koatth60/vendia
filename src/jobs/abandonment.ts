import { prisma } from "../db/client";
import { sendToCustomer, type WhatsappCredentials } from "../whatsapp/outbound";
import {
  findConversationsDueForAbandonment,
  findConversationsDueForCartRecovery,
  markConversationAbandoned,
  markCartRecoverySent,
  recordMessage,
} from "../conversation/service";
import { markCustomerInactive } from "../crm/customers";
import { getSaleState } from "../orders/saleState";

// Fase 9 del plan maestro (2026-09-15), causa raiz C1+eje 18: el 61% de las conversaciones NEW no
// cerraba nunca y no contaba como perdida. Cada hora alcanza y sobra - el umbral que decide que entra
// aca es Business.abandonedAfterHours (horas, default 72), no este intervalo.
export const ABANDONMENT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export async function runAbandonmentJob(): Promise<void> {
  const businesses = await prisma.business.findMany({ where: { active: true } });

  for (const business of businesses) {
    // --- Paso 1: pasar a ABANDONED las conversaciones inactivas ---------------------------------
    const olderThan = new Date(Date.now() - business.abandonedAfterHours * 60 * 60 * 1000);
    const due = await findConversationsDueForAbandonment(business.id, olderThan);
    for (const conversation of due) {
      await markConversationAbandoned(business.id, conversation.id);
      await markCustomerInactive(business.id, conversation.customer.id);
    }

    // --- Paso 2: recuperacion de carrito para abandonadas con SaleState -------------------------
    // Independiente del paso anterior (misma pasada u otra): reintenta hasta que la plantilla se
    // entregue de verdad, igual que jobs/followUp.ts.
    if (!business.cartRecoveryTemplateName || !business.whatsappPhoneNumberId || !business.whatsappAccessToken) continue;
    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId,
      accessToken: business.whatsappAccessToken,
    };

    const pendingRecovery = await findConversationsDueForCartRecovery(business.id);
    for (const conversation of pendingRecovery) {
      try {
        const saleState = await getSaleState(conversation.id);
        if (!saleState || saleState.items.length === 0) continue;

        const result = await sendToCustomer({
          businessId: business.id,
          conversationId: conversation.id,
          credentials,
          to: conversation.customer.phoneNumber,
          content: {
            kind: "template",
            name: business.cartRecoveryTemplateName,
            language: business.cartRecoveryTemplateLanguage,
          },
        });
        if (!result.delivered) {
          console.error(`No se pudo enviar recuperacion de carrito para conversacion ${conversation.id}: ${result.failure?.message}`);
          continue;
        }
        await recordMessage(business.id, conversation.id, "ASSISTANT", `[Plantilla de recuperacion de carrito enviada: ${business.cartRecoveryTemplateName}]`);
        await markCartRecoverySent(conversation.id);
      } catch (error) {
        console.error(`No se pudo enviar recuperacion de carrito para conversacion ${conversation.id}:`, error);
      }
    }
  }
}
