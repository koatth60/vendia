import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { touchCustomerLastContact } from "../crm/customers";
import { getPresignedMediaUrl } from "../media/s3";
import { emitNewMessage, emitNewConversation, emitConversationUpdated, type ConversationRow, type CustomerRow } from "../realtime/events";
import { clearBlockedByIfNoPendingQuestions } from "../orders/saleState";
import { getBusinessLocale } from "../config/businessConfig";

// WhatsApp only allows free-form text/media within 24h of the customer's last message (Meta's
// "customer service window") - past that, only an approved template gets through (error 131047
// otherwise). This is the one place that threshold is defined; everything that needs to know whether a
// conversation can still take a plain message goes through getWindowState below instead of
// re-deriving its own 24h constant.
export const WHATSAPP_WINDOW_HOURS = 24;

export interface WindowState {
  windowOpen: boolean;
  hoursSinceLastCustomerMessage: number | null;
}

// Real incident (2026-09-14): the admin panel composer and the escalation-reminder job both sent
// free-form text 30+ hours after the customer's last message. WhatsApp accepted both (returned a real
// wamid) and only reported the failure later via the async status webhook (error 131047) - so the
// owner saw what looked like two sent messages, and the customer got neither. Checking the window
// BEFORE attempting to send is the only way to catch this ahead of time instead of after the fact.
export async function getWindowState(conversationId: string): Promise<WindowState> {
  const last = await prisma.message.findFirst({
    where: { conversationId, role: "CUSTOMER" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return { windowOpen: false, hoursSinceLastCustomerMessage: null };
  const hoursSinceLastCustomerMessage = (Date.now() - last.createdAt.getTime()) / (60 * 60 * 1000);
  return { windowOpen: hoursSinceLastCustomerMessage <= WHATSAPP_WINDOW_HOURS, hoursSinceLastCustomerMessage };
}

// Cola de salida para la ventana cerrada (ver QueuedOutboundMessage en schema.prisma). Antes, cuando la
// ventana de 24h ya estaba cerrada, el texto real que el equipo queria mandar se descartaba: se mandaba
// una plantilla generica y listo. Aca queda guardado y flushQueuedOutbound lo entrega en cuanto el
// cliente vuelve a escribir, que es exactamente el instante en que WhatsApp reabre la ventana.
export async function queueOutboundMessage(
  businessId: string,
  conversationId: string,
  body: string,
  origin: "PANEL" | "OWNER_ANSWER"
) {
  return prisma.queuedOutboundMessage.create({
    data: { businessId, conversationId, body, origin },
  });
}

// Fase 8, punto 3: recibe businessId y filtra por el. Antes bastaba con el id de una conversacion
// para leer lo que estaba encolado en ella, viniera de donde viniera la llamada - y el id de una
// conversacion no dice de quien es. Con el negocio en el filtro, pedir la cola de una conversacion
// ajena devuelve vacio en vez de datos de otro cliente.
export async function listQueuedOutbound(businessId: string, conversationId: string) {
  return prisma.queuedOutboundMessage.findMany({
    where: { businessId, conversationId, sentAt: null, cancelledAt: null, failedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

// El flush del webhook busca por CLIENTE, no por conversacion: si el dueno deja un mensaje en cola y la
// venta se cierra antes de que el cliente conteste, el siguiente mensaje entrante abre una conversacion
// nueva (getOrCreateOpenConversation excluye SOLD/LOST) y lo encolado quedaria huerfano para siempre.
export async function listQueuedOutboundForCustomer(businessId: string, customerId: string) {
  return prisma.queuedOutboundMessage.findMany({
    where: { businessId, sentAt: null, cancelledAt: null, failedAt: null, conversation: { customerId } },
    orderBy: { createdAt: "asc" },
  });
}

export async function cancelQueuedOutbound(businessId: string, id: string) {
  const { count } = await prisma.queuedOutboundMessage.updateMany({
    where: { id, businessId, sentAt: null, cancelledAt: null, failedAt: null },
    data: { cancelledAt: new Date() },
  });
  return count > 0;
}

export async function markQueuedOutboundSent(id: string) {
  await prisma.queuedOutboundMessage.update({ where: { id }, data: { sentAt: new Date() } });
}

// Cuantas conversaciones de este negocio tienen algo esperando a que el cliente vuelva a escribir -
// alimenta el contador de "Salud del bot" para que esto no sea otra cosa que solo se ve entrando chat
// por chat.
export async function countConversationsWithQueuedOutbound(businessId: string): Promise<number> {
  const rows = await prisma.queuedOutboundMessage.findMany({
    where: { businessId, sentAt: null, cancelledAt: null, failedAt: null },
    select: { conversationId: true },
    distinct: ["conversationId"],
  });
  return rows.length;
}

// Cross-references each message against DeliveryFailure by wamid so the thread can show "no llegó"
// instead of a normal-looking bubble the customer never actually saw - a message can get a real wamid
// (WhatsApp accepted it) and still fail minutes or hours later via the async status webhook, so a
// present whatsappMessageId is not proof of delivery.
async function attachDeliveryFailures<T extends { whatsappMessageId: string | null }>(
  businessId: string,
  messages: T[]
): Promise<(T & { deliveryFailed: boolean; deliveryError: string | null })[]> {
  const wamids = messages.map((m) => m.whatsappMessageId).filter((w): w is string => Boolean(w));
  const failures = wamids.length
    ? await prisma.deliveryFailure.findMany({ where: { businessId, wamid: { in: wamids } } })
    : [];
  const failureByWamid = new Map(failures.map((f) => [f.wamid, f]));
  return messages.map((m) => {
    const failure = m.whatsappMessageId ? failureByWamid.get(m.whatsappMessageId) : undefined;
    return { ...m, deliveryFailed: Boolean(failure), deliveryError: failure?.errorMessage ?? null };
  });
}

// El nombre para MOSTRAR. Precedencia deliberada: primero el autoritativo (lo dijo la clienta o lo
// escribio el dueno), despues el de su perfil de WhatsApp, y el numero solo si no hay ninguno. Vive
// aca y no en el front para que todas las vistas digan lo mismo sin repetir la cadena en cada lugar.
export function customerDisplayName(customer: {
  name: string | null;
  whatsappProfileName: string | null;
  phoneNumber: string;
}): string {
  return customer.name || customer.whatsappProfileName || customer.phoneNumber;
}

export async function getOrCreateCustomer(businessId: string, phoneNumber: string, whatsappProfileName?: string | null) {
  // El nombre de perfil se refresca en CADA mensaje: la persona lo puede cambiar cuando quiera y el
  // valor viejo no sirve. Nunca toca `name` - ese solo lo cambia una persona a proposito.
  const profile = whatsappProfileName?.trim() || undefined;
  return prisma.customer.upsert({
    where: { businessId_phoneNumber: { businessId, phoneNumber } },
    update: profile ? { whatsappProfileName: profile } : {},
    create: { businessId, phoneNumber, whatsappProfileName: profile ?? null },
  });
}

export async function getOrCreateOpenConversation(businessId: string, customerId: string) {
  const existing = await prisma.conversation.findFirst({
    where: {
      customerId,
      status: { notIn: ["SOLD", "LOST"] },
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    // Fase 9 del plan maestro (2026-09-15): ABANDONED no es un rechazo como LOST, es solo que el cliente
    // dejo de escribir - si vuelve, seguimos usando ESTA conversacion (no una nueva) para no perder el
    // SaleState/carrito que ya tenia armado. El status vuelve a NEW: mostrarla todavia como "Abandonada"
    // en el panel mientras el cliente esta escribiendo de nuevo mentiria. cartRecoverySentAt se limpia
    // para que un abandono posterior pueda volver a mandar la plantilla de recuperacion.
    if (existing.status === "ABANDONED") {
      const reopened = await prisma.conversation.update({
        where: { id: existing.id },
        data: { status: "NEW", cartRecoverySentAt: null },
      });
      return reopened;
    }
    return existing;
  }

  const conversation = await prisma.conversation.create({
    data: { customerId, status: "NEW", contextSummary: await summarizePreviousPurchase(businessId, customerId) },
    include: { customer: true },
  });
  emitNewConversation(businessId, formatConversationRow(conversation));
  return conversation;
}

// Real (2026-09-15): una clienta cerro su compra y minutos despues escribio "Vale gracias". Como su
// conversacion ya estaba en SOLD, eso abrio una conversacion NUEVA y vacia, donde el bot no tenia idea de
// que acababa de comprar - le respondio "¿hay algo más en lo que te pueda ayudar?" como si no se
// conocieran. El panel ya agrupa las conversaciones por cliente; lo que faltaba era que el BOT tambien
// supiera. Se siembra el resumen de contexto con lo minimo para no arrancar de cero: que compro y cuando.
// Una sola frase y solo de lo reciente - no es el historial completo, es el hilo que no hay que soltar.
const PREVIOUS_PURCHASE_WINDOW_DAYS = 7;

async function summarizePreviousPurchase(businessId: string, customerId: string): Promise<string | null> {
  const since = new Date(Date.now() - PREVIOUS_PURCHASE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const order = await prisma.order.findFirst({
    where: { customerId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });
  if (!order) return null;

  const productos = order.items.map((i) => `${i.quantity}x ${i.productName}`).join(", ");
  // Fase 11: la fecha se escribe en el locale y la zona horaria del negocio, no siempre en es-CO. Un
  // pedido de las 23:00 en Ciudad de Mexico no es del dia siguiente.
  const { locale, timezone } = await getBusinessLocale(businessId);
  const cuando = order.createdAt.toLocaleDateString(locale, { day: "numeric", month: "long", timeZone: timezone });
  const estado =
    order.fulfillmentStatus === "SHIPPED"
      ? "ya fue despachado"
      : order.fulfillmentStatus === "CANCELED"
        ? "quedo cancelado"
        : "todavia no ha sido despachado";
  return `Este cliente ya compro con nosotros el ${cuando}: ${productos || "un pedido"} por un total de ${order.totalAmount.toString()} ${order.currency}, y ese pedido ${estado}. No lo trates como un cliente nuevo ni le pidas de nuevo los datos que ya dio, y si escribe por ese pedido respondele sobre el.`;
}

// "Previous conversation" for the continue-or-restart prompt some businesses' own scripts ask for (e.g.
// MAGByLizN's Etapa 1.3) = this customer's most recent CLOSED (SOLD/LOST) conversation, excluding
// whichever conversation is currently open. getOrCreateOpenConversation already guarantees the open one
// is never SOLD/LOST, so the status filter alone would already exclude it - the id exclusion is a
// harmless defensive belt-and-suspenders in case that invariant ever changes, not load-bearing today.
export async function getPreviousClosedConversation(businessId: string, customerId: string, excludeConversationId: string) {
  return prisma.conversation.findFirst({
    where: {
      customerId,
      customer: { businessId },
      id: { not: excludeConversationId },
      status: { in: ["SOLD", "LOST"] },
    },
    include: { order: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function recordMessage(
  businessId: string,
  conversationId: string,
  role: "CUSTOMER" | "ASSISTANT" | "SYSTEM",
  content: string,
  whatsappMessageId?: string,
  media?: { s3Key: string; type: "IMAGE" | "VIDEO" | "AUDIO" },
  imageAnalysis?: string,
  relatedProductId?: string
) {
  const message = await prisma.message.create({
    data: {
      conversationId,
      role,
      content,
      whatsappMessageId,
      mediaS3Key: media?.s3Key,
      mediaType: media?.type,
      imageAnalysis,
      relatedProductId,
    },
  });
  // A CUSTOMER message only counts as "unread" while the bot has stopped answering
  // (humanControl:true - escalated via flag_conversation_intent/ask_owner, or the owner took over
  // manually). While the bot is handling a conversation on its own, every customer message already
  // gets an automatic reply - counting those as needing the owner's attention would make the badge
  // climb on ordinary bot-handled traffic and drown out the conversations that actually need a human.
  const touched = await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
    select: { humanControl: true, unreadCount: true, customerId: true },
  });

  // Recencia a nivel CLIENTE, para que la lista del CRM pueda ordenar y paginar por indice en vez de
  // agrupar conversaciones en memoria (ver Customer.lastContactAt en schema.prisma). Es un UPDATE por
  // id; si falla, el mensaje ya quedo guardado y enviado, asi que no se deja propagar - a lo sumo ese
  // cliente queda un mensaje desactualizado en el orden de la lista.
  try {
    await touchCustomerLastContact(touched.customerId, message.createdAt);
  } catch (error) {
    console.error("No se pudo actualizar lastContactAt del cliente:", error);
  }

  let unreadCount = touched.unreadCount;
  if (role === "CUSTOMER" && touched.humanControl) {
    const bumped = await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: { increment: 1 } },
      select: { unreadCount: true },
    });
    unreadCount = bumped.unreadCount;
  }

  emitNewMessage(
    businessId,
    conversationId,
    touched.customerId,
    {
      id: message.id,
      role: message.role,
      content: message.content,
      mediaUrl: media ? await getPresignedMediaUrl(media.s3Key) : null,
      mediaType: message.mediaType,
      createdAt: message.createdAt,
    },
    unreadCount
  );
}

// Fase 7 del plan maestro (2026-09-15): Meta manda sent/delivered/read via el webhook de `statuses`,
// matcheado por whatsappMessageId - antes se descartaba en un console.log y el panel no podia mostrar si
// un mensaje llego. El rank evita que un "sent" que llegue tarde o duplicado pise un "read" mas reciente;
// Meta no garantiza el orden de entrega de los webhooks de estado.
const DELIVERY_STATUS_RANK: Record<"SENT" | "DELIVERED" | "READ", number> = { SENT: 1, DELIVERED: 2, READ: 3 };

export async function recordMessageDeliveryStatus(whatsappMessageId: string, status: string): Promise<void> {
  const mapped = status.toUpperCase();
  if (mapped !== "SENT" && mapped !== "DELIVERED" && mapped !== "READ") return;

  const existing = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { id: true, deliveryStatus: true },
  });
  if (!existing) return;
  if (existing.deliveryStatus && DELIVERY_STATUS_RANK[existing.deliveryStatus] >= DELIVERY_STATUS_RANK[mapped]) return;

  await prisma.message.update({
    where: { id: existing.id },
    data: { deliveryStatus: mapped, deliveryStatusAt: new Date() },
  });
}

export async function getRelatedProductNameForMessage(whatsappMessageId: string): Promise<string | null> {
  const message = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { relatedProductId: true },
  });
  if (!message?.relatedProductId) return null;
  const product = await prisma.product.findUnique({
    where: { id: message.relatedProductId },
    select: { name: true },
  });
  return product?.name ?? null;
}

export async function updateConversationStatus(
  businessId: string,
  conversationId: string,
  status: "NEW" | "INTERESTED" | "QUOTED" | "NEGOTIATING" | "SOLD" | "LOST"
) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Real production bug (2026-09-13): saveCustomerName/saveCustomerContactInfo/setCustomerTags update
// Customer, not Conversation, so none of them ever emitted conversation:updated the way
// updateConversationStatus/setHumanControl/setConversationIntent do - a name saved mid-conversation never
// reached an already-open admin panel (the sidebar row and chat header kept showing the phone number
// until a full page reload). A customer can have several conversations (see the "group by customer"
// deferral) - emit one row per conversation so every open panel tab for this customer updates.
async function emitConversationRowsForCustomer(businessId: string, customerId: string): Promise<void> {
  const conversations = await prisma.conversation.findMany({
    where: { customerId },
    include: { customer: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  for (const conversation of conversations) {
    emitConversationUpdated(businessId, formatConversationRow(conversation));
  }
}

export async function saveCustomerName(businessId: string, customerId: string, name: string | null) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { name },
  });
  await emitConversationRowsForCustomer(businessId, customerId);
  return updated;
}

export async function saveCustomerContactInfo(
  businessId: string,
  customerId: string,
  // `address` se sumo el 2026-09-15: la direccion de entrega no tenia donde guardarse. Una clienta
  // mando "Cra 17 # 23-03 villa alegria" y Customer.address seguia vacio - el dato solo sobrevivia como
  // prosa dentro del resumen del pedido, donde no se puede buscar ni exportar ni usar para la guia.
  data: { idNumber?: string; deliveryPhone?: string; address?: string }
) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(data.idNumber ? { idNumber: data.idNumber } : {}),
      ...(data.deliveryPhone ? { deliveryPhone: data.deliveryPhone } : {}),
      ...(data.address ? { address: data.address } : {}),
    },
  });
  await emitConversationRowsForCustomer(businessId, customerId);
  return updated;
}

export async function setCustomerTags(businessId: string, customerId: string, tags: string[]) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { tags },
  });
  await emitConversationRowsForCustomer(businessId, customerId);
  return updated;
}

