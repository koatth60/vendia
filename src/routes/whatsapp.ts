import { Router } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { toBusinessLocale } from "../config/businessConfig";
import { prisma } from "../db/client";
import {
  sendAlertToOwner,
  sendToCustomer,
  sendToOwner,
  drainQueuedOutboundForCustomer,
  downloadMedia,
  formatForWhatsapp,
  markCustomerMessageSeen,
  computeTypingDelayMs,
  type WhatsappCredentials,
} from "../whatsapp/outbound";
import { createBurstBuffer } from "../whatsapp/burstBuffer";
import { uploadMedia } from "../media/s3";
import { checkWebhookSignature, signatureHeaderOf } from "../whatsapp/webhookSignature";
import { maskPhone } from "../whatsapp/logging";
import {
  getOrCreateCustomer,
  getOrCreateOpenConversation,
  recordMessage,
  findConversationByPendingConfirmation,
  clearPendingConfirmation,
  findConversationByPendingOwnerQuestion,
  clearPendingOwnerQuestion,
  findOpenPendingOwnerQuestionsForBusiness,
  findOpenPendingConfirmationsForBusiness,
  setHumanControl,
  updateConversationStatus,
  getRelatedProductNameForMessage,
  customerDisplayName,
  saveCustomerContactInfo,
  recordMessageDeliveryStatus,
} from "../conversation/service";
import { generateReply, generateClosingMessage, extractDeliveryDataFromAnswer, extractAddressFromAnswer } from "../ai/agent";
import { analyzeCustomerImage } from "../ai/vision";
import { transcribeAudio } from "../ai/transcription";
import { checkPlanCap } from "../ai/usage";
import { createOrder, askForCsat, recordCsatReply, type ResolvedOrderItem } from "../orders/service";
import { recordAskOwnerResolution } from "../catalog/learnedFaq";
import { getCatalogHintText, findConfidentProductMatch } from "../catalog/products";
import { recordDeliveryFailure } from "../delivery/failures";
import { recordAgentIncident } from "../ai/incidents";

// The owner's answer is free-form text - unlike sendOwnerAlert (always the SAME fixed wrapper phrase to
// the owner, so one approved template covers every call), an arbitrary customer-facing answer can't be
// carried by a pre-approved template (Meta only allows the exact approved wording, no free-form body).
// So on failure - most commonly the customer's 24h service window closed while the owner was slow to
// reply - this can't "retry with the real content", only try to re-open the window: if the business
// configured a follow-up template (Business.followUpTemplateName, same one runFollowUpJob uses), send that
// as a plain nudge so the customer writes back, which re-opens the window for a real answer. Either way,
// the caller decides what to actually tell the owner - it needs the true outcome, not an optimistic
// assumption that a returned wamid meant the customer got it.
import { recordOwnerMessage } from "../delivery/ownerLog";
import { extractFrame } from "../media/videoFrame";

export const whatsappRouter = Router();

// Real production bug (2026-09-14/15): two webhooks for the same conversation arriving close together
// (a customer sending two messages back to back, or WhatsApp's own retry after a slow response) used to
// run TWO generateReply calls concurrently, both reading the same starting history and both writing
// their own reply - the customer got two different, sometimes flatly contradictory answers within
// seconds of each other (confirmed against real conversations: one telling a customer "no manejamos
// micrófonos" for a typo the OTHER reply correctly read as "audífonos", another saving the wrong name -
// see looksLikeNonNameAnswer in agent.ts for a related but separate cause). pm2 runs this as a single
// process (fork mode, not cluster - see ecosystem.config.js, `exec_mode: "fork"` + `instances: 1`, versioned
// as of Fase 7 instead of living only in this comment), so a plain in-memory per-conversation queue is
// enough - no Redis/DB lock needed. Each conversationId gets its own promise chain: a new webhook for that
// conversation waits for the previous one's full handling (generateReply + the reply send + recordMessage)
// to finish before it starts, so the two are serialized instead of racing. Different conversations are
// unaffected and run fully in parallel, same as before.
const conversationLocks = new Map<string, Promise<void>>();

// Fase 7 del plan maestro (2026-09-15): cuantos turnos (webhook -> generateReply -> envio -> recordMessage)
// estan en vuelo AHORA MISMO, para que el apagado ordenado en index.ts pueda esperarlos en vez de matarlos
// a mitad de camino. Antes de esto, cada `pm2 restart` perdia los turnos en vuelo sin ningun registro, y
// como el webhook ya habia respondido 200, Meta no los reintentaba - el cliente simplemente no recibia
// respuesta.
let activeTurnCount = 0;
export function getActiveTurnCount(): number {
  return activeTurnCount;
}

export async function withConversationLock(conversationId: string, fn: () => Promise<void>): Promise<void> {
  const previous = conversationLocks.get(conversationId) ?? Promise.resolve();
  // .then(fn, fn) runs fn once `previous` SETTLES, whether it resolved or rejected - a prior turn
  // throwing must never wedge every later turn for this conversation behind a permanently-rejected
  // promise.
  activeTurnCount++;
  const run = previous.then(fn, fn);
  // The map only ever stores a swallowed-error version of `run` - otherwise the NEXT caller's `previous`
  // would itself reject before its own turn even starts.
  const tail = run.catch(() => {});
  conversationLocks.set(conversationId, tail);
  try {
    await run;
  } finally {
    activeTurnCount--;
    // Free the map entry once nothing is queued behind this call (nobody else overwrote it with their
    // own tail) - without this a business with many distinct conversations over time leaks one Map entry
    // per conversationId forever.
    if (conversationLocks.get(conversationId) === tail) {
      conversationLocks.delete(conversationId);
    }
  }
}

