import { prisma } from "../db/client";
import { sendOwnerAlert, sendTextMessage, type WhatsappCredentials } from "../whatsapp/client";
import { recordOwnerMessage } from "../delivery/ownerLog";
import { recordAgentIncident } from "../ai/incidents";
import {
  findPendingOwnerQuestionsDueForReminder,
  markPendingOwnerQuestionReminded,
  findPendingOwnerQuestionsPastTimeout,
  clearPendingOwnerQuestionsForConversation,
  setHumanControl,
  findStalledConversationsDueForReminder,
  markStalledReminderSent,
  recordMessage,
  CUSTOMER_FOLLOWUP_TEXT,
  getWindowState,
  customerDisplayName,
} from "../conversation/service";

// Real incident (2026-09-14): a customer-facing nudge sent past the 24h window got a real wamid back
// (looked sent) and only failed hours later via the async status webhook - so "we told the customer"
// was never true, silently. The reminder thresholds here (ownerReminderMinutes, 24h stage-2) are
// normally well under 24h from the customer's own last message, but a business configured with an
// unusually long ownerReminderMinutes, or a job that fell behind and is catching up, can still land
// past it - checking before sending catches that instead of trusting the threshold math to always hold.
async function canReachCustomer(conversationId: string): Promise<boolean> {
  return (await getWindowState(conversationId)).windowOpen;
}

// Que la ventana este cerrada no puede seguir siendo un `return` silencioso: antes el job simplemente no
// le avisaba al cliente y nadie se enteraba de que ese cliente ya era inalcanzable por texto libre. El
// dueno es el unico que puede desbloquearlo (mandando una plantilla desde el panel), asi que tiene que
// decirlo el mismo recordatorio. Una sola linea: la plantilla onix_owner_alert rechaza saltos de linea.
const WINDOW_CLOSED_NOTE =
  " OJO: pasaron mas de 24h desde el ultimo mensaje de este cliente, WhatsApp ya no deja mandarle texto libre - entra al panel y mandale una plantilla aprobada para reabrir el chat.";

const STAGE_2_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Customer never gets told anything while a question is escalated - the bot's own note ("estoy
// confirmando con el equipo") only fires if THEY happen to ask again before the owner replies. A real
// business's own script (MAGByLizN) promises this exact proactive follow-up ("seguimos revisando tu
// consulta") and it never fired because nothing in code ever sent it - confirmed against production data
// on 2026-09-12. Generic wording (not tied to one business's script) so every business gets it for free.
// The text itself lives in conversation/service (the stalled query has to recognize it).

const INTENT_LABELS: Record<string, string> = {
  PQR: "una PQR",
  DEVOLUCION: "una devolucion",
  NO_RECIBIDO: "un pedido no recibido",
  SOLICITA_AGENTE: "que pidio hablar con un asesor",
};

function describeStalledOrigin(conversation: { intent: string | null; openQuestion: string | null }): string {
  if (conversation.openQuestion) return `sigue sin respuesta tuya la pregunta: "${conversation.openQuestion}"`;
  if (conversation.intent && INTENT_LABELS[conversation.intent]) {
    return `reporto ${INTENT_LABELS[conversation.intent]} y el bot dejo de responderle, quedo esperando por vos`;
  }
  return "escribio y sigue esperando respuesta tuya";
}