export async function setConversationIntent(
  businessId: string,
  conversationId: string,
  intent: "PQR" | "DEVOLUCION" | "NO_RECIBIDO" | "SOLICITA_AGENTE",
  // Fase 9 del plan maestro (2026-09-15): si el cliente lo pidio con sus propias palabras o si el modelo
  // lo dedujo del contexto (ver Conversation.intentExplicit) - null para el caller viejo que todavia no
  // manda este dato, para no fingir certeza que no existe.
  explicit: boolean | null = null
) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { intent, intentExplicit: explicit },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Lets the owner manually dismiss an intent badge from the admin panel once they've resolved it (a
// PQR they already handled, a return already processed, etc.) - before this, flag_conversation_intent
// was the only thing that ever touched this field, so a resolved PQR badge sat on the conversation
// until the whole sales cycle closed. Scoped by businessId via findFirst first (like setHumanControl),
// unlike setConversationIntent above which trusts a caller-supplied conversationId alone - this is a
// new admin-panel-triggered action, so it gets the safer check from the start.
export async function clearConversationIntent(businessId: string, conversationId: string) {
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
  });
  if (!existing) return null;
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { intent: null, intentExplicit: null },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

export async function setHumanControl(businessId: string, conversationId: string, active: boolean) {
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
  });
  if (!existing) return null;
  // Real incident 2026-09-14 (conversacion 573133260330): la duena estaba chateando a mano con el
  // cliente y el bot le metia "Ya te leimos, en un momento te contesta el equipo directamente" entre
  // sus propios mensajes, una y otra vez. Cada mensaje manual del panel llama a setHumanControl(true),
  // y esto limpiaba humanControlAckSent SIEMPRE - asi que una duena que estaba demostrablemente ahi,
  // respondiendo, re-armaba el aviso de "ya te contestamos" en cada turno. El acuse es uno solo por
  // PAUSA, no por mensaje: solo se reinicia en una transicion real false->true (o al devolverle el
  // control al bot, para que la proxima pausa tenga el suyo).
  //
  // El reloj del watchdog (humanControlSince/stalledReminder*) SI se re-arma en cada llamada, y eso es
  // deliberado - ver findStalledConversationsDueForReminder: mide desde el ultimo mensaje del cliente,
  // no desde aca, y necesita saber que el humano volvio a engancharse.
  const keepAck = active && existing.humanControl;
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      humanControl: active,
      humanControlAckSent: keepAck ? existing.humanControlAckSent : false,
      humanControlSince: active ? new Date() : null,
      stalledReminderStage: 0,
      stalledReminderSentAt: null,
    },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Called only when the OWNER manually takes control from the admin panel (not when the bot itself
// auto-escalates via flag_conversation_intent, which sets this same "pide agente" badge in the same
// breath - clearing it there would erase the flag the bot just set). The badge has done its job once a
// human is actually handling it; if the customer asks for an agent again later, the bot sets it right
// back via set_conversation_intent.
export async function clearAgentRequestFlag(businessId: string, conversationId: string) {
  await prisma.conversation.updateMany({
    where: { id: conversationId, customer: { businessId }, intent: "SOLICITA_AGENTE" },
    data: { intent: null },
  });
}

export async function findConversationByPendingConfirmation(pendingConfirmationMessageId: string) {
  return prisma.conversation.findUnique({
    where: { pendingConfirmationMessageId },
    include: { customer: true },
  });
}

export async function clearPendingConfirmation(conversationId: string) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingConfirmationMessageId: null, pendingOrderSummary: null, pendingOrderItems: Prisma.JsonNull },
  });
}