// Minutos que tiene que llevar callado este lado del chat para que valga la pena mandar el acuse de
// "ya te leimos". Dentro de esa ventana, o la duena esta escribiendo ahora mismo o el bot acaba de
// avisar que escala: en los dos casos el cliente ya tiene un mensaje reciente y el acuse solo molesta.
const ACK_QUIET_MINUTES = 15;

// Minutos desde que el cliente mando su mensaje a partir de los cuales la respuesta ya no se manda. Con
// el proveedor de IA degradado la generacion se apila: el 2026-09-14, con DeepSeek caido, una respuesta
// salio 30 minutos tarde, cuando el cliente ya habia seguido escribiendo y la duena ya habia contestado
// a mano. A esa altura la respuesta no contesta nada, confunde. Se descarta y pasa a un humano.
const STALE_REPLY_MINUTES = 10;

// Respuesta de servicio a la duena dentro de un intercambio que ella misma abrio escribiendo (las
// confirmaciones del flujo de citar-y-responder). Sale por la capa unica y deja el mismo registro en
// OwnerMessageLog que dejaba trackOwnerSend.
async function replyToOwner(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  text: string
): Promise<void> {
  const result = await sendToOwner(businessId, credentials, ownerPhone, { kind: "text", text });
  await recordOwnerMessage(businessId, {
    direction: "OUT",
    body: text,
    success: result.delivered,
    errorMessage: result.failure?.message ?? null,
  });
  if (!result.delivered) console.error("No se pudo contestarle a la duena:", result.failure?.message);
}

// Aviso con plantilla aprobada a la duena (llega tambien fuera de su ventana de 24h).
async function alertOwnerTracked(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  text: string
): Promise<void> {
  const result = await sendAlertToOwner(businessId, credentials, ownerPhone, text);
  await recordOwnerMessage(businessId, {
    direction: "OUT",
    body: text,
    success: result.delivered,
    errorMessage: result.failure?.message ?? null,
  });
  if (!result.delivered) console.error("No se pudo avisarle a la duena:", result.failure?.message);
}

const CONFIRM_WORDS = ["si", "sí", "confirmado", "confirmo", "listo", "ok", "dale", "correcto", "confirm_yes"];
const DENY_WORDS = ["no", "confirm_no"];

interface OwnerReplyMessage {
  type: string;
  context?: { id?: string };
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}

async function deliverOwnerAnswerToCustomer(
  businessId: string,
  conversationId: string,
  credentials: WhatsappCredentials,
  customerPhone: string,
  text: string
): Promise<{ delivered: boolean; nudged: boolean; queued: boolean }> {
  // Mismo resultado que antes (entregado / encolado / plantilla de reenganche / fallo registrado), pero
  // decidido en un solo lugar: la capa de salida verifica la ventana ANTES de intentar, en vez de
  // deducirla de que Meta haya rechazado el envio.
  const result = await sendToCustomer({
    businessId,
    conversationId,
    credentials,
    to: customerPhone,
    content: { kind: "text", text },
    onWindowClosed: "queue",
    queueOrigin: "OWNER_ANSWER",
  });
  return {
    delivered: result.outcome === "SENT",
    nudged: result.outcome !== "SENT" && result.delivered,
    queued: result.queued,
  };
}

function ownerConfirmationText(outcome: { delivered: boolean; nudged: boolean; queued: boolean }, successText: string): string {
  if (outcome.delivered) return successText;
  const queuedNote = outcome.queued
    ? " Tu respuesta quedo guardada y se le manda sola apenas el cliente escriba."
    : " Tu respuesta NO quedo guardada, vas a tener que volver a escribirla.";
  if (outcome.nudged) {
    return `No se pudo entregar tu respuesta directamente (pasaron mas de 24h desde el ultimo mensaje del cliente) - le mandamos un aviso para que vuelva a escribir.${queuedNote}`;
  }
  return `No se pudo entregar tu respuesta al cliente (pasaron mas de 24h desde su ultimo mensaje) y este negocio no tiene plantilla de reenganche configurada.${queuedNote}`;
}

