import { prisma } from "../db/client";
import { sendAlertToOwner, sendToCustomer, type WhatsappCredentials } from "../whatsapp/outbound";
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
  findFlagIntentEscalationsPastTimeout,
  clearConversationIntent,
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

function describeStalledOrigin(conversation: { intent: string | null; intentExplicit: boolean | null; openQuestion: string | null }): string {
  if (conversation.openQuestion) return `sigue sin respuesta tuya la pregunta: "${conversation.openQuestion}"`;
  if (conversation.intent && INTENT_LABELS[conversation.intent]) {
    // Fase 9 del plan maestro (2026-09-15): un intent que el MODELO dedujo (no que el cliente pidio con
    // sus palabras) puede ser una falsa alarma - "cerrar conversation" leido como SOLICITA_AGENTE fue el
    // caso real que motivo esto. Sin esta distincion el dueno no tiene forma de saber, desde el aviso,
    // si vale la pena entrar corriendo o si primero conviene revisar el chat.
    const inferredNote = conversation.intentExplicit === false ? " (el bot lo dedujo del contexto, no te confies del todo)" : "";
    return `reporto ${INTENT_LABELS[conversation.intent]}${inferredNote} y el bot dejo de responderle, quedo esperando por vos`;
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
      const alert = await sendAlertToOwner(business.id, credentials, business.contactPhone, text);
      await recordOwnerMessage(business.id, {
        direction: "OUT",
        body: text,
        success: alert.delivered,
        errorMessage: alert.failure?.message ?? null,
      });
      if (!alert.delivered) console.error(`No se pudo enviar recordatorio de escalacion (pending=${pending.questionId}):`, alert.failure?.message);

      if (reachable && !customerNotifiedThisRun.has(pending.conversationId)) {
        customerNotifiedThisRun.add(pending.conversationId);
        const nudge = await sendToCustomer({
          businessId: business.id,
          conversationId: pending.conversationId,
          credentials,
          to: pending.customer.phoneNumber,
          content: { kind: "text", text: CUSTOMER_FOLLOWUP_TEXT },
          // canReachCustomer ya verifico la ventana; si se cerro entre medio, la capa de salida no manda
          // una plantilla de reenganche por un aviso de cortesia - seria ruido pago por nada.
          onWindowClosed: "fail",
          recordAs: { text: CUSTOMER_FOLLOWUP_TEXT },
        });
        if (!nudge.delivered) {
          console.error(`No se pudo avisar al cliente que seguimos revisando (pending=${pending.questionId}):`, nudge.failure?.message);
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
      const alert = await sendAlertToOwner(business.id, credentials, business.contactPhone, text);
      await recordOwnerMessage(business.id, {
        direction: "OUT",
        body: text,
        success: alert.delivered,
        errorMessage: alert.failure?.message ?? null,
      });
      if (!alert.delivered) console.error(`No se pudo enviar aviso de timeout de escalacion (conversation=${pending.conversationId}):`, alert.failure?.message);

      await clearPendingOwnerQuestionsForConversation(pending.conversationId);
      await setHumanControl(business.id, pending.conversationId, true);
      await recordAgentIncident(business.id, "OWNER_QUESTION_TIMEOUT", text, pending.conversationId, "owner_question_timeout");
    }

    // Fase 9 del plan maestro (2026-09-15): flag_conversation_intent (PQR/devolucion/no_recibido/pide
    // agente) deja el bot mudo hasta que el dueno responda - el bloque de "stalled" de abajo ya lo avisa
    // dos veces (ownerReminderMinutes y 24h), pero si el dueno NUNCA contesta la conversacion se queda
    // asi para siempre. Defecto real encontrado el 2026-09-15: el modelo llamo esto con SOLICITA_AGENTE
    // porque el cliente escribio "Cerrar conversation" - nunca pidio un asesor. El bot quedo mudo y el
    // dueno recibio una alerta falsa sin forma de volver salvo entrar al panel. Mismo patron de escape
    // que el bloque de arriba (ownerQuestionTimeoutHours): pasadas Business.intentEscalationTimeoutHours
    // sin que humanControlSince se refresque, el bot recupera el control solo - asi una falsa alarma se
    // cura sola en vez de silenciar la conversacion para siempre.
    const intentTimeoutBefore = new Date(Date.now() - business.intentEscalationTimeoutHours * 60 * 60 * 1000);
    const timedOutIntents = await findFlagIntentEscalationsPastTimeout(business.id, intentTimeoutBefore);
    for (const conversation of timedOutIntents) {
      const label = (conversation.intent && INTENT_LABELS[conversation.intent]) ?? "una escalacion";
      const inferredNote =
        conversation.intentExplicit === false
          ? " El bot la dedujo del contexto, el cliente no lo pidio con esas palabras - revisa si fue una falsa alarma."
          : "";
      const text = `La conversacion con ${customerDisplayName(conversation.customer)} quedo escalada por ${label} y pasaron ${business.intentEscalationTimeoutHours}h sin que la atendieras. Se la devolvimos al bot para que no quede muda.${inferredNote}`;
      const alert = await sendAlertToOwner(business.id, credentials, business.contactPhone, text);
      await recordOwnerMessage(business.id, {
        direction: "OUT",
        body: text,
        success: alert.delivered,
        errorMessage: alert.failure?.message ?? null,
      });
      if (!alert.delivered) console.error(`No se pudo enviar aviso de timeout de intent (conversation=${conversation.conversationId}):`, alert.failure?.message);

      await setHumanControl(business.id, conversation.conversationId, false);
      await clearConversationIntent(business.id, conversation.conversationId);
      await recordAgentIncident(business.id, "INTENT_ESCALATION_TIMEOUT", text, conversation.conversationId, "intent_escalation_timeout");
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
      const alert = await sendAlertToOwner(business.id, credentials, business.contactPhone, text);
      await recordOwnerMessage(business.id, {
        direction: "OUT",
        body: text,
        success: alert.delivered,
        errorMessage: alert.failure?.message ?? null,
      });
      if (!alert.delivered) console.error(`No se pudo enviar recordatorio de conversacion estancada (conversation=${conversation.conversationId}):`, alert.failure?.message);

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
        const nudge = await sendToCustomer({
          businessId: business.id,
          conversationId: conversation.conversationId,
          credentials,
          to: conversation.customer.phoneNumber,
          content: { kind: "text", text: CUSTOMER_FOLLOWUP_TEXT },
          // canReachCustomer ya verifico la ventana; si se cerro entre medio, la capa de salida no manda
          // una plantilla de reenganche por un aviso de cortesia - seria ruido pago por nada.
          onWindowClosed: "fail",
          recordAs: { text: CUSTOMER_FOLLOWUP_TEXT },
        });
        if (!nudge.delivered) {
          console.error(`No se pudo avisar al cliente que seguimos revisando (conversation=${conversation.conversationId}):`, nudge.failure?.message);
        }
      }

      await markStalledReminderSent(conversation.conversationId, conversation.nextStage);
    }
  }
}