export async function createPendingOwnerQuestion(
  conversationId: string,
  wamid: string,
  question: string,
  kind: "TEXT" | "PHOTO_PRODUCT" = "TEXT"
) {
  await prisma.pendingOwnerQuestion.create({
    data: { conversationId, wamid, question, kind },
  });
}

export async function findConversationByPendingOwnerQuestion(wamid: string) {
  const pending = await prisma.pendingOwnerQuestion.findUnique({
    where: { wamid },
    include: { conversation: { include: { customer: true } } },
  });
  if (!pending) return null;
  return {
    questionId: pending.id,
    question: pending.question,
    kind: pending.kind,
    conversationId: pending.conversationId,
    customer: pending.conversation.customer,
  };
}

export async function clearPendingOwnerQuestion(questionId: string) {
  const pending = await prisma.pendingOwnerQuestion.delete({ where: { id: questionId } });
  await clearBlockedByIfNoPendingQuestions(pending.conversationId);
}

// Marcar resuelta a mano desde el panel (Bot > Salud), para el caso que clearPendingOwnerQuestion
// no cubre: el dueño ya resolvió la pregunta por fuera del panel (por telefono, en persona) y solo
// quiere sacarla de la lista, sin tener que escribirle algo al cliente para que se limpie sola.
// Scoped por businessId - a diferencia de clearPendingOwnerQuestion (uso interno, ya confia en el
// llamador), este lo expone un endpoint HTTP y necesita el chequeo de que la pregunta es de este
// negocio antes de borrarla.
export async function resolvePendingOwnerQuestion(businessId: string, questionId: string): Promise<boolean> {
  const pending = await prisma.pendingOwnerQuestion.findFirst({
    where: { id: questionId, conversation: { customer: { businessId } } },
    select: { id: true, conversationId: true },
  });
  if (!pending) return false;
  await prisma.pendingOwnerQuestion.delete({ where: { id: pending.id } });
  await clearBlockedByIfNoPendingQuestions(pending.conversationId);
  return true;
}

