import { prisma } from "../db/client";
import { sendToCustomer, type WhatsappCredentials } from "../whatsapp/outbound";
import { findConversationsDueForFollowUp, markFollowUpSent, recordMessage } from "../conversation/service";

export async function runFollowUpJob(): Promise<void> {
  const businesses = await prisma.business.findMany({
    where: {
      active: true,
      followUpTemplateName: { not: null },
      whatsappPhoneNumberId: { not: null },
      whatsappAccessToken: { not: null },
    },
  });

  for (const business of businesses) {
    const olderThan = new Date(Date.now() - business.followUpDelayHours * 60 * 60 * 1000);
    const dueConversations = await findConversationsDueForFollowUp(business.id, olderThan);
    if (dueConversations.length === 0) continue;

    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken!,
    };

    for (const conversation of dueConversations) {
      try {
        const result = await sendToCustomer({
          businessId: business.id,
          conversationId: conversation.id,
          credentials,
          to: conversation.customer.phoneNumber,
          content: {
            kind: "template",
            name: business.followUpTemplateName!,
            language: business.followUpTemplateLanguage,
          },
        });
        // Una plantilla no depende de la ventana de 24h, asi que un fallo aca es real (plantilla no
        // aprobada, token vencido, limite de tasa) y no "se paso la hora": no se marca como enviado, para
        // que el proximo pase lo vuelva a intentar en vez de darlo por hecho.
        if (!result.delivered) {
          console.error(`No se pudo enviar seguimiento para conversacion ${conversation.id}: ${result.failure?.message}`);
          continue;
        }
        await recordMessage(business.id, conversation.id, "ASSISTANT", `[Plantilla de seguimiento enviada: ${business.followUpTemplateName}]`);
        await markFollowUpSent(conversation.id);
      } catch (error) {
        console.error(`No se pudo enviar seguimiento para conversacion ${conversation.id}:`, error);
      }
    }
  }
}
