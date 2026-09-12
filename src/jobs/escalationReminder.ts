import { prisma } from "../db/client";
import { sendOwnerAlert, sendTextMessage, type WhatsappCredentials } from "../whatsapp/client";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { findPendingOwnerQuestionsDueForReminder, markPendingOwnerQuestionReminded, recordMessage } from "../conversation/service";

const DEFAULT_REMINDER_THRESHOLD_MINUTES = 180;

// Customer never gets told anything while a question is escalated - the bot's own note ("estoy
// confirmando con el equipo") only fires if THEY happen to ask again before the owner replies. A real
// business's own script (MAGByLizN) promises this exact proactive follow-up ("seguimos revisando tu
// consulta") and it never fired because nothing in code ever sent it - confirmed against production data
// on 2026-09-12. Generic wording (not tied to one business's script) so every business gets it for free.
const CUSTOMER_FOLLOWUP_TEXT = "Seguimos revisando tu consulta con el equipo, en un momento te confirmamos por aqui 🙏";

// A PendingOwnerQuestion (ask_owner / ask_owner_about_photo) leaves a real question unanswered until the
// owner replies - if the owner never sees the first alert, the customer is stuck with no response
// indefinitely and no one is told. This sends ONE reminder per question (to the owner AND the customer,
// see CUSTOMER_FOLLOWUP_TEXT above) after ownerReminderMinutes, gated by remindedAt so it never repeats.
// Threshold is per-business (Business.ownerReminderMinutes, defaults to 180 = 3h) instead of one global
// constant, so a business whose own script promises a faster follow-up (e.g. 5 minutes) can be configured
// without changing the default for every other tenant.
export async function runEscalationReminderJob(): Promise<void> {
  const businesses = await prisma.business.findMany({
    where: { active: true, whatsappPhoneNumberId: { not: null }, whatsappAccessToken: { not: null } },
  });

  for (const business of businesses) {
    if (!business.contactPhone) continue;
    const olderThan = new Date(Date.now() - business.ownerReminderMinutes * 60 * 1000);
    const dueQuestions = await findPendingOwnerQuestionsDueForReminder(business.id, olderThan);
    if (dueQuestions.length === 0) continue;

    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken!,
    };

    for (const pending of dueQuestions) {
      // No newlines - the onix_owner_alert template rejects them (WhatsApp error 132018), so a
      // multi-line body always fell through to the plain-text fallback instead of the real template.
      const text = `Recordatorio: todavia no respondiste esta pregunta de ${pending.customer.name || pending.customer.phoneNumber}, sigue sin poder hablar con el bot: "${pending.question}"`;
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
      }

      try {
        const customerWamid = await sendTextMessage(credentials, pending.customer.phoneNumber, CUSTOMER_FOLLOWUP_TEXT);
        await recordMessage(business.id, pending.conversationId, "ASSISTANT", CUSTOMER_FOLLOWUP_TEXT, customerWamid || undefined);
      } catch (error) {
        console.error(`No se pudo avisar al cliente que seguimos revisando (pending=${pending.questionId}):`, error);
      }

      await markPendingOwnerQuestionReminded(pending.questionId);
    }
  }
}