// Only the WhatsApp-reply path (quoting the alert, or the single-pending fallback) ever cleared a
// PendingOwnerQuestion - an owner who instead resolves it by typing directly into the admin panel's
// conversation view left the row open indefinitely, remindedAt still null. Harmless while the reminder
// job's own bug meant it almost never fired (see findPendingOwnerQuestionsDueForReminder) - once that got
// fixed (2026-09-12) this orphaned row was exactly what let a real, already-resolved conversation get a
// confusing "seguimos revisando" follow-up hours later. Called wherever the owner addresses a conversation
// through the admin panel instead of WhatsApp.
export async function clearPendingOwnerQuestionsForConversation(conversationId: string) {
  await prisma.pendingOwnerQuestion.deleteMany({ where: { conversationId } });
  await clearBlockedByIfNoPendingQuestions(conversationId);
}

// Used when the owner replies WITHOUT quoting a specific message (common on mobile, where long-pressing
// to reply is easy to skip) - lets the webhook auto-resolve the reply only when there's exactly one
// thing open for that business, instead of always demanding a quote even when there's nothing to
// disambiguate.
export async function findOpenPendingOwnerQuestionsForBusiness(businessId: string) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: { conversation: { customer: { businessId } } },
    include: { conversation: { include: { customer: true } } },
    orderBy: { createdAt: "desc" },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