export async function handleOwnerReply(
  businessId: string,
  credentials: WhatsappCredentials,
  ownerPhone: string,
  message: OwnerReplyMessage
) {
  if (message.type !== "text" && message.type !== "interactive") {
    console.log("Mensaje del dueno ignorado (tipo no soportado para confirmaciones):", message.type);
    return;
  }

  const quotedId = message.context?.id;
  let pendingQuestion = quotedId ? await findConversationByPendingOwnerQuestion(quotedId) : null;
  let conversation = quotedId ? await findConversationByPendingConfirmation(quotedId) : null;

  // Owner replied without long-pressing to quote a specific message (common on mobile) - only
  // auto-resolve when there's exactly ONE thing open for this business. With two or more, we still
  // need the quote to know which one they mean, otherwise a reply meant for one customer could get
  // forwarded to a different one.
  if (!quotedId) {
    const [openQuestions, openConfirmations] = await Promise.all([
      findOpenPendingOwnerQuestionsForBusiness(businessId),
      findOpenPendingConfirmationsForBusiness(businessId),
    ]);
    const totalOpen = openQuestions.length + openConfirmations.length;
    if (totalOpen === 1) {
      if (openQuestions.length === 1) {
        pendingQuestion = openQuestions[0];
      } else {
        conversation = openConfirmations[0];
      }
    } else {
      const hint =
        totalOpen > 1
          ? ` Tenes ${totalOpen} cosas esperando respuesta ahora mismo, necesito saber a cual te referis.`
          : "";
      const noQuoteText = `No identifique a que mensaje te refieres.${hint} Por favor responde citando (mantén presionado y "Responder") el mensaje especifico.`;
      await replyToOwner(businessId, credentials, ownerPhone, noQuoteText);
      return;
    }
  }

  if (pendingQuestion) {
    const answerText = message.type === "text" ? (message.text?.body ?? "").trim() : "";
    if (!answerText) {
      const askTextText = "Respondeme con un mensaje de texto, citando esa misma pregunta, por favor.";
      await replyToOwner(businessId, credentials, ownerPhone, askTextText);
      return;
    }

    // PHOTO_PRODUCT (from ask_owner_about_photo, src/ai/tools.ts): the owner is naming a product from a
    // photo we couldn't identify, not answering a free-text question - try to resolve it to a real
    // catalog product so the customer gets the actual name/price/photo back, instead of just the owner's
    // raw words. Falls back to forwarding the raw text (still prefixed) when it doesn't match anything.
    if (pendingQuestion.kind === "PHOTO_PRODUCT") {
      const match = await findConfidentProductMatch(businessId, answerText);
      let outcome: { delivered: boolean; nudged: boolean; queued: boolean };
      if (match.product) {
        const price = `$${match.product.price.toString()} ${match.product.currency}`;
        const productText = formatForWhatsapp(`Según nuestro equipo, el producto que buscas es: *${match.product.name}* - ${price}`);
        outcome = await deliverOwnerAnswerToCustomer(businessId, pendingQuestion.conversationId, credentials, pendingQuestion.customer.phoneNumber, productText);
        await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", productText);
        if (outcome.delivered && match.product.media.length > 0) {
          const photo = await sendToCustomer({
            businessId,
            conversationId: pendingQuestion.conversationId,
            credentials,
            to: pendingQuestion.customer.phoneNumber,
            content: { kind: "image", url: match.product.media[0].url },
            // El texto acaba de salir, asi que la ventana esta abierta; si no lo estuviera, no se gasta
            // una plantilla de reenganche en mandar una foto suelta.
            onWindowClosed: "fail",
          });
          if (!photo.delivered) {
            console.error("No se pudo enviar la foto del producto identificado al cliente:", photo.failure?.message);
          }
        }
      } else {
        const fallbackText = formatForWhatsapp(`Según nuestro equipo: ${answerText}`);
        outcome = await deliverOwnerAnswerToCustomer(businessId, pendingQuestion.conversationId, credentials, pendingQuestion.customer.phoneNumber, fallbackText);
        await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", fallbackText);
      }
      await clearPendingOwnerQuestion(pendingQuestion.questionId);
      await setHumanControl(businessId, pendingQuestion.conversationId, false);
      const confirmedProductText = ownerConfirmationText(outcome, "Listo, le confirme el producto al cliente ✅");
      await replyToOwner(businessId, credentials, ownerPhone, confirmedProductText);
      return;
    }

    const formattedAnswer = formatForWhatsapp(answerText);
    const answerOutcome = await deliverOwnerAnswerToCustomer(businessId, pendingQuestion.conversationId, credentials, pendingQuestion.customer.phoneNumber, formattedAnswer);
    await recordMessage(businessId, pendingQuestion.conversationId, "ASSISTANT", formattedAnswer);
    await clearPendingOwnerQuestion(pendingQuestion.questionId);
    await setHumanControl(businessId, pendingQuestion.conversationId, false);
    // The owner just answered a real customer question for the first time - surface it as a suggested
    // FAQ entry instead of discarding it after this one use (never auto-published, just queued for
    // review in the admin panel).
    await recordAskOwnerResolution(businessId, pendingQuestion.question, answerText, pendingQuestion.conversationId);
    const forwardedText = ownerConfirmationText(answerOutcome, "Listo, le reenvie tu respuesta al cliente ✅");
    await replyToOwner(businessId, credentials, ownerPhone, forwardedText);
    return;
  }

  if (!conversation) {
    const expiredText = "Ese mensaje ya no esta esperando respuesta (puede que ya se haya resuelto o haya expirado).";
    await replyToOwner(businessId, credentials, ownerPhone, expiredText);
    return;
  }

  const answer =
    message.type === "interactive"
      ? (message.interactive?.button_reply?.id ?? "")
      : (message.text?.body ?? "").trim().toLowerCase();
  const isConfirm = CONFIRM_WORDS.includes(answer);
  const isDeny = DENY_WORDS.includes(answer);

  if (!isConfirm && !isDeny) {
    const clarifyText = 'Respondeme "si" o "no" citando ese mismo mensaje, por favor.';
    await replyToOwner(businessId, credentials, ownerPhone, clarifyText);
    return;
  }

  const customerPhone = conversation.customer.phoneNumber;

  if (isConfirm) {
    const draft = conversation.pendingOrderItems as {
      items?: ResolvedOrderItem[];
      shippingAddress?: string | null;
      paymentMethodLabel?: string | null;
      shippingCost?: number | null;
    } | null;
    const order = await createOrder({
      businessId,
      customerId: conversation.customer.id,
      conversationId: conversation.id,
      summary: conversation.pendingOrderSummary ?? "",
      items: draft?.items ?? [],
      shippingAddress: draft?.shippingAddress ?? null,
      paymentMethodLabel: draft?.paymentMethodLabel ?? null,
      shippingCost: draft?.shippingCost ?? null,
    });
    await updateConversationStatus(businessId, conversation.id, "SOLD");
    await clearPendingConfirmation(conversation.id);
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { botTone: true, assistantName: true, customInstructions: true },
    });
    const customerText = await generateClosingMessage(businessId, conversation.id, business ?? {}, {
      customerName: conversation.customer.name,
      summary: order.summary,
      shippingAddress: order.shippingAddress,
      paymentMethodLabel: order.paymentMethodLabel,
      shippingCost: order.shippingCost != null ? Number(order.shippingCost) : null,
      totalAmount: Number(order.totalAmount),
      currency: order.currency,
    });
    const closing = await sendToCustomer({
      businessId,
      conversationId: conversation.id,
      credentials,
      to: customerPhone,
      content: { kind: "text", text: customerText },
      recordAs: { text: customerText },
    });
    await askForCsat(credentials, order.id, customerPhone);
    // Antes esta confirmacion a la duena era fija: decia "le avise al cliente" aunque el envio hubiera
    // fallado. Ahora dice lo que realmente paso.
    const confirmedSaleText = closing.delivered
      ? "Listo, le avise al cliente ✅"
      : "El pedido quedo registrado, pero NO se pudo avisarle al cliente - revisa esa conversacion en el panel.";
    await replyToOwner(businessId, credentials, ownerPhone, confirmedSaleText);
  } else {
    await clearPendingConfirmation(conversation.id);
    const customerText =
      "No logramos confirmar tu pago todavia. ¿Puedes reenviar una foto mas clara del comprobante o confirmar el monto por texto?";
    const asked = await sendToCustomer({
      businessId,
      conversationId: conversation.id,
      credentials,
      to: customerPhone,
      content: { kind: "text", text: customerText },
      recordAs: { text: customerText },
    });
    const deniedSaleText = asked.delivered
      ? "Listo, le pedi al cliente que reenvie el comprobante."
      : "No se pudo contactar al cliente para pedirle el comprobante - revisa esa conversacion en el panel.";
    await replyToOwner(businessId, credentials, ownerPhone, deniedSaleText);
  }
}

