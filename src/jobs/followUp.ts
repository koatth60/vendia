import { prisma } from "../db/client";
import { sendTemplateMessage, type WhatsappCredentials } from "../whatsapp/client";
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
        await sendTemplateMessage(
          credentials,
          conversation.customer.phoneNumber,
          business.followUpTemplateName!,
          business.followUpTemplateLanguage
        );
        await recordMessage(conversation.id, "ASSISTANT", `[Plantilla de seguimiento enviada: ${business.followUpTemplateName}]`);
        await markFollowUpSent(conversation.id);
      } catch (error) {
        console.error(`No se pudo enviar seguimiento para conversacion ${conversation.id}:`, error);
      }
    }
  }
}