// Correccion Fase 4 del plan maestro (2026-09-15): la pregunta REAL, no solo el marcador blockedBy -
// generateReply (agent.ts) la usa para decirle al modelo que ya la escaló en vez de dejarlo prometer
// de nuevo, y runCatalogTool (ask_owner en tools.ts) la usa para negarse a abrir una segunda mientras
// esta siga sin respuesta.
export async function findOpenPendingOwnerQuestionsForConversation(conversationId: string) {
  return prisma.pendingOwnerQuestion.findMany({
    where: { conversationId },
    select: { question: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function findOpenPendingConfirmationsForBusiness(businessId: string) {
  return prisma.conversation.findMany({
    where: { customer: { businessId }, pendingConfirmationMessageId: { not: null } },
    include: { customer: true },
    orderBy: { updatedAt: "desc" },
  });
}

// Correccion Fase 4 del plan maestro (2026-09-15), causa raiz C2: blockedBy no tenia salida si el
// dueno nunca respondia - la conversacion quedaba muda para siempre. jobs/escalationReminder.ts usa
// esto para encontrar, por negocio, las preguntas que ya superaron Business.ownerQuestionTimeoutHours
// (a diferencia de findPendingOwnerQuestionsDueForReminder, no filtra por remindedAt: un recordatorio
// ya mandado no evita el timeout).
export async function findPendingOwnerQuestionsPastTimeout(businessId: string, olderThan: Date) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: {
      conversation: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
      createdAt: { lte: olderThan },
    },
    include: { conversation: { include: { customer: true } } },
    orderBy: { createdAt: "asc" },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

// Escalations the owner never answered - one reminder per question (remindedAt gates it so the
// reminder job doesn't re-send every tick), independent of the sale follow-up job above.
export async function findPendingOwnerQuestionsDueForReminder(businessId: string, olderThan: Date) {
  const pending = await prisma.pendingOwnerQuestion.findMany({
    where: {
      // Must still be an open conversation - a real orphaned row from a 2026-09-11 migration backfill
      // (see that migration's SQL) triggered a false reminder in production for a conversation that had
      // already closed a sale hours earlier, reminding about a question that isn't actually blocking
      // anything anymore. This used to be gated on humanControl:true instead, but that's wrong for the
      // majority of pending questions: plain ask_owner deliberately leaves humanControl false (the bot
      // keeps chatting about everything else while that one question is escalated, see tools.ts), so the
      // humanControl gate silently excluded almost every ask_owner reminder and only ever fired for
      // ask_owner_about_photo (the one case that does set humanControl). status is the real "still open"
      // signal regardless of which escalation path set it.
      conversation: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
      remindedAt: null,
      createdAt: { lte: olderThan },
    },
    include: { conversation: { include: { customer: true } } },
  });
  return pending.map((p) => ({
    questionId: p.id,
    question: p.question,
    kind: p.kind,
    conversationId: p.conversationId,
    customer: p.conversation.customer,
  }));
}

export async function markPendingOwnerQuestionReminded(questionId: string) {
  await prisma.pendingOwnerQuestion.update({
    where: { id: questionId },
    data: { remindedAt: new Date() },
  });
}

// Lives here, not next to the job that sends it, because the stalled-conversation query below has to be
// able to tell it apart from a real reply: it's an ASSISTANT message like any other, but it answers
// nothing, so it must not count as "the business already responded".
export const CUSTOMER_FOLLOWUP_TEXT = "Seguimos revisando tu consulta con el equipo, en un momento te confirmamos por aqui 🙏";

export type StalledConversation = {
  conversationId: string;
  customer: { id: string; name: string | null; whatsappProfileName: string | null; phoneNumber: string };
  intent: string | null;
  // Fase 9: null para conversaciones estancadas por PendingOwnerQuestion (no aplica) o por una fila
  // anterior a esta fase (nunca se le pregunto al modelo) - ver Conversation.intentExplicit.
  intentExplicit: boolean | null;
  nextStage: 1 | 2;
  openQuestion: string | null;
};

// Generalizes escalation reminders beyond ask_owner/ask_owner_about_photo (the only two paths that create
// a PendingOwnerQuestion): flag_conversation_intent and a manual panel takeover both set humanControl:true
// with no question row at all, so findPendingOwnerQuestionsDueForReminder above never sees them - a
// conversation escalated that way could go silent forever with nobody reminded. This watches the last
// message instead (the customer must be the one waiting - see the loop below), and stages the escalation
// (fires once at stage1Before, once more at stage2Before, then caps) so a still-unanswered conversation
// gets progressively louder instead of exactly one reminder for its entire life.
//
// A conversation that DOES have a PendingOwnerQuestion is deliberately left to that dedicated mechanism for
// its first reminder (same 3h-class threshold, already reminds with the actual question text) - only
// picked up here for the second/final nudge at stage2Before, so the two mechanisms never both fire for the
// same conversation in the same run.
export async function findStalledConversationsDueForReminder(
  businessId: string,
  stage1Before: Date,
  stage2Before: Date
): Promise<StalledConversation[]> {
  const candidates = await prisma.conversation.findMany({
    where: {
      customer: { businessId },
      humanControl: true,
      status: { notIn: ["SOLD", "LOST", "ABANDONED"] },
      humanControlSince: { not: null },
      OR: [{ stalledReminderStage: 0 }, { stalledReminderStage: 1, stalledReminderSentAt: { lte: stage1Before } }],
    },
    // 5 is enough to walk back past our own follow-ups (deduped to one per conversation per run) to the
    // last thing that was actually said.
    include: { customer: true, pendingOwnerQuestions: true, messages: { orderBy: { createdAt: "desc" }, take: 5 } },
  });

  const result: StalledConversation[] = [];
  for (const c of candidates) {
    // Nobody is waiting on the business unless the CUSTOMER spoke last, and the wait starts at that
    // message - not at humanControlSince. Real incident 2026-09-14: the owner answered from the panel and
    // asked the customer a question back; every panel message calls setHumanControl(true), which re-armed
    // humanControlSince, so her own reply is what scheduled a "seguimos revisando" to the customer minutes
    // later - while the conversation was actually waiting on HIM.
    let waitingSince: Date | null = null;
    for (const m of c.messages) {
      if (m.role === "CUSTOMER") {
        waitingSince = m.createdAt;
        break;
      }
      // Our own nudge answers nothing, so it must not read as a reply - otherwise it would silence the
      // 24h stage-2 reminder for exactly the conversations that need it most (owner never answered, and
      // the customer has been sitting on that canned line ever since).
      if (m.role === "ASSISTANT" && m.content !== CUSTOMER_FOLLOWUP_TEXT) break;
    }
    if (!waitingSince) continue;

    const hasQuestionThisEscalation = c.pendingOwnerQuestions.some((q) => q.createdAt >= c.humanControlSince!);
    if (c.stalledReminderStage === 0) {
      if (!hasQuestionThisEscalation && waitingSince <= stage1Before) {
        result.push({ conversationId: c.id, customer: c.customer, intent: c.intent, intentExplicit: c.intentExplicit, nextStage: 1, openQuestion: null });
      } else if (waitingSince <= stage2Before) {
        const openQuestion = c.pendingOwnerQuestions.find((q) => !q.remindedAt)?.question ?? c.pendingOwnerQuestions[0]?.question ?? null;
        result.push({ conversationId: c.id, customer: c.customer, intent: c.intent, intentExplicit: c.intentExplicit, nextStage: 2, openQuestion });
      }
    } else if (c.stalledReminderStage === 1 && c.stalledReminderSentAt! <= stage2Before) {
      result.push({ conversationId: c.id, customer: c.customer, intent: c.intent, intentExplicit: c.intentExplicit, nextStage: 2, openQuestion: null });
    }
  }
  return result;
}

export async function markStalledReminderSent(conversationId: string, stage: 1 | 2) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { stalledReminderStage: stage, stalledReminderSentAt: new Date() },
  });
}

export type IntentEscalationTimeout = {
  conversationId: string;
  customer: { id: string; name: string | null; whatsappProfileName: string | null; phoneNumber: string };
  intent: string | null;
  intentExplicit: boolean | null;
};

// Fase 9 del plan maestro (2026-09-15): findStalledConversationsDueForReminder de arriba ya avisa al
// dueno dos veces (a las Business.ownerReminderMinutes y de nuevo a las 24h) cuando flag_conversation_intent
// dejo una conversacion muda esperandolo - pero si nunca responde, esa conversacion queda humanControl:true
// para siempre. Mismo patron de escape que findPendingOwnerQuestionsPastTimeout mas abajo (ask_owner): pasadas
// Business.intentEscalationTimeoutHours sin que humanControlSince se refresque (el dueno nunca respondio
// desde el panel - cada mensaje suyo lo refresca, ver setHumanControl), el bot recupera el control solo.
// `intent: { not: null }` es justamente lo que distingue este origen de una toma de control manual (esa
// deja intent en null) y de ask_owner (ese no toca intent en absoluto, usa PendingOwnerQuestion).
export async function findFlagIntentEscalationsPastTimeout(
  businessId: string,
  timeoutBefore: Date
): Promise<IntentEscalationTimeout[]> {
  const conversations = await prisma.conversation.findMany({
    where: {
      customer: { businessId },
      humanControl: true,
      intent: { not: null },
      status: { notIn: ["SOLD", "LOST", "ABANDONED"] },
      humanControlSince: { lte: timeoutBefore },
    },
    include: { customer: true },
  });
  return conversations.map((c) => ({
    conversationId: c.id,
    customer: c.customer,
    intent: c.intent,
    intentExplicit: c.intentExplicit,
  }));
}

export type AbandonedConversationCandidate = {
  id: string;
  customer: { id: string; name: string | null; whatsappProfileName: string | null; phoneNumber: string };
};

// Fase 9 del plan maestro (2026-09-15), causa raiz C1+eje 18: el 61% de las conversaciones NEW no cerraba
// nunca y no contaba como perdida - esta es la consulta que jobs/abandonment.ts usa para encontrarlas.
// Mide por el ULTIMO MENSAJE DEL CLIENTE, no por Conversation.updatedAt: ese campo lo tocan tambien los
// jobs de recordatorio (stalledReminderSentAt, etc), asi que una conversacion que el propio sistema
// sigue "tocando" nunca se veria vieja aunque el cliente lleve semanas en silencio. groupBy en vez de una
// consulta por conversacion (como getWindowState) porque esto corre sobre TODAS las conversaciones
// abiertas de un negocio, potencialmente miles en el caso que motivo esta fase.
export async function findConversationsDueForAbandonment(
  businessId: string,
  olderThan: Date
): Promise<AbandonedConversationCandidate[]> {
  const candidates = await prisma.conversation.findMany({
    where: { customer: { businessId }, status: { notIn: ["SOLD", "LOST", "ABANDONED"] } },
    select: { id: true, createdAt: true, customer: true },
  });
  if (candidates.length === 0) return [];

  const lastCustomerMessages = await prisma.message.groupBy({
    by: ["conversationId"],
    where: { conversationId: { in: candidates.map((c) => c.id) }, role: "CUSTOMER" },
    _max: { createdAt: true },
  });
  const lastByConversation = new Map(lastCustomerMessages.map((m) => [m.conversationId, m._max.createdAt!]));

  return candidates
    .filter((c) => (lastByConversation.get(c.id) ?? c.createdAt) <= olderThan)
    .map((c) => ({ id: c.id, customer: c.customer }));
}

export async function markConversationAbandoned(businessId: string, conversationId: string) {
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "ABANDONED" },
    include: { customer: true },
  });
  emitConversationUpdated(businessId, formatConversationRow(conversation));
  return conversation;
}