// ---------------------------------------------------------------------------
// Fase 10 del plan maestro (2026-09-15), eje 19: agrupacion de rafaga (capa [1] INGESTA)
// ---------------------------------------------------------------------------
//
// Antes, dos o tres mensajes seguidos del mismo cliente (webhooks separados de Meta, segundos de
// diferencia) disparaban cada uno su propio generateReply completo - el cliente recibia varias
// respuestas, a veces contradictorias entre si porque cada llamada partia del mismo historial sin
// ver lo que la otra iba a contestar. replyBurstBuffer los agrupa por conversation.id con una
// ventana de silencio de ~8s (createBurstBuffer, generico y probado aparte en
// src/whatsapp/burstBuffer.test.ts) y recien entonces genera y manda UNA sola respuesta para todo
// lo que el cliente escribio en ese rato.
//
// Corre DELANTE del lock por conversacion: cada mensaje individual sigue pasando por su propio
// withConversationLock para el trabajo que no puede esperar (grabar el mensaje, el gate de control
// humano, el tope del plan, drenar la cola de salida - ver el handler del POST /webhook mas abajo).
// Lo unico que se agrupa y difiere es la generacion y el envio de la respuesta, que corre en SU
// PROPIA adquisicion del lock cuando la rafaga se descarga (runGenerateAndSend).
type BusinessRow = NonNullable<Awaited<ReturnType<typeof prisma.business.findUnique>>>;
type CustomerRow = Awaited<ReturnType<typeof getOrCreateCustomer>>;

export interface ReplyBurstItem {
  rawText: string;
  customerSentAt: number;
  business: BusinessRow;
  customer: CustomerRow;
  credentials: WhatsappCredentials;
  from: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Combinacion pura de una rafaga en un solo turno - separada de runGenerateAndSend (que si hace
// I/O real: DB, generateReply, WhatsApp) para poder probarla sin tocar nada de eso. El ultimo
// mensaje de la rafaga manda en credenciales/negocio/cliente (en la practica son siempre los
// mismos dentro de una misma conversacion); el texto se concatena para que el modelo y los
// backstop-guards de agent.ts vean TODO lo que el cliente escribio, no solo el ultimo mensaje. La
// hora de referencia para el descarte por vieja es la del PRIMER mensaje: es desde ahi que el
// cliente esta esperando.
export function combineBurstItems(items: ReplyBurstItem[]): {
  last: ReplyBurstItem;
  combinedRawText: string;
  customerSentAt: number;
} {
  return {
    last: items[items.length - 1],
    combinedRawText: items.map((item) => item.rawText).join("\n"),
    customerSentAt: items[0].customerSentAt,
  };
}

async function runGenerateAndSend(conversationId: string, items: ReplyBurstItem[]): Promise<void> {
  const { last, combinedRawText, customerSentAt } = combineBurstItems(items);
  const { business, customer, credentials, from } = last;

  const shippingRatesConfigured = (await prisma.shippingRate.count({ where: { businessId: business.id } })) > 0;

  const reply = await generateReply(
    conversationId,
    {
      businessId: business.id,
      conversationId,
      customerId: customer.id,
      credentials,
      recipientPhone: from,
    },
    {
      businessName: business.name,
      assistantName: business.assistantName,
      tone: business.botTone,
      dialect: business.botDialect,
      greeting: business.botGreeting,
      neverSay: business.botNeverSay,
      customInstructions: business.customInstructions,
      autoSendPhotoOnQuote: business.autoSendPhotoOnQuote,
      offerPhotosBeforeSending: business.offerPhotosBeforeSending,
      requirePaymentProof: business.requirePaymentProof,
      category: business.businessCategory,
      genderedAddressEnabled: business.genderedAddressEnabled,
      femaleAddressTerm: business.femaleAddressTerm,
      maleAddressTerm: business.maleAddressTerm,
      shippingPaymentModalities: business.shippingPaymentModalities,
      shippingRatesConfigured,
      saleStateEnabled: business.saleStateEnabled,
    },
    combinedRawText
  );

  // Mismo motivo que antes de la Fase 10: generateReply puede tardar desde segundos hasta minutos,
  // y en ese rato la duena puede haber tomado el control y contestado a mano - mandar igual la
  // respuesta vieja la contradice delante del cliente.
  const stillAutomatic = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { humanControl: true },
  });
  if (stillAutomatic?.humanControl) {
    console.log("El equipo tomo el control mientras se generaba la respuesta, se descarta:", conversationId);
    return;
  }