// A PendingOwnerQuestion (ask_owner / ask_owner_about_photo) leaves a real question unanswered until the
// owner replies - if the owner never sees the first alert, the customer is stuck with no response
// indefinitely and no one is told. This sends ONE reminder per question (to the owner AND the customer,
// see CUSTOMER_FOLLOWUP_TEXT above) after ownerReminderMinutes, gated by remindedAt so it never repeats.
// Threshold is per-business (Business.ownerReminderMinutes, defaults to 180 = 3h) instead of one global
// constant, so a business whose own script promises a faster follow-up (e.g. 5 minutes) can be configured
// without changing the default for every other tenant.
//
// A second, independent pass below (the "stalled conversation" watchdog) generalizes this beyond questions:
// flag_conversation_intent and a manual panel takeover both leave a conversation muted with no
// PendingOwnerQuestion at all, so this loop alone never sees them. That pass also gives EVERY origin
// (including this one) a second, final nudge at 24h if the first reminder went unanswered - see
// findStalledConversationsDueForReminder for exactly how the two mechanisms split the work.
export async function runEscalationReminderJob(): Promise<void> {
  const businesses = await prisma.business.findMany({
    where: { active: true, whatsappPhoneNumberId: { not: null }, whatsappAccessToken: { not: null } },
  });

  for (const business of businesses) {
    if (!business.contactPhone) continue;
    const stage1Before = new Date(Date.now() - business.ownerReminderMinutes * 60 * 1000);
    const stage2Before = new Date(Date.now() - STAGE_2_THRESHOLD_MS);

    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken!,
    };

    // Real production bug (2026-09-13): a conversation with TWO open PendingOwnerQuestion rows due at
    // once (customer asked 2 different questions before the owner answered either) sent
    // CUSTOMER_FOLLOWUP_TEXT once PER QUESTION - the same customer got the identical "seguimos
    // revisando" message twice in the same second. Owner alerts stay per-question (each names its own
    // real question); the customer-facing nudge is deduped to once per conversation per run, shared
    // across BOTH loops below (a conversation could otherwise appear in both).
    const customerNotifiedThisRun = new Set<string>();

    const dueQuestions = await findPendingOwnerQuestionsDueForReminder(business.id, stage1Before);
    for (const pending of dueQuestions) {
      const reachable = await canReachCustomer(pending.conversationId);
      // No newlines - the onix_owner_alert template rejects them (WhatsApp error 132018), so a
      // multi-line body always fell through to the plain-text fallback instead of the real template.
      const text = `Recordatorio: todavia no respondiste esta pregunta de ${customerDisplayName(pending.customer)}, sigue sin poder hablar con el bot: "${pending.question}"${reachable ? "" : WINDOW_CLOSED_NOTE}`;
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

      if (reachable && !customerNotifiedThisRun.has(pending.conversationId)) {
        customerNotifiedThisRun.add(pending.conversationId);
        try {
          const customerWamid = await sendTextMessage(credentials, pending.customer.phoneNumber, CUSTOMER_FOLLOWUP_TEXT);
          await recordMessage(business.id, pending.conversationId, "ASSISTANT", CUSTOMER_FOLLOWUP_TEXT, customerWamid || undefined);
        } catch (error) {
          console.error(`No se pudo avisar al cliente que seguimos revisando (pending=${pending.questionId}):`, error);
        }
      }

      await markPendingOwnerQuestionReminded(pending.questionId);
    }

    // Correccion Fase 4 del plan maestro (2026-09-15), causa raiz C2: el bloque anterior solo RECUERDA -
    // si el dueno sigue sin responder, blockedBy (ver saleState.ts) dejaba la conversacion muda para
    // siempre porque nada lo limpiaba. Pasadas Business.ownerQuestionTimeoutHours (default 24h), la
    // desbloqueamos nosotros: se borran las PendingOwnerQuestion vencidas de esa conversacion (lo que ya
    // limpia blockedBy, ver clearBlockedByIfNoPendingQuestions), pasa a control humano, y se le avisa al
    // dueno (WhatsApp) y al panel (AgentIncident) - una vez por conversacion, no una vez por pregunta.
    const timeoutBefore = new Date(Date.now() - business.ownerQuestionTimeoutHours * 60 * 60 * 1000);
    const timedOutQuestions = await findPendingOwnerQuestionsPastTimeout(business.id, timeoutBefore);
    const timedOutConversations = new Set<string>();
    for (const pending of timedOutQuestions) {
      if (timedOutConversations.has(pending.conversationId)) continue;
      timedOutConversations.add(pending.conversationId);

      const text = `Se vencio el tiempo de espera (${business.ownerQuestionTimeoutHours}h) sin que respondieras esta pregunta de ${customerDisplayName(pending.customer)}: "${pending.question}". La conversacion paso a control manual - revisala en el panel.`;
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
        console.error(`No se pudo enviar aviso de timeout de escalacion (conversation=${pending.conversationId}):`, error);
      }

      await clearPendingOwnerQuestionsForConversation(pending.conversationId);
      await setHumanControl(business.id, pending.conversationId, true);
      await recordAgentIncident(business.id, "OWNER_QUESTION_TIMEOUT", text, pending.conversationId, "owner_question_timeout");
    }

    const stalled = await findStalledConversationsDueForReminder(business.id, stage1Before, stage2Before);
    for (const conversation of stalled) {
      const customerLabel = customerDisplayName(conversation.customer);
      const reason = describeStalledOrigin(conversation);
      const reachable = await canReachCustomer(conversation.conversationId);
      const base =
        conversation.nextStage === 2
          ? `Ultimo recordatorio: la conversacion con ${customerLabel} lleva mas de 24 horas sin respuesta tuya (${reason}). No se manda ningun otro aviso despues de este.`
          : `Recordatorio: la conversacion con ${customerLabel} ${reason}.`;
      const text = reachable ? base : `${base}${WINDOW_CLOSED_NOTE}`;
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
        console.error(`No se pudo enviar recordatorio de conversacion estancada (conversation=${conversation.conversationId}):`, error);
      }

      // Only the first nudge tells the customer anything - repeating the same canned line a second time
      // (24h later, still no reply) would just be noise on top of noise for someone already waiting.
      //
      // And never on a plain manual takeover (no intent, no question): there the owner is personally
      // chatting with the customer from the panel, so dropping a canned bot line into the middle of that
      // contradicts whatever she just wrote and gives away that a bot is still in the loop. The bot
      // promised nothing here, unlike the ask_owner path ("te aviso apenas este listo") and the
      // flag_conversation_intent path (bot went silent on a PQR with no explanation), which both leave the
      // customer waiting with no human having said a word - those still get the follow-up.
      const isManualTakeover = !conversation.intent && !conversation.openQuestion;
      if (
        conversation.nextStage === 1 &&
        !isManualTakeover &&
        reachable &&
        !customerNotifiedThisRun.has(conversation.conversationId)
      ) {
        customerNotifiedThisRun.add(conversation.conversationId);
        try {
          const customerWamid = await sendTextMessage(credentials, conversation.customer.phoneNumber, CUSTOMER_FOLLOWUP_TEXT);
          await recordMessage(business.id, conversation.conversationId, "ASSISTANT", CUSTOMER_FOLLOWUP_TEXT, customerWamid || undefined);
        } catch (error) {
          console.error(`No se pudo avisar al cliente que seguimos revisando (conversation=${conversation.conversationId}):`, error);
        }
      }

      await markStalledReminderSent(conversation.conversationId, conversation.nextStage);
    }
  }
}