// Solo las que ya estan ABANDONED y con la plantilla sin mandar - deliberadamente separada de
// findConversationsDueForAbandonment de arriba (esa decide el status, esta decide el reintento del
// envio) para que un fallo de entrega (rate limit, plantilla no aprobada) se reintente en la proxima
// pasada del job sin volver a re-evaluar inactividad, igual que findConversationsDueForFollowUp.
export async function findConversationsDueForCartRecovery(businessId: string) {
  return prisma.conversation.findMany({
    where: { customer: { businessId }, status: "ABANDONED", cartRecoverySentAt: null },
    include: { customer: true },
  });
}

export async function markCartRecoverySent(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { cartRecoverySentAt: new Date() },
  });
}

export async function findConversationsDueForFollowUp(businessId: string, olderThan: Date) {
  return prisma.conversation.findMany({
    where: {
      customer: { businessId },
      status: "SOLD",
      followUpSentAt: null,
      updatedAt: { lte: olderThan },
    },
    include: { customer: true },
  });
}

export async function markFollowUpSent(conversationId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { followUpSentAt: new Date() },
  });
}

export async function wasWhatsappMessageProcessed(whatsappMessageId: string): Promise<boolean> {
  const existing = await prisma.message.findUnique({ where: { whatsappMessageId } });
  return existing !== null;
}