  // Sin que nadie haya tomado el control: si la respuesta tardo demasiado ya no contesta lo que el
  // cliente pregunto, asi que se tira y la conversacion pasa a un humano.
  const waitedMinutes = (Date.now() - customerSentAt) / (60 * 1000);
  if (waitedMinutes > STALE_REPLY_MINUTES) {
    const detail = `La respuesta tardo ${Math.round(waitedMinutes)} minutos en generarse (limite ${STALE_REPLY_MINUTES}) y se descarto sin mandarla.`;
    console.error(`${detail} conversation=${conversationId}`);
    await recordAgentIncident(business.id, "STALE_REPLY_DISCARDED", detail, conversationId);
    await setHumanControl(business.id, conversationId, true);
    if (business.contactPhone) {
      const customerLabel = customerDisplayName(customer);
      const staleAlertText = `El bot tardo ${Math.round(waitedMinutes)} minutos en responderle a ${customerLabel} y la respuesta se descarto por vieja. Esa conversacion quedo esperandote en el panel.`;
      await alertOwnerTracked(business.id, credentials, business.contactPhone!, staleAlertText);
    }
    return;
  }

  const formattedReply = formatForWhatsapp(reply);
  // Demora proporcional al largo de la respuesta antes de mandarla: se siente mas humano que una
  // respuesta instantanea, y el indicador de "escribiendo" (prendido al recibir cada mensaje, ver
  // markCustomerMessageSeen en el handler del POST) cubre esta espera.
  await sleep(computeTypingDelayMs(formattedReply.length));

  await sendToCustomer({
    businessId: business.id,
    conversationId,
    credentials,
    to: from,
    content: { kind: "text", text: formattedReply },
    recordAs: { text: formattedReply },
  });
}

const replyBurstBuffer = createBurstBuffer<ReplyBurstItem>(
  async (conversationId, items) => {
    await withConversationLock(conversationId, () => runGenerateAndSend(conversationId, items));
  },
  { windowMs: Number(process.env.WHATSAPP_BURST_WINDOW_MS ?? "") || 8000 }
);

// El apagado ordenado (src/shutdown.ts) necesita poder vaciar esto ANTES de esperar los locks: un
// mensaje esperando su ventana de rafaga ya esta grabado en la base y Meta ya recibio el 200 - si
// el proceso se reinicia antes de que el timer normal (hasta 8s) dispare, se pierde en silencio.
export function flushPendingReplyBursts(): Promise<void> {
  return replyBurstBuffer.flushAll();
}

export function getPendingReplyBurstCount(): number {
  return replyBurstBuffer.pendingCount();
}

whatsappRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsapp.verifyToken) {
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

whatsappRouter.post("/webhook", async (req, res) => {
  // Fase 8, punto 1: verificacion de la firma de Meta. Arranca en MODO REGISTRO - se anota la firma
  // invalida y la entrega se procesa igual. El rechazo 401 se prende con WEBHOOK_SIGNATURE_ENFORCE
  // recien cuando los logs confirmen que las entregas reales validan bien (ver config/env.ts).
  const signature = checkWebhookSignature(req.rawBody, signatureHeaderOf(req), env.facebook.appSecret);
  if (!signature.valid) {
    const enforcing = env.webhookSignature.enforce && signature.reason !== "sin-app-secret";
    console.error(`Webhook con firma invalida (${signature.reason}) - modo ${enforcing ? "rechazo" : "registro"}`);
    // "sin-app-secret" es una falla de configuracion nuestra, no una entrega falsa: rechazar por eso
    // dejaria al bot mudo para todos los clientes por un .env incompleto.
    if (enforcing) {
      res.sendStatus(401);
      return;
    }
  }

  res.sendStatus(200);
  const webhookReceivedAt = Date.now();

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const incomingPhoneNumberId: string | undefined = value?.metadata?.phone_number_id;

    // Meta sends delivery receipts (sent/delivered/read/failed) as `statuses`, not `messages` - these
    // were previously silently dropped, so a media message that Meta accepted but failed to actually
    // deliver (can't fetch the URL, unsupported format, etc.) left zero trace anywhere in our logs.
    const status = value?.statuses?.[0];
    if (status && !message) {
      if (status.status === "failed") {
        // Fase 8, punto 9: el telefono del cliente va enmascarado. El numero completo sigue quedando
        // en DeliveryFailure.recipientPhone, que es donde tiene que estar: el panel lo necesita para
        // decir a quien no le llego el mensaje, y esa tabla tiene control de acceso; el registro no.
        console.error("WhatsApp delivery FAILED:", JSON.stringify({ id: status.id, recipient: maskPhone(status.recipient_id), errors: status.errors }));
        // Meta reports this asynchronously, after the original send call already returned a wamid that
        // looked successful - previously this only reached a pm2 log nobody watches. Persist it so the
        // admin panel can surface it live instead (see src/delivery/failures.ts).
        const failedForBusiness = incomingPhoneNumberId
          ? await prisma.business.findUnique({ where: { whatsappPhoneNumberId: incomingPhoneNumberId } })
          : null;
        if (failedForBusiness) {
          const recipient: string = status.recipient_id ?? "";
          const onlyDigits = (phone: string) => phone.replace(/\D/g, "");
          const critical = Boolean(failedForBusiness.contactPhone) && onlyDigits(recipient) === onlyDigits(failedForBusiness.contactPhone!);
          const firstError = status.errors?.[0];
          await recordDeliveryFailure(failedForBusiness.id, {
            wamid: status.id ?? "",
            recipientPhone: recipient,
            errorCode: firstError?.code ?? null,
            errorMessage: firstError?.title ? `${firstError.title}: ${firstError?.error_data?.details ?? firstError.message ?? ""}` : "Error desconocido",
            critical,
          });
        }
      } else {
        console.log("WhatsApp status:", status.status, status.id, maskPhone(status.recipient_id));
        if (status.id) {
          try {
            await recordMessageDeliveryStatus(status.id, status.status);
          } catch (error) {
            console.error("No se pudo persistir el estado de entrega:", error);
          }
        }
      }
      return;
    }

    if (!message || !incomingPhoneNumberId) return;
    // "reaction" (emoji reacting to a prior message) is intentionally excluded - replying to a 👍 with
    // bot chatter is noise, not a real customer turn. Every other content type below used to fall
    // through this same filter and get silently dropped with zero trace (no reply, nothing recorded) -
    // a customer sharing a location (delivery address), sticker, document (receipt as PDF), or contact
    // card just got no response at all.
    const SUPPORTED_MESSAGE_TYPES = new Set(["text", "image", "video", "audio", "interactive", "location", "sticker", "document", "contacts"]);
    if (!SUPPORTED_MESSAGE_TYPES.has(message.type)) return;

    const business = await prisma.business.findUnique({
      where: { whatsappPhoneNumberId: incomingPhoneNumberId },
    });

    if (!business || !business.whatsappAccessToken || !business.active) {
      console.log("Mensaje recibido para un numero sin negocio asignado:", incomingPhoneNumberId);
      return;
    }

    const credentials: WhatsappCredentials = {
      phoneNumberId: business.whatsappPhoneNumberId!,
      accessToken: business.whatsappAccessToken,
    };

    const from: string | undefined = message.from ?? message.from_user_id;
    const whatsappMessageId: string | undefined = message.id;

    if (!from) {
      // Fase 8, punto 9: antes se volcaba el mensaje entero, que ademas del telefono lleva el texto
      // que escribio el cliente. Para diagnosticar este caso alcanza con saber que tipo de mensaje
      // era y su id.
      console.log("Mensaje sin remitente (from) valido, ignorado:", JSON.stringify({ type: message.type, id: message.id }));
      return;
    }

    const onlyDigits = (phone: string) => phone.replace(/\D/g, "");
    if (business.contactPhone && onlyDigits(from) === onlyDigits(business.contactPhone)) {
      const ownerIncomingBody =
        message.type === "interactive"
          ? (message.interactive?.button_reply?.title ?? message.interactive?.button_reply?.id ?? `[${message.type}]`)
          : message.type === "text"
            ? (message.text?.body ?? "")
            : `[${message.type}]`;
      await recordOwnerMessage(business.id, { direction: "IN", body: ownerIncomingBody });
      await handleOwnerReply(business.id, credentials, from, message);
      return;
    }

    if (message.type === "interactive") {
      const buttonId: string | undefined = message.interactive?.button_reply?.id;
      if (buttonId?.startsWith("csat_")) {
        const result = await recordCsatReply(business.id, from, buttonId);
        if (result.recorded && result.conversationId) {
          await sendToCustomer({
            businessId: business.id,
            conversationId: result.conversationId,
            credentials,
            to: from,
            content: { kind: "text", text: "¡Gracias por tu opinión! 🙏" },
            // El cliente acaba de tocar el boton, la ventana esta abierta por definicion.
            onWindowClosed: "fail",
          });
        }
      }
      return;
    }

    // Meta manda en cada webhook el nombre que la persona puso en SU perfil de WhatsApp. Hasta ahora se
    // descartaba, asi que la bandeja mostraba numeros crudos y el bot tenia que gastar un turno
    // preguntando como se llama alguien que ya nos lo estaba diciendo. Solo alimenta la vista del panel:
    // NO entra al prompt del bot (esa decision sigue parqueada, ver la nota de consentimiento).
    const whatsappProfileName: string | undefined = value?.contacts?.[0]?.profile?.name;
    const customer = await getOrCreateCustomer(business.id, from, whatsappProfileName);
    const conversation = await getOrCreateOpenConversation(business.id, customer.id);

    // Fase 10 del plan maestro: apenas se sabe que es un mensaje real de este cliente, se marca
    // como leido y se prende el indicador de "escribiendo" - no hace falta esperar a procesar el
    // mensaje entero (puede tardar segundos si es una foto/audio). No es critico: si falla, el
    // turno sigue igual (ver markCustomerMessageSeen en outbound.ts).
    if (whatsappMessageId) {
      await markCustomerMessageSeen(credentials, whatsappMessageId);
    }

    await withConversationLock(conversation.id, async () => {

      let text = "";
      let media: { s3Key: string; type: "IMAGE" | "VIDEO" | "AUDIO" } | undefined;
      let imageAnalysis: string | undefined;

      if (message.type === "text") {
        text = message.text.body;
      } else if (message.type === "image") {
        try {
          const { buffer, mimeType } = await downloadMedia(credentials, message.image.id);
          const { key, url } = await uploadMedia(buffer, mimeType, "receipts");
          media = { s3Key: key, type: "IMAGE" };
          text = message.image.caption ?? "";
          const catalogHint = await getCatalogHintText(business.id);
          imageAnalysis = await analyzeCustomerImage(business.id, conversation.id, url, text, catalogHint);
        } catch (error) {
          console.error("No se pudo procesar la imagen entrante:", error);
          text = "[El cliente envio una imagen, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie.]";
        }
      } else if (message.type === "video") {
        try {
          const { buffer, mimeType } = await downloadMedia(credentials, message.video.id);
          const { key } = await uploadMedia(buffer, mimeType, "videos");
          media = { s3Key: key, type: "VIDEO" };
          text = message.video.caption ?? "";
          const frame = await extractFrame(buffer);
          const { url: frameUrl } = await uploadMedia(frame, "image/jpeg", "receipts");
          const catalogHint = await getCatalogHintText(business.id);
          imageAnalysis = await analyzeCustomerImage(business.id, conversation.id, frameUrl, text, catalogHint);
        } catch (error) {
          console.error("No se pudo procesar el video entrante:", error);
          text = "[El cliente envio un video, pero hubo un problema tecnico y no se pudo analizar. Pedile que mande una foto del producto en vez de video.]";
        }
      } else if (message.type === "audio") {
        try {
          const { buffer, mimeType } = await downloadMedia(credentials, message.audio.id);
          const { key } = await uploadMedia(buffer, mimeType, "audio");
          media = { s3Key: key, type: "AUDIO" };
          const transcript = await transcribeAudio(buffer, mimeType);
          text = transcript || "[El cliente envio una nota de voz, pero no se pudo transcribir. Pedile que la repita por texto.]";
        } catch (error) {
          console.error("No se pudo procesar el audio entrante:", error);
          text = "[El cliente envio una nota de voz, pero hubo un problema tecnico y no se pudo procesar. Pedile que la reenvie o escriba el mensaje.]";
        }
      } else if (message.type === "location") {
        const loc = message.location ?? {};
        const parts = [loc.name, loc.address].filter(Boolean).join(", ");
        // Un pin arrastrado en el mapa (el caso mas comun) llega SOLO con lat/lng, sin name ni address -
        // y dos numeros crudos en el panel no le sirven a nadie para despachar. Real 2026-09-15: un
        // cliente mando su ubicacion para el envio y en la bandeja se veia "(lat 4.68, lng -74.15)", que
        // la duena no podia abrir. El link de mapa es clickeable desde el panel y desde WhatsApp.
        const hasCoords = loc.latitude != null && loc.longitude != null;
        const coords = hasCoords ? `lat ${loc.latitude}, lng ${loc.longitude}` : "";
        const mapLink = hasCoords ? ` Ver en el mapa: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}` : "";
        text = `[El cliente comparte su ubicacion por WhatsApp${parts ? `: ${parts}` : ""}${coords ? ` (${coords})` : ""}.${mapLink} Si es para la direccion de envio, confirmale la direccion exacta en texto (barrio/calle/numero) antes de cerrar el pedido - una ubicacion de mapa sola no siempre alcanza para el mensajero.]`;
      } else if (message.type === "sticker") {
        text = "[El cliente envio un sticker, sin texto.]";
      } else if (message.type === "document") {
        const filename = message.document?.filename ?? "sin nombre";
        text = `[El cliente envio un documento/archivo (${filename}), no una foto. Si esperabas un comprobante de pago, pedile que lo reenvie como foto/imagen para poder revisarlo.]`;
      } else if (message.type === "contacts") {
        // Real perdida de datos (2026-09-15): esto guardaba solo la frase fija y TIRABA la tarjeta
        // entera. Un cliente compartio el contacto de la persona que recibe el pedido y ni el nombre ni
        // el telefono quedaron en ningun lado - ni base, ni logs (el payload crudo no se registra), asi
        // que la duena tuvo que abrir WhatsApp a mano para poder despachar.
        //
        // OJO: `message.contacts` (la tarjeta que comparte el cliente) NO es `value.contacts` (el perfil
        // de quien escribe, que se lee mas arriba para whatsappProfileName). Se llaman igual y guardan
        // cosas distintas: confundirlos guardaria el nombre del remitente en vez del destinatario.
        const cards: any[] = Array.isArray(message.contacts) ? message.contacts : [];
        const described = cards
          .map((card) => {
            const nombre = card?.name?.formatted_name || [card?.name?.first_name, card?.name?.last_name].filter(Boolean).join(" ");
            const telefonos = (Array.isArray(card?.phones) ? card.phones : [])
              .map((t: any) => t?.phone || t?.wa_id)
              .filter(Boolean);
            return [nombre, telefonos.length > 0 ? telefonos.join(" / ") : null].filter(Boolean).join(" - ");
          })
          .filter((d) => d.length > 0);
        text =
          described.length > 0
            ? `[El cliente compartio ${described.length === 1 ? "esta tarjeta de contacto" : "estas tarjetas de contacto"}: ${described.join(" | ")}. Si es para el envio, esta es la persona que RECIBE el pedido - no es el nombre del cliente con el que estas hablando. Confirmale a quien te escribe si el pedido va a nombre de ese contacto antes de cerrarlo.]`
            : "[El cliente compartio una tarjeta de contacto de WhatsApp, pero llego sin nombre ni telefono legibles. Pedile que te escriba el nombre y el numero por texto.]";
      }

      // If the customer replied/quoted a specific WhatsApp message (long-press "Reply"), and that message
      // was a product photo/video we sent, tell the model directly which product it was - otherwise it has
      // to guess or ask "¿cual de los dos?" since WhatsApp doesn't show us the quoted image, only its id.
      // Keep the raw customer text separate from the marker-prefixed version: the marker itself contains
      // the words "foto"/"video" and the product's full name, which would otherwise false-trigger the
      // photo-resend safety net in generateReply (it would think the customer just asked for that photo).
      const rawText = text;
      const quotedMessageId: string | undefined = message.context?.id;
      if (quotedMessageId) {
        const relatedProductName = await getRelatedProductNameForMessage(quotedMessageId);
        if (relatedProductName) {
          text = `[El cliente esta respondiendo a la foto/video de: ${relatedProductName}] ${text}`;
        }
      }

      try {
        await recordMessage(business.id, conversation.id, "CUSTOMER", text, whatsappMessageId, media, imageAnalysis);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          console.log("Mensaje duplicado de WhatsApp ignorado:", whatsappMessageId);
          return;
        }
        throw error;
      }

      // Todo lo que el equipo dejo pendiente cuando la ventana de 24h estaba cerrada se entrega ACA: este
      // mensaje entrante es lo que la reabre. Va antes del gate de control humano a proposito - lo que hay
      // en cola lo escribio un humano, no depende de quien tenga el control ahora.
      await drainQueuedOutboundForCustomer(business.id, customer.id, credentials, from);

      // Releer el estado en vez de confiar en el objeto `conversation` leido arriba: entre esa lectura y
      // este punto corren la descarga del media, la vision y la transcripcion, que tardan segundos o
      // decenas de segundos. Si la duena toco "Tomar control" o contesto desde el panel en ese rato, el
      // valor viejo decia false y el bot respondia igual, encima de ella. Caso real 2026-09-14.
      const gate = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { humanControl: true, humanControlAckSent: true },
      });

      if (gate?.humanControl) {
        console.log("Conversacion en control humano, el bot no responde:", conversation.id);

        // El bot no CONTESTA bajo control humano, pero eso no significa que el sistema deba ignorar lo
        // que el cliente escribe. Real (2026-09-15): mientras la duena atendia a mano, un cliente dio el
        // nombre de quien recibe, su celular y la direccion; los tres quedaron solo como prosa en el chat
        // y la ficha siguio vacia, asi que el despacho salio sin datos estructurados. Capturar es callado
        // y no le manda nada al cliente, asi que no pisa a la persona que esta atendiendo.
        try {
          // Fase 11: la forma de un documento, un telefono y una direccion depende del pais del negocio.
          const { countryCode } = toBusinessLocale(business);
          const found = extractDeliveryDataFromAnswer(rawText, countryCode);
          const direccion = extractAddressFromAnswer(rawText, countryCode) ?? undefined;
          if (found.idNumber || found.deliveryPhone || direccion) {
            await saveCustomerContactInfo(business.id, customer.id, { ...found, address: direccion });
          }
        } catch (error) {
          console.error("No se pudieron capturar los datos de entrega bajo control humano:", error);
        }
        // Silence with zero acknowledgment reads as the bot being broken to the customer, and the owner
        // ends up having to jump in just to say "we got your message". Send one heads-up per pause period,
        // gated on a dedicated flag (not "does the last ASSISTANT message match the ack text") - the owner's
        // own manual replies are also recorded with role ASSISTANT, so comparing against the last ASSISTANT
        // message re-fired the ack after every manual reply that wasn't itself the ack. Stay quiet until the
        // owner/admin actually resumes it, which resets the flag.
        const HUMAN_CONTROL_ACK = "Ya te leimos, en un momento te contesta el equipo directamente 🙏";
        // Segunda condicion, ademas del flag: si de este lado se dijo algo hace muy poco, el humano esta
        // presente (o el bot acaba de avisar que escala) y el acuse solo agrega ruido encima de un mensaje
        // que el cliente ya vio. El flag solo se limpia en una transicion real a control humano
        // (ver setHumanControl), esto cubre ademas la ventana en que la duena esta tipeando ahora mismo.
        const recentlySpoken = await prisma.message.findFirst({
          where: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            createdAt: { gte: new Date(Date.now() - ACK_QUIET_MINUTES * 60 * 1000) },
          },
          select: { id: true },
        });
        if (!gate.humanControlAckSent && !recentlySpoken) {
          const ack = await sendToCustomer({
            businessId: business.id,
            conversationId: conversation.id,
            credentials,
            to: from,
            content: { kind: "text", text: HUMAN_CONTROL_ACK },
            onWindowClosed: "fail",
            recordAs: { text: HUMAN_CONTROL_ACK },
          });
          if (ack.delivered) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { humanControlAckSent: true },
            });
          } else {
            console.error("No se pudo mandar el acuse de recibo durante control humano:", ack.failure?.message);
          }
        }
        return;
      }

      // An image/video message is very likely a payment receipt (or product photo mid-close) for a
      // purchase already in progress - cutting the customer off here mid-close is worse than letting
      // one extra message through, so the cap only gates plain text/audio turns.
      const capStatus =
        message.type === "image" || message.type === "video"
          ? { capped: false as const, justCrossed: false, messageCap: null, planTier: business.planTier }
          : await checkPlanCap(business.id);
      if (capStatus.capped) {
        const capText =
          "Por ahora alcanzamos el límite de mensajes de este mes para este negocio. Un asesor te va a contactar en breve para ayudarte manualmente. ¡Gracias por tu paciencia! 🙏";
        await sendToCustomer({
          businessId: business.id,
          conversationId: conversation.id,
          credentials,
          to: from,
          content: { kind: "text", text: capText },
          onWindowClosed: "fail",
          recordAs: { text: capText },
        });

        if (capStatus.justCrossed && business.contactPhone) {
          const greeting = business.contactName ? `Hola ${business.contactName}` : "Hola";
          const capAlertText = `${greeting}, tu negocio alcanzó el límite de ${capStatus.messageCap} mensajes de tu plan ${capStatus.planTier} este mes. El bot dejó de responder automáticamente hasta el próximo mes - escribime si querés subir de plan.`;
          await alertOwnerTracked(business.id, credentials, business.contactPhone!, capAlertText);
        }
        return;
      }

      // Cuando el CLIENTE mando el mensaje, no cuando nosotros terminamos de procesarlo: la descarga del
      // media y la vision ya se comieron parte del reloj antes de llegar aca. Meta manda su timestamp en
      // segundos; si viene raro, se cae a la hora en que entro el webhook.
      const metaTimestampMs = Number(message.timestamp) * 1000;
      const customerSentAt = Number.isFinite(metaTimestampMs) && metaTimestampMs > 0 ? metaTimestampMs : webhookReceivedAt;

      // Fase 10 del plan maestro: no se llama a generateReply directamente aca. Se agrupa con
      // cualquier otro mensaje que este mismo cliente mande en los proximos ~8s (replyBurstBuffer,
      // definido arriba) y recien entonces se genera y manda UNA sola respuesta para toda la
      // rafaga - ver runGenerateAndSend. Esto libera el lock de este mensaje puntual de inmediato
      // en vez de tenerlo abierto esperando a que se genere una respuesta.
      replyBurstBuffer.add(conversation.id, {
        rawText,
        customerSentAt,
        business,
        customer,
        credentials,
        from,
      });
    });
  } catch (error) {
    console.error("Error handling WhatsApp webhook:", error);
  }
});
