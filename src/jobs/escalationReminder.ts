import { prisma } from "../db/client";
import { sendOwnerAlert, type WhatsappCredentials } from "../whatsapp/client";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { findPendingOwnerQuestionsDueForReminder, markPendingOwnerQuestionReminded } from "../conversation/service";

const REMINDER_THRESHOLD_HOURS = 3;

// A PendingOwnerQuestion (ask_owner / ask_owner_about_photo / SOLICITA_AGENTE) mutes the bot for that
// customer until the owner replies - if the owner never sees the first alert, the customer is stuck
// with no response indefinitely and no one is told. This sends ONE reminder per question after
// REMINDER_THRESHOLD_HOURS, gated by remindedAt so it never repeats.
export async function runEscalationReminderJob(): Promise<void> {
  const businesses = await prisma.business.findMany({
    where: { active: true, whatsappPhoneNumberId: { not: null }, whatsappAccessToken: { not: null } },
  });

  const olderThan = new Date(Date.now() - REMINDER_THRESHOLD_HOURS * 60 * 60 * 1000);

  for (const business of businesses) {
    if (!business.contactPhone) continue;
    const dueQuestions = await findPendingOwnerQuestionsDueForReminder(business.id, olderThan);
    if (dueQuestions.length === 0) continue;

    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken!,
    };

    for (const pending of dueQuestions) {
      const text = `Recordatorio: todavia no respondiste esta pregunta de ${pending.customer.name || pending.customer.phoneNumber}, sigue sin poder hablar con el bot:\n\n"${pending.question}"`;
      try {
        const wamid = await sendOwnerAlert(credentials, business.contactPhone, text);
        await recordOwnerMessage(business.id, { direction: "OUT", body: text, success: Boolean(wamid) });
      } catch (error) {
        await recordOwnerMessage(business.id, {
          direction: "OUT",
          body: text,
          success: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.error(`No se pudo enviar recordatorio de escalacion (pending=${pending.questionId}):`, error);
      } finally {
        await markPendingOwnerQuestionReminded(pending.questionId);
      }
    }
  }
}