export async function getRecentHistory(conversationId: string, limit = 20) {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const ordered = messages.reverse();

  return Promise.all(
    ordered.map(async (m) => ({
      ...m,
      mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
    }))
  );
}

// Shared row shape for the conversations sidebar - used both by the REST list endpoint and by the
// realtime conversation:new/conversation:updated emits, so the two never drift apart.
function formatConversationRow(c: {
  id: string;
  status: string;
  intent: string | null;
  humanControl: boolean;
  updatedAt: Date;
  unreadCount: number;
  customer: { id: string; phoneNumber: string; name: string | null; whatsappProfileName: string | null; tags: string[] };
  messages?: { role: string; content: string; mediaType: string | null; createdAt: Date }[];
}): ConversationRow {
  return {
    id: c.id,
    status: c.status,
    intent: c.intent,
    humanControl: c.humanControl,
    updatedAt: c.updatedAt,
    unreadCount: c.unreadCount,
    customer: {
      id: c.customer.id,
      phoneNumber: c.customer.phoneNumber,
      name: c.customer.name,
      displayName: customerDisplayName(c.customer),
      tags: c.customer.tags,
    },
    lastMessage: formatLastMessagePreview(c.messages?.[0]),
  };
}

// Shared by formatConversationRow and formatCustomerRow so the sidebar preview text (media captions
// included) never drifts between the per-conversation and per-customer row shapes.
function formatLastMessagePreview(last?: { role: string; content: string; mediaType: string | null; createdAt: Date }) {
  if (!last) return null;
  return {
    role: last.role,
    content:
      last.mediaType === "IMAGE"
        ? last.content || "📷 Imagen"
        : last.mediaType === "VIDEO"
          ? last.content || "🎥 Video"
          : last.content,
    createdAt: last.createdAt,
  };
}

export async function listConversationsForBusiness(businessId: string) {
  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });

  return conversations.map(formatConversationRow);
}

export async function getConversationForBusiness(businessId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!conversation) return null;

  // Opening a conversation in the admin panel IS reading it - reset the unread badge here as a side
  // effect of the fetch, instead of a separate "mark as read" round trip the frontend would have to
  // remember to call. Emit so other open admin tabs/devices for this business see the badge clear too.
  if (conversation.unreadCount > 0) {
    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
      include: { customer: true },
    });
    emitConversationUpdated(businessId, formatConversationRow(updated));
    conversation.unreadCount = 0;
  }

  const windowState = await getWindowState(conversationId);
  const messagesWithMedia = await Promise.all(
    conversation.messages.map(async (m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
      mediaType: m.mediaType,
      whatsappMessageId: m.whatsappMessageId,
    }))
  );

  return {
    id: conversation.id,
    status: conversation.status,
    intent: conversation.intent,
    humanControl: conversation.humanControl,
    updatedAt: conversation.updatedAt,
    unreadCount: conversation.unreadCount,
    windowOpen: windowState.windowOpen,
    hoursSinceLastCustomerMessage: windowState.hoursSinceLastCustomerMessage,
    queuedOutbound: await listQueuedOutbound(businessId, conversationId),
    customer: {
      id: conversation.customer.id,
      phoneNumber: conversation.customer.phoneNumber,
      name: conversation.customer.name,
      displayName: customerDisplayName(conversation.customer),
      tags: conversation.customer.tags,
    },
    messages: await attachDeliveryFailures(businessId, messagesWithMedia),
  };
}

// Groups a customer's Conversation rows into one row for the admin panel's Conversaciones list (see
// [[onix-conversations-group-by-customer]]) - the data model is unchanged (still one Conversation per
// sales cycle, Order.conversationId stays @unique), this only changes what the LIST shows. `conversations`
// must already be sorted updatedAt desc and belong to a single customer - conversations[0] is then always
// that customer's most recent activity regardless of status.
function formatCustomerRow(
  conversations: {
    id: string;
    customerId: string;
    status: string;
    intent: string | null;
    humanControl: boolean;
    updatedAt: Date;
    unreadCount: number;
    customer: { id: string; phoneNumber: string; name: string | null; whatsappProfileName: string | null; tags: string[] };
    messages?: { role: string; content: string; mediaType: string | null; createdAt: Date }[];
  }[]
): CustomerRow {
  const mostRecent = conversations[0];
  const active = conversations.find((c) => c.status !== "SOLD" && c.status !== "LOST") ?? mostRecent;
  const unreadCount = conversations.reduce((sum, c) => sum + c.unreadCount, 0);
  // One Order per SOLD conversation (Order.conversationId is @unique) - counting SOLD conversations is
  // exactly counting this customer's completed orders, with no extra join.
  const orderCount = conversations.filter((c) => c.status === "SOLD").length;

  return {
    customerId: active.customerId,
    activeConversationId: active.id,
    status: active.status,
    intent: active.intent,
    humanControl: active.humanControl,
    updatedAt: mostRecent.updatedAt,
    unreadCount,
    orderCount,
    customer: {
      id: active.customer.id,
      phoneNumber: active.customer.phoneNumber,
      name: active.customer.name,
      displayName: customerDisplayName(active.customer),
      tags: active.customer.tags,
    },
    lastMessage: formatLastMessagePreview(mostRecent.messages?.[0]),
    cycles: conversations.map((c) => ({ id: c.id, status: c.status, updatedAt: c.updatedAt })),
  };
}

export async function listCustomerThreadsForBusiness(businessId: string): Promise<CustomerRow[]> {
  const conversations = await prisma.conversation.findMany({
    where: { customer: { businessId } },
    include: {
      customer: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });

  const byCustomer = new Map<string, typeof conversations>();
  for (const c of conversations) {
    const group = byCustomer.get(c.customerId);
    if (group) group.push(c);
    else byCustomer.set(c.customerId, [c]);
  }

  const rows = [...byCustomer.values()].map(formatCustomerRow);
  // Sorted explicitly rather than relying on Map insertion order matching it (it already does, since
  // `conversations` above is globally sorted desc and a customer's first appearance in that stream is
  // always their own max updatedAt) - explicit is cheap here and doesn't depend on that holding under
  // timestamp ties or future changes to the query above.
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return rows;
}

// The grouped-thread view behind a customer row: messages for ONE cycle (the active one, or an older
// one via `before`) plus lightweight metadata for every cycle so the frontend can render "Venta cerrada
// · <fecha> · <resumen>" separators between them. Deliberately doesn't load every cycle's messages up
// front - getConversationForBusiness already showed that firing a fresh presigned S3 URL for every
// piece of media adds up, and a customer with several closed sales would multiply that on every open.
export async function getCustomerThreadForBusiness(businessId: string, customerId: string, before?: string) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) return null;

  // createdAt, no updatedAt: este orden es la caminata cronológica de ciclos que hasMore/targetIndex
  // usan más abajo para decidir si queda historia más vieja por cargar. updatedAt se mueve por
  // motivos que no tienen nada que ver con "cuándo pasó esta conversación" - una venta SOLD puede
  // tocarse (nota, edición de pedido, etc.) horas después de que el ciclo siguiente ya arrancó, y
  // ahí quedaba con updatedAt más nuevo que el ciclo activo. Cuando eso corría, el ciclo activo
  // dejaba de ser el índice 0 del arreglo, "hasMore" salía false y el botón "Ver conversación
  // anterior" desaparecía aunque sí hubiera historia vieja (caso real: Milena Hernández Parra,
  // 2026-09-16). createdAt no se mueve nunca después de creado, así que el orden no se corrompe.
  const conversations = await prisma.conversation.findMany({
    where: { customerId },
    include: { order: true },
    orderBy: { createdAt: "desc" },
  });
  if (conversations.length === 0) return null;

  const cycles = conversations.map((c) => ({
    id: c.id,
    status: c.status,
    updatedAt: c.updatedAt,
    order: c.order ? { summary: c.order.summary, totalAmount: Number(c.order.totalAmount), currency: c.order.currency } : null,
  }));
  const activeConversationId =
    conversations.find((c) => c.status !== "SOLD" && c.status !== "LOST")?.id ?? conversations[0].id;
  const customerBasic = {
    id: customer.id,
    phoneNumber: customer.phoneNumber,
    name: customer.name,
    displayName: customerDisplayName(customer),
    tags: customer.tags,
  };

  let targetIndex: number;
  if (before) {
    // "Load the cycle before this one" - conversations is sorted updatedAt desc, so the next OLDER
    // cycle sits right after `before`'s own position in the array.
    const beforeIndex = conversations.findIndex((c) => c.id === before);
    targetIndex = beforeIndex === -1 ? conversations.length : beforeIndex + 1;
  } else {
    targetIndex = conversations.findIndex((c) => c.id === activeConversationId);

    // Opening the grouped thread reads every conversation of this customer at once - unlike the old
    // single-cycle view, there's no per-cycle "currently open elsewhere" concept left to protect, so
    // nothing stays half-read behind the cycle that's actually shown.
    const unreadIds = conversations.filter((c) => c.unreadCount > 0).map((c) => c.id);
    if (unreadIds.length > 0) {
      await prisma.conversation.updateMany({ where: { id: { in: unreadIds } }, data: { unreadCount: 0 } });
      await emitConversationRowsForCustomer(businessId, customerId);
    }
  }

  // The composer always sends into activeConversationId regardless of which cycle's messages are on
  // screen (loadOlderCycle only prepends older history, it never changes what "send" targets) - so the
  // window has to be checked against that conversation, not whichever `target` this call happens to be
  // returning messages for.
  const windowState = await getWindowState(activeConversationId);

  if (targetIndex >= conversations.length) {
    // `before` pointed at the oldest cycle already, or at an id this customer doesn't have (stale
    // client state) - nothing older left to show.
    return {
      customerId: customer.id,
      customer: customerBasic,
      activeConversationId,
      conversationId: null,
      status: null,
      intent: null,
      humanControl: false,
      hasMore: false,
      cycles,
      windowOpen: windowState.windowOpen,
      hoursSinceLastCustomerMessage: windowState.hoursSinceLastCustomerMessage,
      queuedOutbound: [],
      messages: [],
    };
  }

  const target = conversations[targetIndex];
  const hasMore = targetIndex + 1 < conversations.length;

  const messages = await prisma.message.findMany({
    where: { conversationId: target.id },
    orderBy: { createdAt: "asc" },
  });

  const messagesWithMedia = await Promise.all(
    messages.map(async (m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      mediaUrl: m.mediaS3Key ? await getPresignedMediaUrl(m.mediaS3Key) : null,
      mediaType: m.mediaType,
      whatsappMessageId: m.whatsappMessageId,
    }))
  );

  return {
    customerId: customer.id,
    customer: customerBasic,
    activeConversationId,
    conversationId: target.id,
    status: target.status,
    intent: target.intent,
    humanControl: target.humanControl,
    hasMore,
    cycles,
    windowOpen: windowState.windowOpen,
    hoursSinceLastCustomerMessage: windowState.hoursSinceLastCustomerMessage,
    queuedOutbound: await listQueuedOutbound(businessId, activeConversationId),
    messages: await attachDeliveryFailures(businessId, messagesWithMedia),
  };
}
